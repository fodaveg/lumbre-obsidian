/**
 * Los dos ficheros de registro que el plugin deja en el vault.
 *
 * - El informe que guarda el botón «Guardar registro en el vault»:
 *   `<configDir>/plugins/lumbre/logs/lumbre-<fecha>-<hora>.log`. Se conservan
 *   los 10 últimos y los más viejos se borran, para que la carpeta no crezca
 *   sola en un vault que sincroniza.
 * - El registro EN VIVO (`lumbre-live.log`), apagado por defecto, que va
 *   apuntando los `warn` y los `error` según pasan. Existe para el fallo que
 *   ocurre cuando el usuario no está mirando: al volver, el fichero está ahí.
 *   Rota a 1 MB conservando UNA vuelta anterior.
 *
 * El nombre lleva la hora como `HHMMSS` y no con dos puntos a propósito: un
 * nombre de fichero con `:` dentro del vault mete a Obsidian Sync en un bucle.
 *
 * No importa `obsidian`: el adaptador entra por inyección (en el plugin es
 * `app.vault.adapter`), así que esto se prueba con Vitest.
 */

/** Lo que hacen falta del adaptador del vault. Lo cumple `app.vault.adapter`. */
export interface LogFileAdapter {
	exists(path: string): Promise<boolean>;
	mkdir(path: string): Promise<void>;
	write(path: string, data: string): Promise<void>;
	append(path: string, data: string): Promise<void>;
	list(path: string): Promise<{ files: string[]; folders: string[] }>;
	remove(path: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	stat(path: string): Promise<{ size: number } | null>;
}

/** Informes que se conservan en la carpeta. */
export const MAX_REPORT_FILES = 10;

/** Tamaño al que rota el registro en vivo. */
export const LIVE_LOG_MAX_BYTES = 1024 * 1024;

/** Nombre del fichero del registro en vivo. */
export const LIVE_LOG_NAME = 'lumbre-live.log';

/** Nombre de la vuelta anterior del registro en vivo. */
export const LIVE_LOG_PREVIOUS_NAME = 'lumbre-live.1.log';

const REPORT_PREFIX = 'lumbre-';
const REPORT_SUFFIX = '.log';

/** La carpeta de registros del plugin dentro de la configuración del vault. */
export function logsFolder(configDir: string, pluginId: string): string {
	return `${configDir}/plugins/${pluginId}/logs`;
}

/** `lumbre-2026-09-03-113245.log`, en la hora local del dispositivo. */
export function reportFileName(date: Date): string {
	const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
	const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
	return `${REPORT_PREFIX}${day}-${time}${REPORT_SUFFIX}`;
}

/**
 * Guarda el informe y devuelve la ruta. Antes de escribir poda los que sobran,
 * contando el que se va a crear: así en la carpeta nunca hay más de
 * `MAX_REPORT_FILES`.
 */
export async function saveReport(
	adapter: LogFileAdapter,
	folder: string,
	text: string,
	date: Date,
	keep: number = MAX_REPORT_FILES,
): Promise<string> {
	await ensureFolder(adapter, folder);
	await pruneReports(adapter, folder, Math.max(0, keep - 1));

	const path = `${folder}/${reportFileName(date)}`;
	await adapter.write(path, text);
	return path;
}

/** Crea la carpeta si falta. `mkdir` sobre una que ya existe lanza en algún SO. */
export async function ensureFolder(adapter: LogFileAdapter, folder: string): Promise<void> {
	if (await adapter.exists(folder)) return;
	await adapter.mkdir(folder);
}

/**
 * Deja como mucho `keep` informes en la carpeta, borrando los de nombre más
 * antiguo. El nombre lleva la fecha delante, así que ordenarlo por texto es
 * ordenarlo por fecha.
 */
export async function pruneReports(
	adapter: LogFileAdapter,
	folder: string,
	keep: number,
): Promise<number> {
	const listing = await adapter.list(folder);
	const reports = listing.files
		.filter((path) => isReportFile(path))
		.sort((a, b) => a.localeCompare(b));

	const extra = reports.length - keep;
	if (extra <= 0) return 0;

	for (const path of reports.slice(0, extra)) await adapter.remove(path);
	return extra;
}

/**
 * `true` si esa ruta es un informe guardado. El registro en vivo y su vuelta
 * anterior NO lo son: se llaman igual de prefijo pero no se podan con ellos.
 */
export function isReportFile(path: string): boolean {
	const name = path.slice(path.lastIndexOf('/') + 1);
	if (name === LIVE_LOG_NAME || name === LIVE_LOG_PREVIOUS_NAME) return false;
	return name.startsWith(REPORT_PREFIX) && name.endsWith(REPORT_SUFFIX);
}

/**
 * El registro en vivo. Las escrituras se encadenan (una detrás de otra) porque
 * `append` sobre el mismo fichero desde dos sitios a la vez se pisa, y esto se
 * llama desde un sink del logger, o sea desde cualquier parte del plugin.
 *
 * Ningún fallo de escritura se propaga: el registro no puede tumbar al plugin.
 * Lo que se cae se cuenta en `dropped`.
 */
export class LiveLog {
	private queue: Promise<void> = Promise.resolve();
	private failures = 0;

	constructor(
		private readonly adapter: LogFileAdapter,
		private readonly folder: string,
		private readonly maxBytes: number = LIVE_LOG_MAX_BYTES,
	) {}

	/** Líneas que no se pudieron escribir. Sale en el informe. */
	get dropped(): number {
		return this.failures;
	}

	get path(): string {
		return `${this.folder}/${LIVE_LOG_NAME}`;
	}

	/** Apunta una línea. No espera: devuelve la promesa por si un test la quiere. */
	append(line: string): Promise<void> {
		this.queue = this.queue.then(async () => {
			try {
				await ensureFolder(this.adapter, this.folder);
				await this.rotateIfNeeded();
				await this.adapter.append(this.path, `${line}\n`);
			} catch {
				this.failures += 1;
			}
		});
		return this.queue;
	}

	/** Espera a que salga todo lo encolado. Lo usa `onunload` y los tests. */
	async flush(): Promise<void> {
		await this.queue;
	}

	/**
	 * Al pasar del tope, el fichero pasa a ser la vuelta anterior y se empieza
	 * uno nuevo. Se conserva UNA vuelta: dos ficheros de 1 MB es lo máximo que
	 * puede ocupar esto en el vault.
	 */
	private async rotateIfNeeded(): Promise<void> {
		const stat = await this.adapter.stat(this.path);
		if (stat === null || stat.size < this.maxBytes) return;

		const previous = `${this.folder}/${LIVE_LOG_PREVIOUS_NAME}`;
		if (await this.adapter.exists(previous)) await this.adapter.remove(previous);
		await this.adapter.rename(this.path, previous);
	}
}

function pad(value: number): string {
	return String(value).padStart(2, '0');
}
