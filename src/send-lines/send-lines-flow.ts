/**
 * «Enviar como tareas»: de las líneas ya limpias (`linesFromSelection`,
 * `src/ui/draft-from-editor.ts`) a un `create` por línea, en lotes de
 * `POST /api/batch`, con el vínculo local de cada alta y el informe de lo que
 * Lumbre haya rechazado.
 *
 * Gemelo de `applySoploPlanUnguarded` (`src/main.ts`), simplificado: aquí no
 * hay nada que traducir ni que saltar (no hay BRL, hábitos ni mutaciones),
 * solo altas con la MISMA lista para todas, la de la nota.
 *
 * Módulo puro: no importa `obsidian`. `queue` y `links` entran por `Pick`,
 * igual que en `WeeklySnapshotDeps` (`src/review/weekly-snapshot.ts`), así que
 * se prueba entero con dobles en memoria.
 */

import type { LinkStore } from '../links/link-store';
import { MAX_BATCH_OPS, type BatchOperation } from '../lumbre/client';
import {
	type BatchQueuedOperation,
	type LinkTarget,
	type OperationQueue,
	type QueuedOperation,
} from '../lumbre/queue';
import { taskFromDraft, type LumbreRef, type TaskDraft } from '../lumbre/types';

/** Un trozo del envío que cabe en UNA llamada a `POST /api/batch`. */
export interface LineBatch {
	ops: BatchOperation[];
	/** Los ids que CREA este trozo. Aquí TODAS las ops crean uno. */
	createdTaskIds: string[];
}

/** El envío repartido en lotes, más cuántas tareas hay en total. */
export interface LineBatches {
	batches: LineBatch[];
	total: number;
}

/**
 * Un `create` por título, con la MISMA lista para todos (la de la nota, o
 * ninguna si no está vinculada), trocheado al tope de `POST /api/batch`
 * (`MAX_BATCH_OPS`, hoy 200): una selección más larga se rechazaría entera de
 * mandarse en una sola llamada.
 *
 * El id de cada tarea lo fija aquí `crypto.randomUUID()`, igual que
 * `OperationQueue.enqueueCreate`: hace idempotente un reenvío y deja vincular
 * la nota a la tarea ANTES de que Lumbre la materialice.
 */
export function titlesToBatches(titles: readonly string[], listId: string | null): LineBatches {
	const created = titles.map((title) => {
		const draft: TaskDraft = { title };
		if (listId !== null) draft.listId = listId;
		const clientTaskId = crypto.randomUUID();
		const op: BatchOperation = { type: 'create', clientTaskId, draft };
		return { op, clientTaskId };
	});

	const batches: LineBatch[] = [];
	for (let start = 0; start < created.length; start += MAX_BATCH_OPS) {
		const chunk = created.slice(start, start + MAX_BATCH_OPS);
		batches.push({
			ops: chunk.map((entry) => entry.op),
			createdTaskIds: chunk.map((entry) => entry.clientTaskId),
		});
	}

	return { batches, total: created.length };
}

export interface SendLinesDeps {
	queue: Pick<OperationQueue, 'enqueueBatch' | 'flush' | 'snapshot'>;
	links: Pick<LinkStore, 'link'>;
}

/** Un lote entero, o una línea suelta dentro de él, que Lumbre no aceptó. */
export interface SendLinesOutcome {
	/** Cuántas líneas se han intentado enviar. */
	total: number;
	/**
	 * Motivo de Lumbre cuando un LOTE ENTERO se ha rechazado. Normalmente vacío:
	 * un lote ya viene trocheado al tope del servidor, así que lo esperable es un
	 * 200 con éxito parcial, no un rechazo entero.
	 */
	rejected: string[];
	/**
	 * Líneas concretas que Lumbre no ha aceptado DENTRO de un lote que sí aceptó
	 * el resto. `index` es la posición dentro del envío ENTERO (todos los
	 * lotes seguidos), no dentro de su lote.
	 */
	failed: { index: number; error: string | null }[];
}

/**
 * Encola los lotes, vincula cada alta a la nota en pendiente (si hay nota:
 * `target.notePath` vacío es "sin nota", igual que en `sendDraft`) y drena.
 * El texto de la nota NO se toca: lo único que queda en el vault es el mapa
 * de `data.json`, igual que al enviar una sola tarea.
 */
export async function sendLinesAsTasks(
	deps: SendLinesDeps,
	batches: readonly LineBatch[],
	target: LinkTarget,
	listRef: LumbreRef | null,
): Promise<SendLinesOutcome> {
	const total = batches.reduce((count, batch) => count + batch.ops.length, 0);

	const queued: BatchQueuedOperation[] = [];
	for (const batch of batches) {
		queued.push(await deps.queue.enqueueBatch(batch.ops, batch.createdTaskIds, target));
	}

	if (target.notePath.length > 0) {
		for (const batch of batches) {
			for (const op of batch.ops) {
				if (op.type !== 'create') continue;
				await deps.links.link(
					target.notePath,
					taskFromDraft(op.draft, op.clientTaskId, listRef),
					{ label: target.label, excerpt: null },
					'pending_local',
				);
			}
		}
	}

	await deps.queue.flush();
	return { total, ...outcomeOf(deps.queue.snapshot(), queued, batches) };
}

/**
 * Gemela de `reportSoploOutcome` (`src/main.ts`), sin el efecto de avisar: eso
 * es cosa de `main.ts`, que es quien puede crear un `Notice`.
 */
function outcomeOf(
	after: readonly QueuedOperation[],
	queued: readonly BatchQueuedOperation[],
	batches: readonly LineBatch[],
): Pick<SendLinesOutcome, 'rejected' | 'failed'> {
	const rejected: string[] = [];
	const failed: { index: number; error: string | null }[] = [];
	let offset = 0;

	for (const [position, operation] of queued.entries()) {
		const current = after.find((candidate) => candidate.id === operation.id);
		if (current?.state === 'rejected') rejected.push(current.error ?? 'Lumbre rechazó el envío.');

		const items = current?.kind === 'batch' ? (current.failedItems ?? []) : [];
		for (const item of items) failed.push({ index: offset + item.index, error: item.error });
		offset += batches[position]?.ops.length ?? 0;
	}

	return { rejected, failed };
}
