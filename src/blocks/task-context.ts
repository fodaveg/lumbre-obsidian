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
 *
 * HECHO MEDIDO (26 sep 2026, cambio ya en producción en el servidor de
 * Lumbre): `GET /api/tasks` con `scope` `today`, `week`, `upcoming` u
 * `overdue` (y `/api/today`, `/api/upcoming`) devuelve también las subtareas
 * con fecha propia, como filas de PRIMER NIVEL con `parentId` y
 * `parentContent`. Con `context: full`, si la madre también está en el
 * listado, esa subtarea saldría dos veces (suelta y anidada bajo la madre) si
 * nadie la filtrara: eso es lo que resuelve `isSubtaskShownStandalone`.
 */

import type { LumbreSubtask, LumbreTask } from '../lumbre/types';
import type { TaskContextMode } from './query-parser';

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
 *
 * El recorte a `TASK_CONTEXT_NOTE_MAX_CHARS` es por PUNTOS DE CÓDIGO
 * (`Array.from`), no por unidades UTF-16 (`String.slice`): un emoji fuera del
 * plano básico son DOS unidades UTF-16 (un par sustituto), y cortar justo en
 * medio deja una mitad suelta, un carácter inválido pegado delante de la
 * elipsis (hallazgo de revisión, corregido antes de que llegara a producción).
 */
export function noteExcerpt(notes: string | null): string | null {
	if (notes === null) return null;
	const trimmed = notes.trim();
	if (trimmed.length === 0) return null;

	const lines = trimmed.split('\n');
	const truncatedByLines = lines.length > TASK_CONTEXT_NOTE_MAX_LINES;
	const limitedLines = lines.slice(0, TASK_CONTEXT_NOTE_MAX_LINES).join('\n');

	const codePoints = Array.from(limitedLines);
	const truncatedByChars = codePoints.length > TASK_CONTEXT_NOTE_MAX_CHARS;
	const excerpt = truncatedByChars
		? codePoints.slice(0, TASK_CONTEXT_NOTE_MAX_CHARS).join('')
		: limitedLines;

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

/**
 * Si una tarea con `parentId` (una subtarea con fecha propia, ver el HECHO
 * MEDIDO en el JSDoc de la cabecera y el de `LumbreTask.parentContent`) debe
 * pintarse SUELTA en el listado de primer nivel, o si se omite porque también
 * va a salir anidada bajo su madre (`renderTaskContext` + `subtaskItems`) y
 * pintarla dos veces sería un duplicado.
 *
 * Solo se omite si las TRES condiciones se cumplen a la vez: `context` es
 * `full`, la madre está entre `paintedTasks` (las tareas ya filtradas de este
 * bloque) y el `subtasks` de esa madre trae el id de esta subtarea. Si
 * cualquiera falla (sin `context: full`, la madre filtrada o fuera del
 * listado, o sus subtareas no traídas por el tope `CONTEXT_SUBTASK_TASK_CAP`),
 * se prefiere pintarla suelta a perderla.
 *
 * Una tarea de primer nivel (`parentId === null`) siempre se pinta: la regla
 * solo existe para subtareas.
 */
export function isSubtaskShownStandalone(
	task: Pick<LumbreTask, 'id' | 'parentId'>,
	context: TaskContextMode,
	paintedTasks: readonly Pick<LumbreTask, 'id' | 'subtasks'>[],
): boolean {
	if (task.parentId === null) return true;
	if (context !== 'full') return true;
	const parent = paintedTasks.find((candidate) => candidate.id === task.parentId);
	if (parent === undefined) return true;
	const subtasks = subtaskItems(parent);
	return subtasks === null || !subtasks.some((subtask) => subtask.id === task.id);
}

/**
 * El título tal y como se pinta cuando la tarea sale SUELTA: si es una
 * subtarea con `parentContent`, antepone `madre › ` para no perder de quién
 * es. Solo texto de presentación, nunca muta `task.content`.
 */
export function subtaskStandaloneTitle(task: Pick<LumbreTask, 'content' | 'parentContent'>): string {
	return task.parentContent !== null ? `${task.parentContent} › ${task.content}` : task.content;
}
