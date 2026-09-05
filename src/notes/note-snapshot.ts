/**
 * La foto de una nota (o de su selección) dentro de las `notes` de una tarea.
 *
 * Es el comando «Guardar esta nota en la tarea», y va en sentido CONTRARIO al
 * de «Insertar el BRL de hoy» o «Insertar la foto semanal»: aquí el texto sale
 * de la bóveda hacia Lumbre, no al revés. Lo habilita la decisión de David del
 * 4 sep 2026: el texto de una nota SÍ puede salir del vault, pero SOLO por un
 * comando ejecutado a mano. Es una FOTO FIJA, igual que el BRL de hoy: no se
 * repite sola y desde que se guarda es un texto más dentro de `notes`, sin
 * vínculo vivo con la nota que lo originó.
 *
 * Módulo puro: no importa `obsidian` y no hace red. Solo decide CÓMO se
 * compone el texto que se manda; quién lo manda (la cola) y quién lo confirma
 * (`getTask`) vive en `src/lumbre/queue.ts`.
 *
 * REGLA DE ORO: esto AÑADE, nunca sustituye. `POST /api/mutations` con
 * `op: 'update'` REEMPLAZA el campo `notes` entero (medido en el repo de
 * Lumbre, `src/lib/server/repos/mutations.ts:357`, `out.notes =
 * body.notes...`), así que el texto final que se manda tiene que llevar YA lo
 * que hubiera delante: sustituir pisaría lo que David escribió desde Lumbre, y
 * eso es pérdida de datos por el camino que devuelve éxito.
 */

/**
 * Tope de `notes` que impone Lumbre. Medido el 5 sep 2026 en su repo:
 * `MAX_NOTES_LEN = 10000` (`src/lib/ingest-structured.ts:29`). Por encima de
 * esto el servidor NO rechaza la mutación: recorta el campo en SILENCIO
 * (`src/lib/server/repos/mutations.ts:357`,
 * `out.notes = body.notes.trim().slice(0, MAX_NOTES_LEN)`), así que hay que
 * decidir el recorte AQUÍ, antes de mandar nada, o la foto se perdería por la
 * cola sin que nadie lo viera. El cuerpo entero de `POST /api/mutations` tiene
 * además un tope de 64 KiB (`src/routes/api/mutations/+server.ts:106`), pero
 * en caracteres de `notes` el de arriba se alcanza SIEMPRE antes: 10000
 * caracteres son como mucho 40 KB en UTF-8.
 */
export const MAX_NOTES_LEN = 10_000;

/** El principio de toda cabecera de foto. Sirve para CONTARLAS, no solo para componerlas. */
const HEADER_PREFIX = '=== Foto de la nota ';

/** El final de toda cabecera de foto, después de la fecha y la hora. */
const HEADER_SUFFIX = ' ===';

/** Lo que se añade al final del texto cuando ha hecho falta recortarlo. */
export const TRUNCATION_MARK = '\n\n[Foto recortada al tope de Lumbre]';

/**
 * La cabecera de una foto: reconocible por su prefijo fijo, con la ruta de la
 * nota y la fecha y hora LOCALES de cuándo se tomó (el reloj del usuario que
 * pulsa «Guardar», no el del servidor).
 */
export function snapshotHeader(notePath: string, at: Date): string {
	return `${HEADER_PREFIX}${notePath} · ${formatStamp(at)}${HEADER_SUFFIX}`;
}

/**
 * Cuántas fotos anteriores hay ya en unas `notes`, contando cabeceras. `null`
 * o vacío son cero fotos, no un error: una tarea recién creada no tiene notas.
 */
export function countSnapshots(notes: string | null): number {
	if (notes === null || notes.length === 0) return 0;
	const matches = notes.split(HEADER_PREFIX);
	// `split` da N+1 trozos por N apariciones del separador.
	return Math.max(0, matches.length - 1);
}

/** El texto final SIN recortar: lo existente, y detrás la cabecera y el cuerpo de la foto nueva. */
export function joinSnapshot(existingNotes: string | null, header: string, text: string): string {
	const existing = (existingNotes ?? '').trim();
	const block = `${header}\n\n${text}`;
	return existing.length > 0 ? `${existing}\n\n${block}` : block;
}

/** El resultado de componer una foto, ya decidido si cupo entera o hubo que recortarla. */
export interface NoteSnapshot {
	/** El texto que hay que mandar como `notes`. */
	notes: string;
	/** `true` si el texto de la foto se ha recortado para caber en el tope. */
	truncated: boolean;
}

/**
 * Compone la foto entera: la cabecera, y lo existente más la foto nueva. Si no
 * cabe en `maxLen`, la primera llamada NO recorta sola: devuelve `null`, que es
 * la señal para que el modal pregunte antes de tocar nada. Solo con
 * `allowTruncate: true` se recorta el TEXTO de la foto (nunca lo existente,
 * que es ajeno, ni la cabecera, que es lo que la hace reconocible) y se añade
 * `TRUNCATION_MARK`.
 *
 * Si ni siquiera la cabecera cabe detrás de lo existente, devuelve `null`
 * también con `allowTruncate: true`: no hay recorte razonable que ofrecer, y
 * el modal solo puede cancelar.
 */
export function composeSnapshot(
	existingNotes: string | null,
	notePath: string,
	text: string,
	at: Date,
	options: { allowTruncate: boolean; maxLen?: number } = { allowTruncate: false },
): NoteSnapshot | null {
	const maxLen = options.maxLen ?? MAX_NOTES_LEN;
	const header = snapshotHeader(notePath, at);
	const full = joinSnapshot(existingNotes, header, text);
	if (full.length <= maxLen) return { notes: full, truncated: false };
	if (!options.allowTruncate) return null;

	const existing = (existingNotes ?? '').trim();
	const prefix = existing.length > 0 ? `${existing}\n\n${header}\n\n` : `${header}\n\n`;
	const budget = maxLen - prefix.length - TRUNCATION_MARK.length;
	if (budget <= 0) return null;

	return { notes: `${prefix}${text.slice(0, budget)}${TRUNCATION_MARK}`, truncated: true };
}

/** `YYYY-MM-DD HH:MM`, con el reloj LOCAL: es el que ve quien pulsa «Guardar». */
function formatStamp(at: Date): string {
	return `${dayOf(at)} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** El día local `YYYY-MM-DD`. */
function dayOf(at: Date): string {
	return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

function pad(value: number): string {
	return String(value).padStart(2, '0');
}
