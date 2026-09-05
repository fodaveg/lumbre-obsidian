/**
 * El CONTEXTO de una tarea que se pinta bajo su título con `context: full`: el
 * chip de estado, el extracto de las notas y la forma de sus subtareas.
 *
 * Módulo puro: no importa `obsidian` y no hace red. El pintado en el DOM vive
 * en `task-block.ts`; aquí solo está lo que se puede probar sin montar nada.
 *
 * HECHO MEDIDO (repo de Lumbre, `src/routes/api/tasks/+server.ts`, SHA
 * `543017e271a526ba4257424bcb3977d264643e9b`, JSDoc de `?ids=` alrededor de la
 * línea 146): `?ids=` NO adjunta `subtasks` a propósito («A DIFERENCIA de
 * `id`, NO adjunta `subtasks`... en un lote de hasta 200 infla la respuesta
 * justo en el camino que este parámetro existe para adelgazar»). Solo
 * `?id=` las trae, y solo para tareas de primer nivel. Pedir una petición por
 * tarea para un bloque de 200 filas reventaría el cubo de 120/min de
 * `GET /api/tasks` (`TASKS_RATE_LIMIT`, `src/lumbre/client.ts`), así que
 * `QueryCache` limita el lookup de subtareas a las primeras
 * `CONTEXT_SUBTASK_TASK_CAP` tareas de primer nivel de la lectura, y el bloque
 * lo dice en el pie cuando recorta (ver `contextSubtasksLimitedNote`).
 */

import type { LumbreSubtask, LumbreTask } from '../lumbre/types';

/** Tope de caracteres del extracto de notas que se pinta bajo el título. */
export const TASK_CONTEXT_NOTE_MAX_CHARS = 200;

/** Tope de líneas del mismo extracto. Lo que llegue primero recorta. */
export const TASK_CONTEXT_NOTE_MAX_LINES = 3;

/**
 * Cuántas tareas de primer nivel de una lectura piden subtareas por su propio
 * `getTask(id)`. Ver el HECHO MEDIDO de la cabecera: no hay forma barata de
 * pedir subtareas en lote, así que el tope existe para no reventar el cubo de
 * `GET /api/tasks` con un bloque de muchas filas.
 */
export const CONTEXT_SUBTASK_TASK_CAP = 20;

/**
 * El extracto de las notas de una tarea: las primeras `TASK_CONTEXT_NOTE_MAX_LINES`
 * líneas, recortadas además a `TASK_CONTEXT_NOTE_MAX_CHARS` caracteres, con
 * «…» si se recortó por cualquiera de los dos motivos. `null` sin notas o con
 * notas en blanco: ahí no se pinta nada bajo el título.
 *
 * Texto siempre EN CLARO: quien lo pinte lo hace con `textContent`, nunca con
 * Markdown renderizado (`CLAUDE.md`: el token y el contenido de una nota no
 * son lo mismo, pero el mismo cuidado de "no interpretar lo que escribió el
 * usuario" aplica aquí).
 */
export function noteExcerpt(notes: string | null): string | null {
	if (notes === null) return null;
	const trimmed = notes.trim();
	if (trimmed.length === 0) return null;

	const lines = trimmed.split('\n');
	const truncatedByLines = lines.length > TASK_CONTEXT_NOTE_MAX_LINES;
	let excerpt = lines.slice(0, TASK_CONTEXT_NOTE_MAX_LINES).join('\n');

	const truncatedByChars = excerpt.length > TASK_CONTEXT_NOTE_MAX_CHARS;
	if (truncatedByChars) excerpt = excerpt.slice(0, TASK_CONTEXT_NOTE_MAX_CHARS);

	return truncatedByLines || truncatedByChars ? `${excerpt}…` : excerpt;
}

/**
 * La etiqueta de estado que se pinta bajo el título con `context: full`, o
 * `null` en una pendiente (que no lleva chip, es ruido). Reutiliza
 * `taskStateLabels` (cancelada/archivada, mismo texto que el panel) y añade
 * "Completada" para el único caso que ese módulo no cubre: el panel no lo
 * necesita porque ya pinta la casilla marcada, pero aquí no hay casilla que
 * mirar para saberlo de un vistazo.
 */
export function contextStateLabel(task: Pick<LumbreTask, 'done' | 'cancelledAt' | 'archivedAt'>): string | null {
	if (task.cancelledAt !== null) return 'Cancelada';
	if (task.archivedAt !== null) return 'Archivada';
	return task.done ? 'Completada' : null;
}

/** Un carácter que dice si una subtarea está hecha, sin ser una casilla interactiva. */
export function subtaskGlyph(subtask: Pick<LumbreSubtask, 'done'>): string {
	return subtask.done ? '✓' : '○';
}

/**
 * Las subtareas de una tarea, en el orden en que las sirvió Lumbre (ya es el
 * orden de la checklist), o `null` si no tiene ninguna. `undefined` en
 * `task.subtasks` significa "no se pidieron o no las trae este servidor", que
 * aquí se trata igual que "no tiene": no hay nada que distinguir para pintar.
 */
export function subtaskItems(task: Pick<LumbreTask, 'subtasks'>): LumbreSubtask[] | null {
	if (task.subtasks === undefined || task.subtasks.length === 0) return null;
	return task.subtasks;
}
