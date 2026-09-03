/**
 * Agrupa las tareas de una lista por su sección, para la vista de nota de
 * proyecto. Módulo puro: no importa `obsidian` y no hace red.
 *
 * La sección viene DENTRO de cada tarea (`serializeTask` manda `sectionId` y
 * `section`), así que agrupar aquí no cuesta ninguna petición extra: una sola
 * llamada a `listTasks({ list })` trae todo lo que hace falta.
 */

import type { LumbreTask } from '../lumbre/types';

export interface TaskSection {
	/** Id de la sección, o `null` para las tareas sueltas de la lista. */
	id: string | null;
	name: string;
	tasks: LumbreTask[];
}

/** Nombre del grupo de las tareas que no están en ninguna sección. */
export const UNSECTIONED_NAME = 'Sin sección';

/**
 * Las tareas agrupadas, en el orden en que aparecen. El grupo sin sección va
 * primero si existe, que es como se ven en Lumbre.
 */
export function groupBySection(tasks: readonly LumbreTask[]): TaskSection[] {
	const groups: TaskSection[] = [];
	const byId = new Map<string | null, TaskSection>();

	for (const task of tasks) {
		const id = task.section?.id ?? null;
		let group = byId.get(id);
		if (group === undefined) {
			group = { id, name: task.section?.name ?? UNSECTIONED_NAME, tasks: [] };
			byId.set(id, group);
			groups.push(group);
		}
		group.tasks.push(task);
	}

	return groups.sort((a, b) => Number(a.id !== null) - Number(b.id !== null));
}
