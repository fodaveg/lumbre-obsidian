/**
 * Lo que se apunta de un bloque cuyo cuerpo no se entiende.
 *
 * Existe para tener UN solo sitio donde se decide qué sale del vault: el cuerpo
 * de un bloque MAL ESCRITO no es una consulta, es texto que alguien tecleó
 * dentro de su nota, y el informe de diagnóstico promete no llevarse el texto de
 * las notas. Así que en `info` va la LONGITUD, y el texto solo en `debug`, que es
 * cuando el usuario ha subido el nivel a propósito para reproducir un fallo.
 *
 * Módulo puro: no importa `obsidian`.
 */

import type { Logger } from '../diagnostics/logger';

export interface InvalidBlockEvent {
	/** Ruta de la nota. La ruta SÍ va: es lo que identifica dónde está el bloque. */
	notePath: string;
	/** El error del parser, que lo escribe el plugin. */
	error: string;
	/** El cuerpo del bloque, tal cual lo escribió el usuario. */
	source: string;
}

/** Apunta el bloque no válido sin llevarse su texto salvo en `debug`. */
export function logInvalidBlock(logger: Logger, message: string, event: InvalidBlockEvent): void {
	logger.warn(message, {
		notePath: event.notePath,
		error: event.error,
		sourceLength: event.source.length,
		...(logger.enabled('debug') ? { source: event.source } : {}),
	});
}
