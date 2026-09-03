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
 *
 * Y por eso mismo `save()` RELEE el fichero antes de escribirlo y UNE lo que
 * encuentra con lo que tiene en memoria. `load()` corre una sola vez, al
 * arrancar: sin la relectura, un Obsidian abierto desde hace horas escribiría su
 * foto vieja encima de lo que otro dispositivo hubiera subido mientras tanto, y
 * las operaciones encoladas allí desaparecerían con los dos equipos dando éxito.
 */

import { isLogLevel, type Logger } from '../diagnostics/logger';
import type { LumbreTaskLink } from '../links/link-store';
import type { QueuedOperation } from '../lumbre/queue';
import { DEFAULT_SETTINGS, normalizeOrigin, type LumbreSettings } from '../settings';

/**
 * Versión del formato de `data.json`. Sube cuando la forma cambie.
 *
 * - 1: el objeto único (ajustes, token, cola, vínculos, deviceId).
 * - 2: los ajustes ganan `logLevel` y `liveLog`. Un `data.json` de la 1 los
 *   estrena en su valor por defecto, sin perder nada.
 */
export const PLUGIN_DATA_VERSION = 2;

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

	/**
	 * De qué versión venía lo que había en disco, o `null` si no había nada. Lo
	 * apunta el registro de diagnóstico al arrancar: una migración que no ocurre
	 * es una de las explicaciones de "se me han borrado los ajustes".
	 */
	migratedFrom: number | null = null;

	private pendingSave: Promise<void> | null = null;
	private lastWrite: Promise<void> = Promise.resolve();

	/**
	 * Ids que ESTE dispositivo ha quitado a propósito (una operación descartada,
	 * una podada, un vínculo desvinculado). La unión de `save()` no puede
	 * resucitarlos porque sigan en la foto de disco: quitarlos fue una decisión,
	 * no una pérdida. Vive en memoria y muere con la sesión, que es todo lo que
	 * hace falta: la escritura siguiente ya deja el fichero sin ellos.
	 */
	private readonly removedOperations = new Set<string>();
	private readonly removedLinks = new Set<string>();

	constructor(
		private readonly host: PluginDataHost,
		private readonly deviceIdStore?: DeviceIdStore,
		/** Registro de diagnóstico. Sin él, el almacén no apunta nada. */
		private readonly logger?: Logger,
	) {}

	/**
	 * Lee `data.json` y lo migra si viene del formato viejo (ajustes y `token`
	 * sueltos en la raíz). Una instalación que ya existía NO pierde su token.
	 */
	async load(): Promise<PluginData> {
		const raw = await this.host.loadData();
		this.migratedFrom = versionOf(raw);
		this.data = migrate(raw);
		this.data.deviceId = this.resolveDeviceId(this.data.deviceId);
		return this.data;
	}

	/** Id de ESTA instalación, resuelto en `load()`. */
	get deviceId(): string {
		return this.data.deviceId ?? '';
	}

	/**
	 * Escribe el objeto entero, UNIDO con lo que haya en disco. Varias llamadas
	 * dentro del mismo turno colapsan en un solo `saveData`, y dos escrituras
	 * nunca se solapan.
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
			const write = this.lastWrite.then(async () => {
				await this.host.saveData(await this.merged());
			});
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
		remember(this.data.queue, operations, this.removedOperations);
		this.data.queue = operations;
		await this.save();
	}

	readLinks(): LumbreTaskLink[] {
		return this.data.links;
	}

	async writeLinks(links: LumbreTaskLink[]): Promise<void> {
		remember(this.data.links, links, this.removedLinks);
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
	 * Lo que se escribe de verdad: la memoria, UNIDA con lo que hay en disco.
	 *
	 * Une la cola por `id` de operación y los vínculos por `id` de vínculo; ante
	 * el mismo id gana el `updatedAt` más reciente.
	 *
	 * Los ajustes y el token son de la MEMORIA, sin unir: son lo que el usuario
	 * acaba de tocar en esta ventana. En particular el token vacío gana, porque
	 * vaciarlo es una decisión suya y recuperarlo del fichero sería devolver una
	 * credencial que acaba de borrar.
	 *
	 * Si `data.json` no se puede leer, se escribe la memoria y se apunta el aviso:
	 * perder lo del otro dispositivo es malo, pero dejar de guardar lo de este
	 * sería peor.
	 */
	private async merged(): Promise<PluginData> {
		const mine = this.snapshot();
		let raw: unknown;
		try {
			raw = await this.host.loadData();
		} catch (error) {
			this.logger?.warn('No se ha podido releer data.json antes de guardar', {
				error: error instanceof Error ? error.message : String(error),
			});
			return mine;
		}

		const onDisk = asRecord(raw);
		if (onDisk === null) return mine;

		return {
			...mine,
			queue: mergeById(asArray<QueuedOperation>(onDisk['queue']), mine.queue, this.removedOperations),
			links: mergeById(asArray<LumbreTaskLink>(onDisk['links']), mine.links, this.removedLinks),
		};
	}

	/**
	 * Lo que hay en memoria. El `deviceId` solo baja a `data.json` si no hay
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

/** Una fila con id y marca de tiempo: lo que tienen en común la cola y los vínculos. */
interface Stamped {
	id: string;
	updatedAt: string;
}

