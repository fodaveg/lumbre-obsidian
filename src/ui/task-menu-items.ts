/**
 * Qué entradas lleva el menú corto de UNA tarea, y con qué texto.
 *
 * Módulo puro: no importa `obsidian`. Lo consumen las dos superficies que
 * pintan tareas (el panel `NoteTasksView` y el bloque ```lumbre```) a través de
 * `task-menu.ts`, para que el menú sea EL MISMO en las dos y no dos listas que
 * se van separando con el tiempo.
 *
 * No es un editor: el título, las notas largas, la recurrencia y los
 * recordatorios se quedan en la app de Lumbre. Aquí solo están los seis gestos
 * cortos: reprogramar, cancelar, restaurar, mover de sección, mover de lista,
 * añadir subtarea y completar subtarea.
 *
 * Las reglas de abajo NO son estéticas, cada una tapa un modo de fallo medido
 * contra el repo de Lumbre:
 *
 * - **Archivada: ninguna entrada.** Un `addSubtask` sobre un padre archivado
 *   vuelve con `outcome: 'not-found'`, y del resto de ops sobre una archivada no
 *   hay medida. Una entrada que no se sabe si hace algo es peor que no tenerla.
 * - **Cancelada: solo «Restaurar».** Lo demás se decide en Lumbre, igual que la
 *   fila de una cancelada ya no trae casilla ni en el panel ni en el bloque.
 * - **Recurrente: sin reprogramar.** Desde el 16 sep 2026 el id visible es la
 *   semilla de la serie, así que reprogramar movería la SERIE ENTERA y no esta
 *   ocurrencia. Entre avisar y no ofrecerlo se eligió NO ofrecerlo: un aviso que
 *   se acepta a ciegas mueve doce ocurrencias de golpe y el plugin no tiene
 *   forma de deshacerlo. Es además lo que ya anticipaba el JSDoc de `recurrence`
 *   en `src/lumbre/types.ts`. Cambiar de día una ocurrencia suelta se hace en
 *   Lumbre, que sí sabe preguntar "esta o todas".
 * - **Subtarea: sin lista, sin sección y sin subtareas propias.** `addSubtask` y
 *   `moveToList` sobre una subtarea son no-op MUDOS (medido), y una subtarea no
 *   tiene lista propia, así que tampoco tiene sección dentro de la que moverse.
 *   De esas tres, las dos primeras están medidas y la tercera se descarta por el
 *   mismo razonamiento.
 * - **Sin lista: sin sección.** Una sección vive DENTRO de una lista; ofrecer
 *   «Mover a otra sección» en una tarea sin lista no tendría destino.
 * - **«Algún día» no está.** `reschedule {date: null}` deja la tarea en "En
 *   cualquier momento", no en "Algún día", y no hay ninguna op que ponga
 *   `someday`. Mientras Lumbre no la añada, el menú no miente con esa entrada.
 */

import type { LumbreTask } from '../lumbre/types';

/** Cada acción del menú. Una por entrada, sin submenús (la API de `Menu` no los tiene). */
export type TaskMenuItemKind =
	| 'rescheduleToday'
	| 'rescheduleTomorrow'
	| 'reschedulePick'
	| 'rescheduleClear'
	| 'cancel'
	| 'restore'
	| 'moveToList'
	| 'clearList'
	| 'setSection'
	| 'clearSection'
	| 'addSubtask'
	| 'completeSubtask';

/**
 * A qué bloque del menú pertenece la entrada. Solo sirve para meter un separador
 * al cambiar de grupo: con diez entradas seguidas no se encuentra nada.
 */
export type TaskMenuGroup = 'date' | 'state' | 'place' | 'subtasks';

/** Una entrada del menú, ya resuelta: qué dice, qué icono lleva y en qué grupo va. */
export interface TaskMenuItem {
	kind: TaskMenuItemKind;
	/** Texto de la entrada. Los puntos suspensivos avisan de que abre un diálogo. */
	title: string;
	/** Icono de Lucide, como en el resto del plugin. */
	icon: string;
	group: TaskMenuGroup;
	/** `true` si la entrada se pinta en rojo (la destructiva). */
	warning?: boolean;
}

