/**
 * Qué mutación y qué comprobación compone cada acción del menú por tarea.
 *
 * Módulo puro: no importa `obsidian` y no hace red. Devuelve `TaskMutationPlan`,
 * que es justo lo que `OperationQueue.enqueueMutation` necesita (la `MutationOp`
 * verbatim y el `MutationCheck` que la confirma releyendo), más una etiqueta fija
 * para el registro.
 *
 * Está separado del menú porque es la parte que se puede equivocar en silencio:
 * un `check` que no case con lo que se manda deja la operación dando vueltas
 * hasta agotar los intentos aunque Lumbre la haya aplicado bien. Aquí se
 * empareja op con comprobación una sola vez, se prueba objeto a objeto
 * (`task-menu-ops.test.ts`) y el menú solo elige cuál llamar.
 *
 * La etiqueta `action` es SIEMPRE texto fijo: va al registro, y ahí no entra el
 * título de una tarea ni el nombre de una lista.
 */

import type { MutationOp } from '../lumbre/client';
import type { MutationCheck } from '../lumbre/queue';
import type { LumbreSubtask, LumbreTask } from '../lumbre/types';

/**
 * Cuántas subtareas acepta un `addSubtask`. Lo impone Lumbre; de más se
 * DESCARTAN aquí, para no mandar un payload que el servidor va a recortar por su
 * cuenta y dejar el `check` pidiendo títulos que nunca van a estar.
 */
export const MAX_SUBTASKS_PER_OP = 50;

/**
 * Cuántos caracteres acepta el título de una subtarea. Lumbre lo TRUNCA en vez
 * de rechazarlo, así que el título se recorta también aquí: el `check` tiene que
 * llevar el texto que se espera LEER, no el que se escribió (ver el JSDoc del
 * caso `subtasksInclude` en `queue.ts`).
 */
export const MAX_SUBTASK_LENGTH = 500;

/** Una acción del menú ya resuelta: qué se manda, cómo se confirma y qué se apunta. */
export interface TaskMutationPlan {
	/** Para el registro. Texto FIJO, nunca del usuario. */
	action: string;
	/** La mutación tal cual viaja a `POST /api/mutations`. */
	op: MutationOp;
	/** Qué relee la cola cuando el `outcome` no basta. */
	check: MutationCheck;
}

/**
 * Reprograma la tarea al día `date`, o la deja SIN fecha con `null`.
 *
 * `date` es obligatorio en el payload aunque vaya `null`: el endpoint no tiene
 * valor por defecto. Y sin fecha la tarea queda en "En cualquier momento", NO en
 * "Algún día": no hay ninguna op que ponga `someday`, así que el menú no ofrece
 * ese destino (ver `task-menu-items.ts`).
 */
export function rescheduleOp(task: LumbreTask, date: string | null): TaskMutationPlan {
	return {
		action: date === null ? 'quitar la fecha' : 'reprogramar tarea',
		op: { op: 'reschedule', taskId: task.id, date },
		check: { check: 'taskField', taskId: task.id, field: 'date', expected: date },
	};
}

/**
 * Cancela la tarea. `cancelled` viaja SIEMPRE: el endpoint lo exige y no asume
 * `true`.
 *
 * Se confirma por PRESENCIA de `cancelledAt`, cuyo valor lo pone el servidor y
 * el plugin no puede predecir.
 */
export function cancelOp(task: LumbreTask): TaskMutationPlan {
	return {
		action: 'cancelar tarea',
		op: { op: 'cancel', taskId: task.id, cancelled: true },
		check: { check: 'taskFieldSet', taskId: task.id, field: 'cancelledAt', set: true },
	};
}

/**
 * Restaura una tarea cancelada. El payload no lleva nada más que el objetivo, y
 * la comprobación es la gemela de `cancelOp`: `cancelledAt` tiene que quedar
 * VACÍO.
 */
export function restoreOp(task: LumbreTask): TaskMutationPlan {
	return {
		action: 'restaurar tarea',
		op: { op: 'restore', taskId: task.id },
		check: { check: 'taskFieldSet', taskId: task.id, field: 'cancelledAt', set: false },
	};
}

