/**
 * De lo que hay en el editor al borrador de una tarea.
 *
 * Módulo puro: no importa `obsidian` ni toca el vault. Recibe la selección y la
 * línea del cursor ya leídas, y devuelve el título y el extracto con los que se
 * abre el modal de enviar.
 *
 * Esto NO convierte un checkbox del vault en tarea: la nota no se toca ni se
 * marca. Lo único que se hace con el marcador de lista es QUITARLO del título,
 * porque `- [ ] ` dentro del texto de una tarea de Lumbre no significa nada.
 */

/** Tope del título de una tarea. */
export const MAX_TITLE_LENGTH = 300;

/** Tope del extracto que se guarda en el vínculo nota ↔ tarea. */
export const MAX_EXCERPT_LENGTH = 240;

export interface EditorContext {
	/** Texto seleccionado, o cadena vacía si no hay selección. */
	selection: string;
	/** Línea del cursor tal cual, con su indentación y su marcador si lo tiene. */
	line: string;
}

export interface EditorDraft {
	/** Título ya recortado, listo para el campo del modal. */
	title: string;
	/** Contexto corto para el vínculo, o `null` si no había texto. */
	excerpt: string | null;
}

/**
 * Marcador de lista al principio de la línea: viñeta (`-`, `*`, `+`) o número
 * (`1.`, `1)`), y detrás el checkbox opcional en cualquiera de sus estados.
 */
const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[.\]\s+)?/;

/** La línea sin su marcador de lista ni su checkbox. */
export function stripListMarker(line: string): string {
	return line.replace(LIST_MARKER, '').trim();
}

/** Todo el espacio en blanco a un solo espacio: una tarea es de UNA línea. */
export function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

/** Recorta a `max` caracteres CONTANDO el carácter de recorte. */
export function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * El borrador que ve el usuario al abrir el modal. La selección manda; si no
 * hay, se usa la línea del cursor sin su marcador.
 */
export function draftFromEditor(context: EditorContext): EditorDraft {
	const selected = collapseWhitespace(stripListMarker(context.selection));
	const source = selected.length > 0 ? selected : collapseWhitespace(stripListMarker(context.line));
	return {
		title: truncate(source, MAX_TITLE_LENGTH),
		excerpt: source.length > 0 ? truncate(source, MAX_EXCERPT_LENGTH) : null,
	};
}