/**
 * `true` si la tarea es una ocurrencia de una serie recurrente.
 *
 * Se mira `recurrence` Y `seriesId`, que Lumbre sirve desde el mismo SHA: con
 * los dos AUSENTES (un Lumbre anterior) la tarea se trata como no recurrente,
 * porque retirar la entrada contra un servidor que simplemente no informa
 * dejaría el menú sin reprogramar para todo el mundo.
 */
export function isRecurringTask(task: LumbreTask): boolean {
	if ((task.recurrence ?? null) !== null) return true;
	return (task.seriesId ?? null) !== null;
}

/**
 * Las entradas que le tocan a esta tarea, en el orden en que se pintan. Vacío
 * significa "esta fila no lleva menú" (hoy, una tarea archivada).
 */
export function taskMenuItems(task: LumbreTask): TaskMenuItem[] {
	if (task.archivedAt !== null) return [];

	if (task.cancelledAt !== null) {
		return [{ kind: 'restore', title: 'Restaurar la tarea', icon: 'rotate-ccw', group: 'state' }];
	}

	const items: TaskMenuItem[] = [];

	if (!isRecurringTask(task)) {
		items.push(
			{ kind: 'rescheduleToday', title: 'Reprogramar a hoy', icon: 'calendar', group: 'date' },
			{
				kind: 'rescheduleTomorrow',
				title: 'Reprogramar a mañana',
				icon: 'calendar',
				group: 'date',
			},
			{
				kind: 'reschedulePick',
				title: 'Reprogramar a otra fecha…',
				icon: 'calendar-clock',
				group: 'date',
			},
		);
		if (task.date !== null) {
			items.push({
				kind: 'rescheduleClear',
				title: 'Quitar la fecha',
				icon: 'calendar-x',
				group: 'date',
			});
		}
	}

	items.push({
		kind: 'cancel',
		title: 'Cancelar la tarea',
		icon: 'ban',
		group: 'state',
		warning: true,
	});

	const subtask = task.parentId !== null;

	if (!subtask) {
		items.push({ kind: 'moveToList', title: 'Mover a otra lista…', icon: 'list', group: 'place' });
		if (task.list !== null) {
			items.push({
				kind: 'clearList',
				title: 'Quitar de la lista',
				icon: 'list-x',
				group: 'place',
			});
			items.push({
				kind: 'setSection',
				title: 'Mover a otra sección…',
				icon: 'layout-list',
				group: 'place',
			});
		}
		if (task.section !== null) {
			items.push({ kind: 'clearSection', title: 'Quitar de la sección', icon: 'x', group: 'place' });
		}

		items.push({ kind: 'addSubtask', title: 'Añadir subtarea…', icon: 'plus', group: 'subtasks' });
		if ((task.subtasks ?? []).length > 0) {
			items.push({
				kind: 'completeSubtask',
				title: 'Completar una subtarea…',
				icon: 'check',
				group: 'subtasks',
			});
		}
	}

	return items;
}

/**
 * Los nombres de sección que la superficie ya conoce, para poblar el selector
 * sin gastar ninguna petición.
 *
 * Salen de las tareas que ya están pintadas (`task.section`, que viene DENTRO de
 * cada tarea), filtradas por la lista de la tarea que se está moviendo: las
 * secciones de otra lista no son destinos válidos. Sin repetidos y en el orden
 * en que aparecen, que es el que el usuario está viendo.
 */
export function sectionNamesFor(
	tasks: readonly LumbreTask[],
	listId: string | null,
): string[] {
	if (listId === null) return [];
	const names: string[] = [];
	for (const task of tasks) {
		if (task.list?.id !== listId) continue;
		const name = task.section?.name;
		if (name === undefined || names.includes(name)) continue;
		names.push(name);
	}
	return names;
}
