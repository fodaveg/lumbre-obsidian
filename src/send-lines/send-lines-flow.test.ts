import { describe, expect, it, vi } from 'vitest';

import type { LumbreTaskLink } from '../links/link-store';
import { MAX_BATCH_OPS, type BatchOperation } from '../lumbre/client';
import type { BatchQueuedOperation, LinkTarget, QueuedOperation } from '../lumbre/queue';
import type { LumbreTask } from '../lumbre/types';
import { sendLinesAsTasks, titlesToBatches, type LineBatch, type SendLinesDeps } from './send-lines-flow';

const TARGET: LinkTarget = {
	notePath: 'Proyectos/Cocina.md',
	label: 'Cocina',
	excerpt: null,
};

/** El único lote de un envío que se sabe de un solo trozo, o lanza. */
function onlyBatch(batches: readonly LineBatch[]): LineBatch {
	if (batches.length !== 1) throw new Error(`se esperaba UN lote, hay ${batches.length}`);
	return batches[0] as LineBatch;
}

/** Estrecha una `BatchOperation` a su variante `create`, o lanza. */
function asCreate(op: BatchOperation): Extract<BatchOperation, { type: 'create' }> {
	if (op.type !== 'create') throw new Error(`se esperaba "create", llegó "${op.type}"`);
	return op;
}

// ── titlesToBatches ──────────────────────────────────────────────────────

describe('titlesToBatches', () => {
	it('un título da UNA op de create con la lista de la nota', () => {
		const { batches, total } = titlesToBatches(['Comprar pan'], 'list-1');
		expect(total).toBe(1);
		const batch = onlyBatch(batches);
		expect(batch.ops).toHaveLength(1);
		const op = asCreate(batch.ops[0] as BatchOperation);
		expect(op.draft.title).toBe('Comprar pan');
		expect(op.draft.listId).toBe('list-1');
		expect(batch.createdTaskIds).toEqual([op.clientTaskId]);
	});

	it('sin lista de nota no manda listId', () => {
		const { batches } = titlesToBatches(['Comprar pan'], null);
		const op = asCreate(onlyBatch(batches).ops[0] as BatchOperation);
		expect(op.draft.listId).toBeUndefined();
	});

	it('varias líneas dan una op por línea, en el MISMO orden', () => {
		const { batches, total } = titlesToBatches(['Uno', 'Dos', 'Tres'], null);
		expect(total).toBe(3);
		const titles = onlyBatch(batches).ops.map((op) => asCreate(op).draft.title);
		expect(titles).toEqual(['Uno', 'Dos', 'Tres']);
	});

	it('cada línea tiene un clientTaskId distinto', () => {
		const { batches } = titlesToBatches(['Uno', 'Dos', 'Tres'], null);
		const ids = onlyBatch(batches).ops.map((op) => asCreate(op).clientTaskId);
		expect(new Set(ids).size).toBe(3);
	});

	it('una selección de más de MAX_BATCH_OPS líneas se trocea en varios lotes', () => {
		const titles = Array.from({ length: MAX_BATCH_OPS + 50 }, (_, index) => `Tarea ${index}`);
		const { batches, total } = titlesToBatches(titles, null);
		expect(total).toBe(MAX_BATCH_OPS + 50);
		expect(batches).toHaveLength(2);
		expect(batches.map((batch) => batch.ops.length)).toEqual([MAX_BATCH_OPS, 50]);
	});

	it('sin títulos no hay ningún lote', () => {
		const { batches, total } = titlesToBatches([], null);
		expect(batches).toEqual([]);
		expect(total).toBe(0);
	});
});

// ── sendLinesAsTasks ─────────────────────────────────────────────────────

/** Una `BatchQueuedOperation` ya materializada, tal y como la devolvería `enqueueBatch`. */
function queuedBatch(id: string, batch: LineBatch, overrides: Partial<BatchQueuedOperation> = {}): BatchQueuedOperation {
	return {
		id,
		deviceId: 'device-a',
		state: 'materialized',
		attempts: 0,
		error: null,
		createdAt: 'now',
		updatedAt: 'now',
		sentAt: 'now',
		kind: 'batch',
		ops: batch.ops,
		createdTaskIds: batch.createdTaskIds,
		target: TARGET,
		failedItems: [],
		...overrides,
	};
}

