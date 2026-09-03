/**
 * El BRL (el registro del día de Lumbre) de cara al plugin.
 *
 * Módulo puro: no importa `obsidian` y no hace red. Aquí vive lo que decide
 * QUÉ se manda al crear una entrada y CÓMO se reconoce al releerla.
 *
 * Dos cosas que vienen del servidor y explican la forma de todo esto:
 *
 * - El tipo de entrada NO es un campo: lo decide el primer carácter del texto.
 *   `-` es nota, `=` es pensamiento, y sin marcador es nota. El servidor
 *   canonicaliza igual, así que aquí se manda ya con su marcador para que lo
 *   que se guarda sea exactamente lo que el usuario eligió en el modal.
 * - La HORA no se manda. La resuelve Lumbre al encolar, con la zona horaria de
 *   la cuenta: hora del reloj si la entrada cae en el día en curso, y sin hora
 *   para cualquier otro día. Mandarla desde aquí sería adivinar la zona.
 */

import type { BrlDay } from '../lumbre/client';

/** Los dos tipos de entrada del registro. */
export type BrlKind = 'note' | 'thought';

/** El día que pide `GET /api/brl/<date>`: una fecha, o el literal `today`. */
export const BRL_TODAY = 'today';

/** Tope del texto de una entrada, el mismo `MAX_CONTENT_LEN` del servidor. */
export const MAX_BRL_ENTRY_LENGTH = 2000;

/** El marcador con el que viaja cada tipo. */
export function brlMarker(kind: BrlKind): '-' | '=' {
	return kind === 'thought' ? '=' : '-';
}

/**
 * El texto que se manda: el del usuario con SU marcador delante, sin el que
 * pudiera haber escrito él. Devuelve `null` si no queda nada que registrar,
 * porque una entrada vacía el servidor la descarta en silencio.
 */
export function brlEntryText(raw: string, kind: BrlKind): string | null {
	const trimmed = raw.trim();
	// Un marcador tecleado a mano NO decide el tipo: aquí lo decide el botón que
	// se ha pulsado, y dejar los dos produciría `- - texto`.
	const withoutMarker = trimmed.replace(/^[-=]\s*/, '').trim();
	if (withoutMarker.length === 0) return null;
	return `${brlMarker(kind)} ${withoutMarker.slice(0, MAX_BRL_ENTRY_LENGTH)}`;
}

/** Lo que hace falta para encolar la creación de una entrada. */
export interface BrlCreateOp {
	/** Día del registro: `YYYY-MM-DD`, o `today` para que lo resuelva el servidor. */
	date: string;
	/** Texto ya canónico, con su marcador. */
	entry: string;
}

/**
 * La operación de crear una entrada, o `null` si el texto no da para una.
 *
 * `date` por defecto es `today`: quien anota desde una nota quiere el registro
 * de HOY, y qué día es hoy lo sabe el servidor mejor que el dispositivo.
 */
export function brlCreateOp(raw: string, kind: BrlKind, date = BRL_TODAY): BrlCreateOp | null {
	const entry = brlEntryText(raw, kind);
	return entry === null ? null : { date, entry };
}

/**
 * `true` si el día releído ya contiene la entrada que se encoló.
 *
 * Se busca por ID, no por texto: el id lo fija el plugin antes de enviar (viaja
 * como `taskId` de la mutación) y es el que TENDRÁ la entrada. Buscar por texto
 * confundiría dos apuntes iguales del mismo día, que es algo perfectamente
 * normal en un registro.
 */
export function brlEntryPresent(day: BrlDay, entryId: string): boolean {
	return day.entries.some((entry) => entry.id === entryId);
}

/**
 * El día `YYYY-MM-DD` que hay que pedir, a partir de lo escrito en un bloque.
 * `today` (o nada) se deja tal cual para que lo resuelva el servidor con la
 * zona de la cuenta; cualquier otra cosa tiene que ser una fecha ISO.
 */
export function parseBrlDate(raw: string): { ok: true; date: string } | { ok: false; error: string } {
	const value = raw.trim().toLowerCase();
	if (value.length === 0 || value === BRL_TODAY || value === 'hoy') {
		return { ok: true, date: BRL_TODAY };
	}
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		return { ok: false, error: `«${raw.trim()}» no es una fecha. Usa YYYY-MM-DD o «today».` };
	}
	return { ok: true, date: value };
}

/**
 * El cuerpo de un bloque ```lumbre-brl```: una sola clave, `date`. Un cuerpo
 * vacío es el día de hoy. Nunca lanza: el bloque tiene que poder pintar el
 * problema en una línea sin romper el render de la nota.
 */
export function parseBrlQuery(source: string): { ok: true; date: string } | { ok: false; error: string } {
	let date = BRL_TODAY;

	for (const rawLine of source.split('\n')) {
		const line = rawLine.trim();
		if (line.length === 0) continue;

		const separator = line.indexOf(':');
		if (separator < 0) {
			return { ok: false, error: `No entiendo «${line}»: la única clave es «date: today».` };
		}
		const written = line.slice(0, separator).trim();
		if (written.toLowerCase() !== 'date') {
			return { ok: false, error: `No conozco la clave «${written}». La única que hay es «date».` };
		}
		const parsed = parseBrlDate(line.slice(separator + 1));
		if (!parsed.ok) return parsed;
		date = parsed.date;
	}

	return { ok: true, date };
}
