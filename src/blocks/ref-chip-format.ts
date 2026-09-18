/**
 * El texto de la ficha de una referencia a tarea: estado y fecha, lo mínimo
 * para reconocerla sin abrir Lumbre.
 *
 * Reutiliza `taskStateLabels` (Cancelada/Archivada) para decir lo MISMO que
 * el bloque ```lumbre``` y el panel, y añade "Hecha" para una completada que
 * no está cancelada: ninguna otra superficie necesita esa etiqueta aparte
 * porque todas pintan una casilla marcada; la ficha no tiene casilla.
 *
 * Módulo puro: no importa `obsidian`.
 */

import type { LumbreTask } from '../lumbre/types';
import { taskStateLabels } from '../ui/task-state-labels';

/** La fecha con su hora, o "Algún día", o `null` si la tarea no tiene ninguna. */
function whenText(task: Pick<LumbreTask, 'date' | 'time' | 'someday'>): string | null {
	if (task.someday) return 'Algún día';
	if (task.date === null) return task.time;
	return task.time === null ? task.date : `${task.date} ${task.time}`;
}

function statusLabels(task: LumbreTask): string[] {
	const labels = taskStateLabels(task);
	// Cancelada ya avisa con `done: true`; "Hecha" es solo para la completada
	// SIN cancelar, delante de Archivada si las dos aplican.
	if (task.done && task.cancelledAt === null) return ['Hecha', ...labels];
	return labels;
}

/**
 * El texto de la ficha, o `null` si no hay nada que añadir (tarea abierta sin
 * fecha): en ese caso el chip no se pinta y el enlace se queda con su
 * etiqueta de referencia tal cual.
 */
export function refChipText(task: LumbreTask): string | null {
	const parts = [...statusLabels(task)];
	const when = whenText(task);
	if (when !== null) parts.push(when);
	return parts.length === 0 ? null : parts.join(' · ');
}