/**
 * Une dos listas por `id`. Ante el mismo id gana el `updatedAt` más reciente; lo
 * que este dispositivo quitó a propósito (`removed`) no vuelve. El orden es el
 * de disco primero y lo nuevo de esta memoria detrás, que es el orden en que
 * ocurrieron.
 */
function mergeById<T extends Stamped>(fromDisk: T[], inMemory: T[], removed: ReadonlySet<string>): T[] {
	const merged = new Map<string, T>();
	for (const row of [...fromDisk, ...inMemory]) {
		if (typeof row?.id !== 'string' || removed.has(row.id)) continue;
		const previous = merged.get(row.id);
		if (previous === undefined || (row.updatedAt ?? '') >= (previous.updatedAt ?? '')) {
			merged.set(row.id, row);
		}
	}
	return [...merged.values()];
}

/** Apunta como quitados a propósito los ids que estaban y ya no están. */
function remember(before: readonly Stamped[], after: readonly Stamped[], removed: Set<string>): void {
	const kept = new Set(after.map((row) => row.id));
	for (const row of before) {
		if (!kept.has(row.id)) removed.add(row.id);
	}
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
	const writtenOrigin = asString(settings?.['apiOrigin']) ?? asString(row['apiOrigin']);
	const apiOrigin =
		writtenOrigin === null
			? DEFAULT_SETTINGS.apiOrigin
			: (normalizeOrigin(writtenOrigin) ?? DEFAULT_SETTINGS.apiOrigin);

	// Los ajustes de diagnóstico entraron en la versión 2. Un `data.json` de la 1
	// no los trae y estrena los valores por defecto, que es todo lo que hay que
	// migrar: no se pierde nada de lo anterior.
	const rawLevel = settings?.['logLevel'];
	const logLevel = isLogLevel(rawLevel) ? rawLevel : DEFAULT_SETTINGS.logLevel;

	return {
		version: PLUGIN_DATA_VERSION,
		// Los ajustes se COPIAN enteros sobre los de fábrica y solo se corrigen los
		// dos que pueden venir mal escritos. Reconstruirlos campo a campo hacía que
		// un ajuste que este plugin todavía no conoce (porque lo escribió una
		// versión más nueva desde otro dispositivo, por Sync) se perdiera en cada
		// carga, y la primera escritura lo borraba también del fichero.
		settings: {
			...DEFAULT_SETTINGS,
			...(settings ?? {}),
			apiOrigin,
			logLevel,
			liveLog: settings?.['liveLog'] === true,
		},
		token: asString(row['token']),
		queue: asArray<QueuedOperation>(row['queue']),
		links: asArray<LumbreTaskLink>(row['links']),
		deviceId: asString(row['deviceId']),
	};
}

/**
 * La versión que declara lo que hay en disco, o `null` si no hay nada guardado.
 * El formato viejo (ajustes sueltos en la raíz) no la declara y sale como 0.
 */
export function versionOf(raw: unknown): number | null {
	const row = asRecord(raw);
	if (row === null) return null;
	const version = row['version'];
	return typeof version === 'number' ? version : 0;
}
