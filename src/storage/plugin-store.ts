/**
 * Almacén del plugin: UN objeto versionado en `data.json`.
 *
 * Antes cada pieza escribía su clave suelta en `data.json` y quien guardaba
 * tenía que acordarse de preservar lo de los demás. Aquí se carga entero una
 * vez, se muta en memoria y se escribe entero, con las escrituras COALESCIDAS:
 * varias mutaciones seguidas producen un solo `saveData`.
 *
 * `data.json` viaja por Obsidian Sync. Por eso el `deviceId` NO vive aquí
 * cuando hay un sitio local donde ponerlo (ver `DeviceIdStore`): si viajara,
 * dos dispositivos se creerían el mismo y enviarían las mismas operaciones.
 */

import type { LumbreTaskLink } from '../links/link-store';
import type { QueuedOperation } from '../lumbre/queue';
import { DEFAULT_SETTINGS, type LumbreSettings } from '../settings';

/** Versión del formato de `data.json`. Sube cuando la forma cambie. */
export const PLUGIN_DATA_VERSION = 1;

export interface PluginData {
	version: number;
	settings: LumbreSettings;
	/** El token personal. Solo se lee para la cabecera `Authorization`. */
	token: string | null;
	queue: QueuedOperation[];
	links: LumbreTaskLink[];
	/**
	 * Solo se usa si NO hay `DeviceIdStore` local. Con almacenamiento local
	 * disponible el id vive ahí y esta clave se queda a `null`, para que no viaje
	 * por Sync.
	 */
	deviceId: string | null;
}

/** Lo que el almacén necesita del plugin: leer y escribir su `data.json`. */
export interface PluginDataHost {
	loadData(): Promise<unknown>;
	saveData(data: unknown): Promise<void>;
}

/**
 * Sitio LOCAL del dispositivo donde guardar su id, fuera de lo que sincroniza.
 * En Obsidian lo cumple `app.loadLocalStorage` / `app.saveLocalStorage`.
 */
export interface DeviceIdStore {
	read(): string | null;
	write(id: string): void;
}

export class PluginStore {
	/** El objeto entero, ya migrado. Se muta en memoria y se guarda con `save()`. */
	data: PluginData = emptyData();

	private pendingSave: Promise<void> | null = null;
	private lastWrite: Promise<void> = Promise.resolve();

	constructor(
		private readonly host: PluginDataHost,
		private readonly deviceIdStore?: DeviceIdStore,
	) {}

	/**
	 * Lee `data.json` y lo migra si viene del formato viejo (ajustes y `token`
	 * sueltos en la raíz). Una instalación que ya existía NO pierde su token.
	 */
	async load(): Promise<PluginData> {
		const raw = await this.host.loadData();
		this.data = migrate(raw);
		this.data.deviceId = this.resolveDeviceId(this.data.deviceId);
		return this.data;
	}

	/** Id de ESTA instalación, resuelto en `load()`. */
	get deviceId(): string {
		return this.data.deviceId ?? '';
	}

	/**
	 * Escribe el objeto entero. Varias llamadas dentro del mismo turno colapsan en
	 * un solo `saveData`, y dos escrituras nunca se solapan.
	 */
	save(): Promise<void> {
		const already = this.pendingSave;
		if (already !== null) return already;

		const scheduled = (async () => {
			// Un tick de espera: es lo que hace que N mutaciones seguidas escriban una
			// sola vez. Se libera el hueco ANTES de escribir, para que una mutación
			// hecha durante la escritura programe otra.
			await Promise.resolve();
			this.pendingSave = null;
			const write = this.lastWrite.then(() => this.host.saveData(this.snapshot()));
			this.lastWrite = write.catch(() => undefined);
			await write;
		})();

		this.pendingSave = scheduled;
		return scheduled;
	}

	// ── Puertos que consumen las demás piezas ────────────────────────────────

	readQueue(): QueuedOperation[] {
		return this.data.queue;
	}

	async writeQueue(operations: QueuedOperation[]): Promise<void> {
		this.data.queue = operations;
		await this.save();
	}

	readLinks(): LumbreTaskLink[] {
		return this.data.links;
	}

	async writeLinks(links: LumbreTaskLink[]): Promise<void> {
		this.data.links = links;
		await this.save();
	}

	readToken(): string | null {
		return this.data.token;
	}

	async writeToken(token: string | null): Promise<void> {
		this.data.token = token;
		await this.save();
	}

	/**
	 * Lo que se escribe de verdad. El `deviceId` solo baja a `data.json` si no hay
	 * almacén local donde guardarlo: ver el comentario de cabecera.
	 */
	private snapshot(): PluginData {
		return {
			...this.data,
			version: PLUGIN_DATA_VERSION,
			deviceId: this.deviceIdStore !== undefined ? null : this.data.deviceId,
		};
	}

	/**
	 * Resuelve el id del dispositivo. Manda el almacén local; el de `data.json`
	 * solo se usa como respaldo cuando no hay almacén local, porque un id que
	 * viaja por Sync haría que dos dispositivos se creyeran el mismo.
	 */
	private resolveDeviceId(fromData: string | null): string {
		const local = this.deviceIdStore;
		if (local === undefined) {
			return fromData ?? crypto.randomUUID();
		}
		const stored = local.read();
		if (stored !== null && stored.length > 0) return stored;
		const created = crypto.randomUUID();
		local.write(created);
		return created;
	}
}

function emptyData(): PluginData {
	return {
		version: PLUGIN_DATA_VERSION,
		settings: { ...DEFAULT_SETTINGS },
		token: null,
		queue: [],
		links: [],
		deviceId: null,
	};
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function asString(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null;
}

function asArray<T>(value: unknown): T[] {
	return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * Cualquier `data.json` al formato de hoy.
 *
 * Formato VIEJO (el que hay instalado ahora mismo): los ajustes y `token`
 * sueltos en la raíz, sin `version`. Se reconoce justo por no tener `version`, y
 * se conserva tanto el token como el origen configurado.
 */
export function migrate(raw: unknown): PluginData {
	const row = asRecord(raw);
	if (row === null) return emptyData();

	const settings = asRecord(row['settings']);
	// Sin `version` es el formato viejo: los ajustes estaban en la raíz.
	const apiOrigin =
		asString(settings?.['apiOrigin']) ?? asString(row['apiOrigin']) ?? DEFAULT_SETTINGS.apiOrigin;

	return {
		version: PLUGIN_DATA_VERSION,
		settings: { ...DEFAULT_SETTINGS, apiOrigin },
		token: asString(row['token']),
		queue: asArray<QueuedOperation>(row['queue']),
		links: asArray<LumbreTaskLink>(row['links']),
		deviceId: asString(row['deviceId']),
	};
}
