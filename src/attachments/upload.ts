/**
 * Subir un fichero del vault como adjunto de una tarea.
 *
 * Módulo puro: no importa `obsidian` y no hace red. Decide QUÉ se manda (la
 * URL, las cabeceras y el cuerpo) y qué se rechaza ANTES de gastar la subida.
 *
 * Esto NO pasa por la cola durable, a diferencia del resto de escrituras del
 * plugin, y es a propósito: la cola persiste en `data.json`, que viaja por
 * Obsidian Sync. Meter ahí los bytes de un fichero de 25 MB en base64 hincharía
 * el fichero de datos del plugin y lo sincronizaría entero a cada cambio. Un
 * adjunto se sube ahora o no se sube; si falla, se ofrece reintentar.
 *
 * Y una segunda regla, esta del servidor: el `Content-Type` va SIEMPRE en
 * `application/octet-stream` y el mime real en `x-lumbre-content-type`.
 * SvelteKit rechaza con 403, antes de llegar al handler, un POST cuyo
 * `Content-Type` sea uno de los cuatro que trata como formulario, y `text/plain`
 * (un `.txt` o un `.log` del vault) es justo uno de ellos.
 */

import { MAX_ATTACHMENT_BYTES } from '../lumbre/client';

/** Mime por defecto de lo que no se sabe reconocer, el mismo que usa el servidor. */
export const DEFAULT_MIME = 'application/octet-stream';

/** Por qué un fichero no se puede subir. */
export type UploadRejection = 'empty' | 'too_large';

export type UploadCheck = { ok: true } | { ok: false; reason: UploadRejection; message: string };

/**
 * Si el fichero cabe. El servidor es el autoritativo (vuelve a comprobarlo con
 * el buffer que lee), pero rechazar aquí evita subir 30 MB para que los tire al
 * final.
 */
export function checkUploadSize(bytes: number): UploadCheck {
	if (bytes <= 0) return { ok: false, reason: 'empty', message: 'El fichero está vacío.' };
	if (bytes > MAX_ATTACHMENT_BYTES) {
		return {
			ok: false,
			reason: 'too_large',
			message: `El fichero ocupa ${formatBytes(bytes)} y el tope de Lumbre es 25 MB.`,
		};
	}
	return { ok: true };
}

/** La petición de subida, ya montada. */
export interface UploadRequest {
	/** Ruta con su query, relativa al origen. */
	path: string;
	headers: Record<string, string>;
	body: ArrayBuffer;
}

/**
 * La petición de subir `bytes` como adjunto de `taskId`.
 *
 * El nombre del fichero viaja URL-encodeado en una CABECERA, nunca en la query:
 * un nombre de fichero ahí acabaría en los access logs del proxy.
 */
export function uploadRequest(
	taskId: string,
	filename: string,
	mime: string,
	bytes: ArrayBuffer,
): UploadRequest {
	const query = new URLSearchParams({ taskId });
	return {
		path: `/api/attachments?${query.toString()}`,
		headers: {
			'Content-Type': DEFAULT_MIME,
			'x-lumbre-filename': encodeURIComponent(filename),
			'x-lumbre-content-type': mime.trim().length > 0 ? mime.trim() : DEFAULT_MIME,
		},
		body: bytes,
	};
}

/** Extensiones que el vault guarda y de las que se sabe el mime. */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	svg: 'image/svg+xml',
	avif: 'image/avif',
	bmp: 'image/bmp',
	pdf: 'application/pdf',
	txt: 'text/plain',
	csv: 'text/csv',
	json: 'application/json',
	zip: 'application/zip',
	mp3: 'audio/mpeg',
	m4a: 'audio/mp4',
	wav: 'audio/wav',
	ogg: 'audio/ogg',
	webm: 'video/webm',
	mp4: 'video/mp4',
	mov: 'video/quicktime',
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/**
 * El mime de un fichero por su extensión. Lo que no está en la tabla sube como
 * `application/octet-stream`, que es lo que hace también el servidor cuando no
 * lo sabe: un mime inventado sería peor que no decir nada.
 */
export function mimeForExtension(extension: string): string {
	return MIME_BY_EXTENSION[extension.toLowerCase()] ?? DEFAULT_MIME;
}

/** El tamaño en la unidad que se lee de un vistazo. Para el Notice y la lista. */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const kb = bytes / 1024;
	if (kb < 1024) return `${Math.round(kb)} kB`;
	return `${(kb / 1024).toFixed(1)} MB`;
}
