/**
 * Nombre y ruta del fichero que guarda «Guardar una copia de exportación en el
 * vault».
 *
 * Módulo puro: sin red, sin `obsidian`. `GET /api/export` ya fija su propio
 * nombre por la cabecera `Content-Disposition` (`lumbre-export-<fecha>.json`,
 * fecha UTC del SERVIDOR), pero eso es el nombre de un fichero DESCARGADO, no
 * el de uno que este plugin escribe él mismo dentro del vault: aquí se
 * recalcula en LOCAL sobre `now`, así que lo que ve el usuario lleva SU fecha
 * (la del dispositivo), y guardar dos veces el mismo día sobrescribe en vez de
 * acumular ficheros.
 *
 * El nombre NUNCA lleva `:` ni ningún otro carácter fuera de lo que admite un
 * fichero del vault: un `:` en un nombre dentro del vault mete a Obsidian Sync
 * en un bucle infinito (incidente medido, ver `CLAUDE.md`).
 */

/** `lumbre-export-2026-09-05.json`, fecha LOCAL del dispositivo. */
export function exportFileName(now: Date): string {
	const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
	return `lumbre-export-${day}.json`;
}

/**
 * La ruta completa dentro del vault: la carpeta de ajustes (`exportFolder`)
 * más el nombre del día de hoy. Una barra final en `folder` no duplica la
 * separación.
 */
export function exportFilePath(folder: string, now: Date): string {
	const trimmed = folder.replace(/\/+$/, '');
	return `${trimmed}/${exportFileName(now)}`;
}

function pad(value: number): string {
	return String(value).padStart(2, '0');
}
