/**
 * La propiedad `lumbre-list` del frontmatter: nota de proyecto ↔ lista.
 *
 * Es LO ÚNICO que el plugin escribe dentro de una nota, y solo cuando el usuario
 * lo pide con el comando de vincular. Nada de tareas en el Markdown: el vault
 * manda sobre la nota, Lumbre manda sobre la tarea.
 *
 * Se escribe con `fileManager.processFrontMatter`, que es la vía que respeta el
 * resto de propiedades y el formato de la nota; leer y reescribir el fichero a
 * mano se comería el frontmatter de otros plugins.
 */

import type { App, TFile } from 'obsidian';

/** Nombre de la propiedad. Con guion, como el resto de propiedades del vault. */
export const NOTE_LIST_PROPERTY = 'lumbre-list';

/**
 * El id de lista escrito en la nota, o `null`. Se lee de la caché de metadatos,
 * no del disco: es lo que ya tiene Obsidian parseado.
 */
export function readNoteListId(app: App, file: TFile): string | null {
	const value: unknown = app.metadataCache.getFileCache(file)?.frontmatter?.[NOTE_LIST_PROPERTY];
	return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Escribe la propiedad, o la borra si `listId` es `null`. */
export async function writeNoteListId(app: App, file: TFile, listId: string | null): Promise<void> {
	await app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
		if (listId === null) {
			delete frontmatter[NOTE_LIST_PROPERTY];
			return;
		}
		frontmatter[NOTE_LIST_PROPERTY] = listId;
	});
}
