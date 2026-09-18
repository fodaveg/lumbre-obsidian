/**
 * Qué se puede pintar DENTRO del plugin para un adjunto, sin escribirlo en el
 * vault.
 *
 * Límite de producto fijado por David el 3 sep 2026: un adjunto se ABRE, nunca
 * se guarda en el vault. `app.openWithDefaultApp` no sirve: exige un fichero
 * QUE YA ESTÉ en el vault, justo lo que no se quiere. La vía que sí funciona
 * (medida en `AttachmentPreviewModal`, `attachment-preview-modal.ts`) es pintar
 * los bytes en memoria dentro de un `Modal` de Obsidian: un `<img>` para una
 * imagen, un `<iframe>` para un PDF, texto plano para lo demás que se sepa
 * leer. Es la MISMA vía en escritorio y en móvil, porque ninguna de las tres
 * depende de un visor nativo ni de un fichero real en disco.
 *
 * Este módulo solo decide QUÉ mime entra en cada vía; no toca bytes ni importa
 * `obsidian`.
 */

import { formatBytes } from './upload';

/** Cómo se pinta un adjunto reconocido. */
export type AttachmentViewKind = 'image' | 'pdf' | 'text';

/** Los mimes de imagen que Obsidian sabe pintar en un `<img>` sin plugins de más. */
const IMAGE_MIMES: ReadonlySet<string> = new Set([
	'image/png',
	'image/jpeg',
	'image/gif',
	'image/webp',
	'image/svg+xml',
	'image/avif',
	'image/bmp',
]);

/**
 * Mimes de texto que no empiezan por `text/` pero se leen igual con
 * `TextDecoder`. Solo `application/json`, que es el único de este tipo que
 * sube el propio plugin (ver `MIME_BY_EXTENSION` en `attachments/upload.ts`).
 */
const EXTRA_TEXT_MIMES: ReadonlySet<string> = new Set(['application/json']);

/**
 * El tipo de vista para un mime, o `null` si aquí no hay forma de pintarlo:
 * el modal lo dice entonces con `unsupportedPreviewMessage`, sin fingir que se
 * abre.
 */
export function viewKindFor(mime: string): AttachmentViewKind | null {
	const normalized = mime.trim().toLowerCase();
	if (IMAGE_MIMES.has(normalized)) return 'image';
	if (normalized === 'application/pdf') return 'pdf';
	if (normalized.startsWith('text/') || EXTRA_TEXT_MIMES.has(normalized)) return 'text';
	return null;
}

/** El texto de "no se puede previsualizar", con lo mínimo para identificar el fichero. */
export function unsupportedPreviewMessage(attachment: {
	filename: string;
	mime: string;
	size: number;
}): string {
	const mime = attachment.mime.trim().length > 0 ? attachment.mime : 'tipo desconocido';
	return `No se puede previsualizar «${attachment.filename}» (${mime}, ${formatBytes(attachment.size)}).`;
}
