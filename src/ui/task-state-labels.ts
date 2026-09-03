/**
 * Las etiquetas de estado de una tarea, las que van en la línea de metadatos.
 *
 * Módulo puro: no importa `obsidian`. Existe para que el bloque y el panel digan
 * lo MISMO, y sobre todo para que una tarea ARCHIVADA se enseñe como lo que es.
 * Archivar en Lumbre es visibilidad, no borrar: antes la única señal de que una
 * tarea vinculada se había archivado era el error «Lumbre no devolvió esta
 * tarea», que además no se iba nunca.
 */

import type { LumbreTask } from '../lumbre/types';

export function taskStateLabels(task: LumbreTask): string[] {
	const labels: string[] = [];
	// Cancelada primero: una cancelada viaja con `done: true` y es lo que
	// explica que la fila no tenga casilla.
	if (task.cancelledAt !== null) labels.push('Cancelada');
	if (task.archivedAt !== null) labels.push('Archivada');
	return labels;
}
