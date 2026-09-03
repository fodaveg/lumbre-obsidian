/**
 * Del plan de Soplo a las operaciones de `POST /api/batch`.
 *
 * Módulo puro: no importa `obsidian` y no hace red.
 *
 * La regla que manda sobre todo lo de aquí: **la IA propone y el usuario
 * confirma**. El plan llega de `POST /api/agent`, que corre siempre en modo
 * previsualización y no ha encolado nada; lo único que se aplica es lo que el
 * usuario dejó marcado en el modal.
 *
 * De ahí dos decisiones:
 *
 * - Se traduce por ÍNDICE. El servidor construye el `preview` con un `map`
 *   sobre el `plan`, así que la línea que se leyó y la acción que se aplica son
 *   la misma posición. Cualquier otra correspondencia (por `taskId`, por texto)
 *   confundiría dos altas iguales.
 * - Las mutaciones viajan VERBATIM (`mutateRaw`). El `kind` y el `payload` los
 *   escribió Lumbre al planificar y son justo lo que describía la línea que el
 *   usuario aprobó; traducirlos a la `MutationOp` del plugin recortaría los
 *   campos que el plugin todavía no modela, o sea aplicaría algo distinto.
 */

import { MAX_BATCH_OPS, type AgentPlanOp, type BatchOperation } from '../lumbre/client';
import type { TaskDraft } from '../lumbre/types';

/** Lo que sale de traducir un plan: las ops y qué tareas van a nacer. */
export interface PlanOps {
	ops: BatchOperation[];
	/**
	 * Ids de las tareas que el lote CREA. Los fija el plan (el servidor los
	 * pregenera para poder deshacer), así que se pueden releer y vincular a la
	 * nota antes de que Lumbre las materialice.
	 */
	createdTaskIds: string[];
	/**
	 * Cuántas acciones marcadas se han quedado FUERA por no saber traducirlas.
	 * Hoy son las del BRL y las de hábitos: `POST /api/batch` solo entiende de
	 * tareas. Se cuenta para poder decírselo al usuario en vez de tragárselo.
	 */
	skipped: number;
}

/**
 * Las ops de las acciones MARCADAS.
 *
 * `checked[i]` corresponde a `plan[i]`. Un índice sin entrada en `checked` se
 * trata como desmarcado: ante la duda no se aplica nada.
 */
export function planToOps(plan: readonly AgentPlanOp[], checked: readonly boolean[]): PlanOps {
	const ops: BatchOperation[] = [];
	const createdTaskIds: string[] = [];
	let skipped = 0;

	for (const [index, action] of plan.entries()) {
		if (checked[index] !== true) continue;

		const translated = translateAction(action);
		if (translated === null) {
			skipped += 1;
			continue;
		}
		ops.push(translated);
		if (translated.type === 'create') createdTaskIds.push(translated.clientTaskId);
	}

	return { ops, createdTaskIds, skipped };
}

/** Un trozo del plan que cabe en UNA llamada a `POST /api/batch`. */
export interface PlanBatch {
	ops: BatchOperation[];
	/** Los ids que CREA este trozo, no los del plan entero. */
	createdTaskIds: string[];
}

/** El plan repartido en lotes, más lo que no se ha podido traducir. */
export interface PlanBatches {
	batches: PlanBatch[];
	/** Cuántas ops hay en total, sumando los lotes. */
	total: number;
	skipped: number;
}

/**
 * Lo mismo que `planToOps`, pero TROCEADO al tope de `POST /api/batch`.
 *
 * El servidor rechaza con `bad_request` un lote de más de `MAX_BATCH_OPS`
 * operaciones, y ese rechazo es del lote ENTERO: un plan largo se quedaba
 * `rejected` sin aplicar nada, con los vínculos de sus altas ya creados en la
 * nota apuntando a tareas que no existían.
 *
 * Trocear no rompe nada que la vía de un solo lote garantizara: `/api/batch` NO
 * es atómico (responde 200 con el informe por operación, y de ahí sale
 * `failedItems`), y los trozos se encolan y se envían EN ORDEN, así que un alta
 * sigue yendo delante de la mutación que la toque.
 */
export function planToBatches(
	plan: readonly AgentPlanOp[],
	checked: readonly boolean[],
): PlanBatches {
	const { ops, skipped } = planToOps(plan, checked);
	const batches: PlanBatch[] = [];

	for (let start = 0; start < ops.length; start += MAX_BATCH_OPS) {
		const chunk = ops.slice(start, start + MAX_BATCH_OPS);
		batches.push({
			ops: chunk,
			createdTaskIds: chunk
				.filter((op) => op.type === 'create')
				.map((op) => op.clientTaskId),
		});
	}

	return { batches, total: ops.length, skipped };
}

/** Una acción del plan a su op de batch, o `null` si no se puede traducir. */
function translateAction(action: AgentPlanOp): BatchOperation | null {
	if (action.op === 'add') return createFromAdd(action);
	if (action.op === 'mutation') return mutateFromAction(action);
	// `brl` y `habit` no son tareas y `POST /api/batch` no las acepta. Se cuentan
	// como saltadas en vez de inventarles una traducción.
	return null;
}

/**
 * Un `add` del plan a un `create`. El `id` del plan es el que TENDRÁ la tarea,
 * igual que un `clientTaskId`: reenviar el mismo lote no crea una segunda.
 */
function createFromAdd(action: AgentPlanOp): BatchOperation | null {
	const clientTaskId = asString(action['id']);
	const title = asString(action['content']);
	if (clientTaskId === null || title === null || title.length === 0) return null;

	const extra = asRecord(action['extra']) ?? {};
	const draft: TaskDraft = { title };
	assign(draft, 'listId', asString(action['listId']));
	assign(draft, 'list', asString(action['list']));
	assign(draft, 'section', asString(extra['section']));
	assign(draft, 'date', asString(extra['date']));
	assign(draft, 'deadline', asString(extra['deadline']));
	assign(draft, 'time', asString(action['time']));
	assign(draft, 'notes', asString(action['notes']));
	if (extra['someday'] === true) draft.someday = true;

	const priority = priorityFromLevel(extra['priority']);
	if (priority !== null) draft.priority = priority;

	const subtasks = asStringArray(extra['subtasks']);
	if (subtasks.length > 0) draft.subtasks = subtasks;

	return { type: 'create', clientTaskId, draft };
}

/** Una `mutation` del plan, tal cual la escribió el servidor. */
function mutateFromAction(action: AgentPlanOp): BatchOperation | null {
	const taskId = asString(action['taskId']);
	const kind = asString(action['kind']);
	if (taskId === null || kind === null) return null;
	return { type: 'mutateRaw', taskId, kind, payload: asRecord(action['payload']) ?? {} };
}

function assign<K extends keyof TaskDraft>(
	draft: TaskDraft,
	key: K,
	value: TaskDraft[K] | null,
): void {
	if (value !== null) draft[key] = value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function asString(value: unknown): string | null {
	return typeof value === 'string' ? value : null;
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** El nivel numérico del plan (`1|2|3`) a la prioridad del borrador. */
function priorityFromLevel(level: unknown): TaskDraft['priority'] {
	if (level === 1) return 'p1';
	if (level === 2) return 'p2';
	if (level === 3) return 'p3';
	return null;
}