/**
 * Mueve la tarea a la lista `listId`, o la DESVINCULA de su lista con `null`.
 *
 * Siempre por id y nunca por nombre: el nombre CREA la lista si no existe, y
 * crear listas desde este menú no es lo que se pidió. El selector de lista sale
 * del catálogo (`ListCache`), así que el id está siempre a mano.
 */
export function moveToListOp(task: LumbreTask, listId: string | null): TaskMutationPlan {
	return {
		action: listId === null ? 'quitar de la lista' : 'mover a otra lista',
		op: { op: 'moveToList', taskId: task.id, listId },
		check: { check: 'taskRef', taskId: task.id, field: 'list', by: 'id', expected: listId },
	};
}

/**
 * Mueve la tarea a la sección `section` de su lista, o la saca de la sección con
 * `null`.
 *
 * La sección va por NOMBRE, que es lo único que acepta el endpoint, y por eso la
 * comprobación compara `by: 'name'`.
 */
export function setSectionOp(task: LumbreTask, section: string | null): TaskMutationPlan {
	return {
		action: section === null ? 'quitar de la sección' : 'mover a otra sección',
		op: { op: 'setSection', taskId: task.id, section },
		check: { check: 'taskRef', taskId: task.id, field: 'section', by: 'name', expected: section },
	};
}

/**
 * Los títulos de subtarea que de verdad se pueden mandar, en el orden en que se
 * escribieron: recortados por los dos lados, sin líneas vacías, truncados al
 * tope de caracteres y cortados al tope de subtareas.
 *
 * Es el MISMO texto que luego se espera leer en la relectura, y de ahí que el
 * truncado ocurra aquí y no en el servidor: un título más largo que el tope se
 * guardaría recortado en Lumbre y el `check` lo buscaría entero, sin encontrarlo
 * nunca.
 */
export function subtaskTitles(raw: readonly string[]): string[] {
	const titles: string[] = [];
	for (const line of raw) {
		const title = line.trim();
		if (title.length === 0) continue;
		titles.push(title.slice(0, MAX_SUBTASK_LENGTH));
		if (titles.length === MAX_SUBTASKS_PER_OP) break;
	}
	return titles;
}

/**
 * Añade subtareas al padre, o `null` si no quedaba ningún título que mandar
 * (solo líneas vacías): sin esto se encolaría un `addSubtask` con el array
 * vacío, que no hace nada y además no se podría confirmar.
 *
 * `addSubtask` NO es idempotente, así que esto se llama UNA vez por gesto del
 * usuario. El reintento no vuelve a enviar, relee (lo hace la cola).
 */
export function addSubtasksOp(
	task: LumbreTask,
	raw: readonly string[],
): TaskMutationPlan | null {
	const titles = subtaskTitles(raw);
	if (titles.length === 0) return null;
	return {
		action: 'añadir subtareas',
		op: { op: 'addSubtask', taskId: task.id, subtasks: titles },
		check: { check: 'subtasksInclude', parentId: task.id, titles },
	};
}

/**
 * Completa o reabre UNA subtarea. La op va contra el id de la SUBTAREA, no
 * contra el del padre; la relectura, en cambio, relee el PADRE, porque una
 * subtarea no aparece en un `getTask` por su propio id.
 */
export function completeSubtaskOp(
	task: LumbreTask,
	subtask: LumbreSubtask,
	done: boolean,
): TaskMutationPlan {
	return {
		action: done ? 'completar subtarea' : 'reabrir subtarea',
		op: { op: 'completeSubtask', subtaskId: subtask.id, done },
		check: { check: 'subtaskDone', parentId: task.id, subtaskId: subtask.id, done },
	};
}

/**
 * `YYYY-MM-DD` de `date` en hora LOCAL, no UTC: "hoy" es el día que ve quien
 * abre el menú, y `toISOString()` lo cambiaría de día en media Europa a partir
 * de las 22:00.
 */
export function localIsoDate(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

/**
 * El día de `now` más `days` días, en `YYYY-MM-DD` local. Se construye con el
 * constructor de `Date` por componentes, que ya normaliza el desborde de mes y
 * de año, y así "mañana" cruza bien el 31 de diciembre.
 */
export function isoDatePlusDays(now: Date, days: number): string {
	return localIsoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days));
}
