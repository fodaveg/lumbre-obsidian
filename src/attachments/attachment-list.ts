/**
 * Qué enseñar de los adjuntos de una tarea en el panel «Tareas de esta nota».
 *
 * Módulo puro: no importa `obsidian` y no hace red. `LumbreTask.attachments`
 * puede venir en tres formas y aquí se distinguen las tres, aunque el panel
 * pinte los dos primeros casos igual (nada que desplegar): AUSENTE es "el
 * servidor no lo dice" (un Lumbre anterior a `serializeTask` con `attachments`),
 * vacío es "esta tarea no tiene ninguno", y son datos distintos aunque hoy se
 * vean igual en la interfaz.
 */

import type { LumbreAttachment, LumbreTask } from '../lumbre/types';

/** Lo que hay que pintar de los adjuntos de una tarea. */
export type AttachmentsSection =
	| { kind: 'unknown' }
	| { kind: 'empty' }
	| { kind: 'list'; attachments: readonly LumbreAttachment[] };

/** Decide el estado a partir de `task.attachments`. Ver el JSDoc del módulo. */
export function attachmentsSectionFor(
	task: Pick<LumbreTask, 'attachments'>,
): AttachmentsSection {
	if (task.attachments === undefined) return { kind: 'unknown' };
	if (task.attachments.length === 0) return { kind: 'empty' };
	return { kind: 'list', attachments: task.attachments };
}

/** El texto del botón que despliega la lista, con el contador ya en singular o plural. */
export function attachmentsToggleLabel(count: number): string {
	return count === 1 ? '1 adjunto' : `${count} adjuntos`;
}

/** El texto del botón de borrar una fila, según si la petición está en curso. */
export function deleteButtonLabel(deleting: boolean): string {
	return deleting ? 'Borrando…' : 'Borrar';
}
