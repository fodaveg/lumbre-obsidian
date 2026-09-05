/**
 * Enlace profundo `obsidian://` a una nota del vault.
 *
 * Módulo puro: no importa `obsidian`, así que se prueba con Vitest sin cargar
 * su API. Quien conoce el nombre del vault (`app.vault.getName()`) y la ruta de
 * la nota es `main.ts`; aquí solo se compone la cadena, byte a byte igual que
 * la que genera el propio Obsidian con «Copiar URL de Obsidian».
 *
 * `encodeURIComponent` y no `URLSearchParams`: este último codifica el espacio
 * como `+`, que el manejador de enlaces de Obsidian no interpreta (espera
 * `%20`). Es justo la trampa que documenta `POST /api/list-links` en el repo de
 * Lumbre: la url se guarda TAL CUAL llega, así que reserializarla con otra
 * codificación la deja sin casar en un `unlink` posterior.
 */

/** Tope de `label` que acepta `POST /api/list-links` en el servidor. */
export const MAX_LABEL_LENGTH = 300;

/** La ruta de una nota sin la extensión `.md`, que es lo que pide el parámetro `file=`. */
export function notePathWithoutExtension(path: string): string {
	return path.endsWith('.md') ? path.slice(0, -'.md'.length) : path;
}

/**
 * Compone `obsidian://open?vault=<vault>&file=<ruta sin .md>`. `vaultName` es
 * `app.vault.getName()` y `notePath` la ruta de la nota CON extensión, tal y
 * como la da Obsidian.
 */
export function buildObsidianDeepLink(vaultName: string, notePath: string): string {
	const file = notePathWithoutExtension(notePath);
	return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(file)}`;
}

/** El `label` de un vínculo: el nombre de la nota, recortado al tope del servidor. */
export function noteLinkLabel(basename: string): string {
	return basename.length > MAX_LABEL_LENGTH ? basename.slice(0, MAX_LABEL_LENGTH) : basename;
}