/** Deps con dobles en memoria: `enqueueBatch` numera los lotes en orden de llegada. */
function fakeDeps(after: (queued: BatchQueuedOperation[]) => QueuedOperation[]): {
	deps: SendLinesDeps;
	linked: LumbreTask[];
} {
	const queued: BatchQueuedOperation[] = [];
	const linked: LumbreTask[] = [];
	const deps: SendLinesDeps = {
		queue: {
			enqueueBatch: vi.fn(
				async (ops: BatchOperation[], createdTaskIds: string[], target: LinkTarget) => {
					const operation = queuedBatch(`batch-${queued.length}`, { ops, createdTaskIds }, { target });
					queued.push(operation);
					return operation;
				},
			),
			flush: vi.fn(async () => undefined),
			snapshot: vi.fn(() => after(queued)),
		},
		links: {
			link: vi.fn(async (_path: string, task: LumbreTask): Promise<LumbreTaskLink> => {
				linked.push(task);
				return {
					id: task.id,
					taskId: task.id,
					notePath: TARGET.notePath,
					label: TARGET.label,
					excerpt: null,
					task,
					syncState: 'pending_local',
					error: null,
					updatedAt: 'now',
					orphanedAt: null,
				};
			}),
		},
	};
	return { deps, linked };
}

describe('sendLinesAsTasks', () => {
	it('encola un único lote y vincula cada alta a la nota', async () => {
		const { batches, total } = titlesToBatches(['Comprar pan', 'Llamar a Ana'], 'list-1');
		const { deps, linked } = fakeDeps((queued) => queued);

		const outcome = await sendLinesAsTasks(deps, batches, TARGET, { id: 'list-1', name: 'Cocina' });

		expect(outcome).toEqual({ total, rejected: [], failed: [] });
		expect(deps.queue.enqueueBatch).toHaveBeenCalledTimes(1);
		expect(deps.queue.flush).toHaveBeenCalledTimes(1);
		expect(linked).toHaveLength(2);
		expect(linked.map((task) => task.content)).toEqual(['Comprar pan', 'Llamar a Ana']);
		expect(linked.every((task) => task.list?.id === 'list-1')).toBe(true);
	});

	it('sin nota (target.notePath vacío) no vincula nada', async () => {
		const { batches } = titlesToBatches(['Comprar pan'], null);
		const { deps, linked } = fakeDeps((queued) => queued);
		const noNote: LinkTarget = { notePath: '', label: 'Sin nota', excerpt: null };

		await sendLinesAsTasks(deps, batches, noNote, null);

		expect(deps.links.link).not.toHaveBeenCalled();
		expect(linked).toHaveLength(0);
	});

	it('encola un lote por trozo, en orden, para una selección de más de MAX_BATCH_OPS líneas', async () => {
		const titles = Array.from({ length: MAX_BATCH_OPS + 10 }, (_, index) => `Tarea ${index}`);
		const { batches } = titlesToBatches(titles, null);
		const { deps } = fakeDeps((queued) => queued);

		const outcome = await sendLinesAsTasks(deps, batches, TARGET, null);

		expect(deps.queue.enqueueBatch).toHaveBeenCalledTimes(2);
		expect(outcome.total).toBe(MAX_BATCH_OPS + 10);
		expect(outcome.rejected).toEqual([]);
		expect(outcome.failed).toEqual([]);
	});

	it('un lote rechazado ENTERO sale en "rejected", con el motivo del servidor', async () => {
		const { batches } = titlesToBatches(['Comprar pan'], null);
		const { deps } = fakeDeps((queued) =>
			queued.map((operation) => ({ ...operation, state: 'rejected', error: 'sin token' })),
		);

		const outcome = await sendLinesAsTasks(deps, batches, TARGET, null);

		expect(outcome.rejected).toEqual(['sin token']);
	});

	it('el éxito parcial de un lote sale en "failed", con el índice DENTRO del envío entero', async () => {
		const titles = Array.from({ length: MAX_BATCH_OPS + 5 }, (_, index) => `Tarea ${index}`);
		const { batches } = titlesToBatches(titles, null);
		const { deps } = fakeDeps((queued) =>
			queued.map((operation, position) =>
				position === 1
					? { ...operation, failedItems: [{ index: 2, error: 'título duplicado' }] }
					: operation,
			),
		);

		const outcome = await sendLinesAsTasks(deps, batches, TARGET, null);

		// El segundo lote empieza en la posición MAX_BATCH_OPS del envío entero.
		expect(outcome.failed).toEqual([{ index: MAX_BATCH_OPS + 2, error: 'título duplicado' }]);
		expect(outcome.rejected).toEqual([]);
	});
});
