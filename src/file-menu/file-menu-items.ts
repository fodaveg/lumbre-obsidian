/**
 * Qué entradas añade Lumbre al menú contextual de un fichero del explorador
 * (`workspace.on('file-menu')`).
 *
 * Hasta ahora las dos acciones de este menú (vincular una nota a una lista,
 * adjuntar un fichero a una tarea) solo se podían disparar desde la paleta de
 * comandos o desde dentro del panel, con la nota ya abierta. Clic derecho
 * sobre el fichero en el explorador es más corto y no exige tenerlo abierto.
 *
 * «Vincular a una lista» reutiliza `linkNoteToList` (`main.ts`), que YA
 * escribe `lumbre-list` en el frontmatter: solo tiene sentido sobre una nota
 * Markdown, nunca sobre un adjunto o una carpeta.
 *
 * «Adjuntar a una tarea de Lumbre» vale para CUALQUIER fichero (una nota
 * también se puede adjuntar como fichero, aparte de vincularse como nota): el
 * tope de 25 MB lo comprueba `attachments/upload.ts` al elegir la tarea, no
 * aquí.
 *
 * Módulo puro: no importa `obsidian`. `main.ts` decide con `instanceof TFile`
 * si hay fichero de verdad (una carpeta no tiene extensión y no entra aquí) y
 * llama a esto solo entonces.
 */

export type FileMenuItemKind = 'linkToList' | 'attachToTask';

/** Lo mínimo de un fichero que hace falta para decidir el menú. */
export interface FileMenuTarget {
	/** Sin el punto, como `TFile.extension` de Obsidian (`'md'`, `'png'`...). */
	extension: string;
}

const NOTE_EXTENSION = 'md';

/** Las entradas que le tocan a este fichero, en el orden en que se pintan. */
export function fileMenuItems(file: FileMenuTarget): FileMenuItemKind[] {
	const items: FileMenuItemKind[] = [];
	if (file.extension.toLowerCase() === NOTE_EXTENSION) items.push('linkToList');
	items.push('attachToTask');
	return items;
}
