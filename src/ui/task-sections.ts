/**
 * Agrupa las tareas para pintarlas en bloques: por sección (la vista de nota de
 * proyecto, y el bloque ```lumbre``` cuando la consulta nombra una lista), por
 * lista propia o por la fecha programada (las dos últimas para `group: list` y
 * `group: date` del bloque, ver `groupTasksForQuery`). Módulo puro: no importa
 * `obsidian` y no hace red.
 *
 * La sección y la lista vienen DENTRO de cada tarea (`serializeTask` manda
 * `sectionId`/`section` y `somedayListId`/`list`), así que agrupar aquí no
 * cuesta ninguna petición extra: una sola llamada a `listTasks(...)` trae todo
 * lo que hace falta.
 */

import type { LumbreTask } from '../lumbre/types';
import type { GroupMode } from '../blocks/query-parser';

export interface TaskSection {
	/** Id del grupo, o `null` para las tareas sueltas (sin sección/lista/fecha). */
	id: string | null;
	name: string;
	tasks: LumbreTask[];
}

/** Nombre del grupo de las tareas que no están en ninguna sección. */
export const UNSECTIONED_NAME = 'Sin sección';

/** Nombre del grupo de las tareas sin lista (una tarea de "Algún día" sin asignar, p. ej.). */
export const UNLISTED_NAME = 'Sin lista';

/** Nombre del grupo de las tareas sin fecha programada. */
export const UNDATED_NAME = 'Sin fecha';

/**
 * Las tareas agrupadas por sección, en el orden en que aparecen. El grupo sin
 * sección va primero si existe, que es como se ven en Lumbre. Firma estable a
 * propósito: la consume también el panel (`NoteTasksView`).
 */
export function groupBySection(tasks: readonly LumbreTask[]): TaskSection[] {
	return groupByIdentity(
		tasks,
		(task) => task.section?.id ?? null,
		(task) => task.section?.name ?? UNSECTIONED_NAME,
		'unassigned-first',
	);
}

/**
 * Las tareas agrupadas por lista propia. Mismo criterio que `groupBySection`
 * (sin lista va primero, orden de llegada dentro de cada grupo): es la misma
 * clase de agrupación por identidad, solo que sobre `task.list` en vez de
 * `task.section`.
 */
export function groupByList(tasks: readonly LumbreTask[]): TaskSection[] {
	return groupByIdentity(
		tasks,
		(task) => task.list?.id ?? null,
		(task) => task.list?.name ?? UNLISTED_NAME,
		'unassigned-first',
	);
}

/**
 * Las tareas agrupadas por `date` (la fecha programada, `YYYY-MM-DD`), en
 * orden CRONOLÓGICO. A diferencia de `groupBySection`/`groupByList`, aquí "sin
 * fecha" va AL FINAL, no al principio: no hay una convención de Lumbre que
 * copiar (la app no agrupa así), así que se eligió consistencia con `sort`
 * (`applyClientFilters`, `query-parser.ts`), donde una fecha ausente también
 * va siempre detrás, gane quien gane la dirección.
 */
export function groupByDate(tasks: readonly LumbreTask[]): TaskSection[] {
	return groupByIdentity(
		tasks,
		(task) => task.date,
		(task) => task.date ?? UNDATED_NAME,
		'chronological-unassigned-last',
	);
}

/**
 * Resuelve `group` (la clave del bloque) a la función de agrupación que toca,
 * o `null` para "lista plana, sin grupos".
 *
 * `auto` (el valor por defecto, cuando el bloque no escribe `group`) reproduce
 * el comportamiento de SIEMPRE, fijado antes de que existiera esta clave:
 * agrupar por sección cuando la consulta nombra una lista (`hasList`), lista
 * plana en cualquier otro caso. Un bloque ya escrito en una nota, que nunca
 * mencionó `group`, se pinta exactamente igual que antes.
 */
export function groupTasksForQuery(
	tasks: readonly LumbreTask[],
	group: GroupMode,
	hasList: boolean,
): TaskSection[] | null {
	const effective = group === 'auto' ? (hasList ? 'section' : 'none') : group;
	switch (effective) {
		case 'none':
			return null;
		case 'section':
			return groupBySection(tasks);
		case 'list':
			return groupByList(tasks);
		case 'date':
			return groupByDate(tasks);
	}
}

/**
 * La agrupación por identidad que comparten `groupBySection` y `groupByList`
 * (y, con otro orden final, `groupByDate`): una clave por tarea, un grupo por
 * clave distinta, tareas en orden de llegada dentro de cada grupo.
 *
 * `order` decide solo el orden de los GRUPOS entre sí:
 * - `unassigned-first`: el grupo sin identidad (`id === null`) primero, el
 *   resto en el orden en que aparecieron.
 * - `chronological-unassigned-last`: los `id` (aquí, fechas `YYYY-MM-DD`) por
 *   orden ascendente, y el grupo sin identidad al final.
 */
function groupByIdentity(
	tasks: readonly LumbreTask[],
	idOf: (task: LumbreTask) => string | null,
	nameOf: (task: LumbreTask) => string,
	order: 'unassigned-first' | 'chronological-unassigned-last',
): TaskSection[] {
	const groups: TaskSection[] = [];
	const byId = new Map<string | null, TaskSection>();

	for (const task of tasks) {
		const id = idOf(task);
		let group = byId.get(id);
		if (group === undefined) {
			group = { id, name: nameOf(task), tasks: [] };
			byId.set(id, group);
			groups.push(group);
		}
		group.tasks.push(task);
	}

	if (order === 'unassigned-first') {
		return groups.sort((a, b) => Number(a.id !== null) - Number(b.id !== null));
	}

	return groups.sort((a, b) => {
		if (a.id === null) return 1;
		if (b.id === null) return -1;
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});
}
