import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
	BatchOperation,
	BatchResultItem,
	BrlDay,
	ListLinkRow,
	ListLinkTarget,
	LumbreFailure,
	LumbreResult,
	MutationOp,
} from './client';
import { Logger } from '../diagnostics/logger';
import {
	describeFailedItems,
	MAX_ATTEMPTS,
	OperationQueue,
	RATE_LIMIT_BACKOFF_MS,
	type BatchQueuedOperation,
	type LinkTarget,
	type QueuedOperation,
	type QueueStorage,
} from './queue';
import type { LumbreTask, TaskDraft } from './types';

/** Promesa que se resuelve desde fuera, para parar un flush a media corrida. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = (): void => undefined;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const DEVICE = 'device-a';

const TARGET: LinkTarget = {
	notePath: 'Proyectos/Cocina.md',
	label: 'Comprar pan',
	excerpt: 'Lista de la compra',
};

function task(overrides: Partial<LumbreTask> = {}): LumbreTask {
	return {
		id: 'task-1',
		content: 'Comprar pan',
		notes: null,
		date: null,
		someday: false,
		deadline: null,
		time: null,
		priority: 'p4',
		done: false,
		cancelledAt: null,
		archivedAt: null,
		list: null,
		section: null,
		rolloverCount: 0,
		parentId: null,
		...overrides,
	};
}

/** Almacén en memoria con la misma forma que expone `PluginStore`. */
function memoryStorage(deviceId = DEVICE): QueueStorage & { operations: QueuedOperation[] } {
	return {
		deviceId,
		operations: [],
		readQueue(): QueuedOperation[] {
			return this.operations;
		},
		async writeQueue(operations: QueuedOperation[]): Promise<void> {
			this.operations = operations;
			await Promise.resolve();
		},
	};
}

/** Misma cola, otro dispositivo: es lo que ve el segundo equipo tras sincronizar. */
function asDevice(storage: QueueStorage, deviceId: string): QueueStorage {
	return {
		deviceId,
		readQueue: () => storage.readQueue(),
		writeQueue: (operations) => storage.writeQueue(operations),
	};
}

const OK: LumbreResult<void> = { ok: true, value: undefined };

function failure(reason: LumbreFailure['reason'], status?: number): LumbreFailure {
	return status === undefined ? { ok: false, reason } : { ok: false, reason, status };
}

/** Los métodos del cliente que usa la cola, cada uno espiable. */
function fakeClient() {
	return {
		createTask: vi.fn(
			async (_draft: TaskDraft, _clientTaskId: string): Promise<LumbreResult<void>> => OK,
		),
		mutate: vi.fn(async (_op: MutationOp): Promise<LumbreResult<void>> => OK),
		flush: vi.fn(async (): Promise<LumbreResult<void>> => OK),
		getTask: vi.fn(
			async (_id: string): Promise<LumbreResult<LumbreTask | null>> => ({
				ok: true,
				value: task(),
			}),
		),
		getTasksByIds: vi.fn(
			async (ids: string[]): Promise<LumbreResult<LumbreTask[]>> => ({
				ok: true,
				value: ids.map((id) => task({ id })),
			}),
		),
		batch: vi.fn(
			async (ops: BatchOperation[]): Promise<LumbreResult<BatchResultItem[]>> => ({
				ok: true,
				value: ops.map((_op, index) => ({ index, type: 'ingest' as const, ok: true })),
			}),
		),
		brlJson: vi.fn(
			async (date: string): Promise<LumbreResult<BrlDay>> => ({
				ok: true,
				value: { date, entries: [] },
			}),
		),
		listLink: vi.fn(async (_target: ListLinkTarget): Promise<LumbreResult<void>> => OK),
		listUnlink: vi.fn(async (_target: ListLinkTarget): Promise<LumbreResult<void>> => OK),
		listLinks: vi.fn(
			async (_listId: string): Promise<LumbreResult<ListLinkRow[]>> => ({ ok: true, value: [] }),
		),
	};
}

function queueWith(
	client: ReturnType<typeof fakeClient>,
	storage: QueueStorage,
	sleep = vi.fn(async (_ms: number): Promise<void> => undefined),
): OperationQueue {
	return new OperationQueue({ client, storage, sleep });
}

describe('OperationQueue: crear una tarea', () => {
	let storage: ReturnType<typeof memoryStorage>;

	beforeEach(() => {
		storage = memoryStorage();
	});

	it('encola en pending_local con un clientTaskId propio y el deviceId de este equipo', async () => {
		const queue = queueWith(fakeClient(), storage);

		const operation = await queue.enqueueCreate({ title: 'Comprar pan' }, TARGET);

		expect(operation.state).toBe('pending_local');
		expect(operation.deviceId).toBe(DEVICE);
		expect(operation.clientTaskId).toHaveLength(36);
		expect(operation.sentAt).toBeNull();
		expect(storage.operations).toHaveLength(1);
	});

	it('envía, relee y solo entonces marca materialized, sin guardar la tarea', async () => {
		const created = task({ id: 'creada' });
		const client = fakeClient();
		const queue = queueWith(client, storage);
		const operation = await queue.enqueueCreate({ title: 'Comprar pan' }, TARGET);
		client.getTask.mockResolvedValue({ ok: true, value: created });

		await queue.flush();

		expect(client.createTask).toHaveBeenCalledWith(
			{ title: 'Comprar pan' },
			operation.clientTaskId,
		);
		// `/api/ingest` ya drena antes de responder: un `client.flush()` detrás sería
		// una petición de más contra un endpoint limitado a 60/min.
		expect(client.flush).not.toHaveBeenCalled();
		expect(client.getTask).toHaveBeenCalledWith(operation.clientTaskId);
		const [stored] = storage.operations;
		expect(stored?.state).toBe('materialized');
		// El texto de la tarea NO se guarda: `data.json` viaja por Obsidian Sync.
		expect(stored).not.toHaveProperty('task');
		expect(stored?.materializedAt).not.toBeNull();
		expect(stored?.error).toBeNull();
	});

	it('si la relectura viene vacía, reintenta una vez tras esperar y deja sent con un intento más', async () => {
		const sleep = vi.fn(async (_ms: number): Promise<void> => undefined);
		const client = fakeClient();
		client.getTask.mockResolvedValue({ ok: true, value: null });
		const queue = queueWith(client, storage, sleep);
		await queue.enqueueCreate({ title: 'Comprar pan' }, TARGET);

		await queue.flush();

		expect(client.getTask).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledWith(1000);
		const [stored] = storage.operations;
		expect(stored?.state).toBe('sent');
		expect(stored?.attempts).toBe(1);
		expect(stored?.sentAt).not.toBeNull();
	});

	it('un create ya enviado NO se reenvía en el siguiente flush, solo se relee', async () => {
		const client = fakeClient();
		client.getTask.mockResolvedValue({ ok: true, value: null });
		const queue = queueWith(client, storage);
		await queue.enqueueCreate({ title: 'Comprar pan' }, TARGET);

		await queue.flush();
		expect(client.createTask).toHaveBeenCalledTimes(1);

		client.getTask.mockResolvedValue({ ok: true, value: task() });
		await queue.flush();

		expect(client.createTask).toHaveBeenCalledTimes(1);
		expect(storage.operations[0]?.state).toBe('materialized');
	});
});

describe('OperationQueue: completar una tarea', () => {
	it('manda un complete y confirma releyendo que done coincide', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		client.getTask.mockResolvedValue({ ok: true, value: task({ done: true }) });
		const queue = queueWith(client, storage);
		await queue.enqueueStatus('task-1', true, TARGET);

		await queue.flush();

		expect(client.mutate).toHaveBeenCalledWith({ op: 'complete', taskId: 'task-1', done: true });
		expect(storage.operations[0]?.state).toBe('materialized');
	});

	it('una tarea que sigue sin completar deja la operación en sent', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		const queue = queueWith(client, storage);
		await queue.enqueueStatus('task-1', true, TARGET);

		await queue.flush();

		expect(storage.operations[0]?.state).toBe('sent');
		expect(storage.operations[0]?.attempts).toBe(1);
	});

	// Reabrir una tarea que en Lumbre YA estaba abierta se confirma al instante:
	// la relectura ve `done: false`, que es lo que pedía la operación, y no hay
	// forma de saber si la mutación llegó a aplicarse. La única señal que lo
	// distinguiría es una marca de ÚLTIMA ESCRITURA de la tarea posterior al
	// `sentAt`, y `GET /api/tasks` no la sirve: `serializeTask` (repo de Lumbre)
	// devuelve `createdAt` y `notesUpdatedAt`, y ninguno se mueve al completar o
	// reabrir. Queda pendiente de que la API exponga un `updatedAt` de la fila.
	// Ver `matchesOperation` en `queue.ts`.
	it.todo('una relectura con `done` igual pero anterior al envío NO confirma');
});

describe('OperationQueue: fallos', () => {
	it('un 401 deja la operación rejected y no la reintenta', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		client.createTask.mockResolvedValue(failure('unauthorized', 401));
		const queue = queueWith(client, storage);
		await queue.enqueueCreate({ title: 'Comprar pan' }, TARGET);

		await queue.flush();
		expect(storage.operations[0]?.state).toBe('rejected');
		expect(storage.operations[0]?.attempts).toBe(0);
		expect(storage.operations[0]?.error).toContain('token');

		await queue.flush();
		expect(client.createTask).toHaveBeenCalledTimes(1);
	});

	it('un 400 también deja rejected', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		client.createTask.mockResolvedValue(failure('bad_request', 400));
		const queue = queueWith(client, storage);
		await queue.enqueueCreate({ title: '' }, TARGET);

		await queue.flush();

		expect(storage.operations[0]?.state).toBe('rejected');
	});

	it('un fallo de red deja recoverable_error y cuenta el intento', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		client.createTask.mockResolvedValue(failure('network'));
		const queue = queueWith(client, storage);
		await queue.enqueueCreate({ title: 'Comprar pan' }, TARGET);

		await queue.flush();
		expect(storage.operations[0]).toMatchObject({ state: 'recoverable_error', attempts: 1 });

		await queue.flush();
		expect(storage.operations[0]?.attempts).toBe(2);
	});

	it('a partir de MAX_ATTEMPTS deja de reintentarse solo', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		client.createTask.mockResolvedValue(failure('server', 500));
		const queue = queueWith(client, storage);
		await queue.enqueueCreate({ title: 'Comprar pan' }, TARGET);

		for (let i = 0; i < MAX_ATTEMPTS + 3; i += 1) await queue.flush();

		expect(storage.operations[0]?.attempts).toBe(MAX_ATTEMPTS);
		expect(client.createTask).toHaveBeenCalledTimes(MAX_ATTEMPTS);
	});

	it('un 429 para el flush entero y no toca la siguiente operación', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		client.createTask.mockResolvedValue(failure('rate_limited', 429));
		const queue = queueWith(client, storage);
		await queue.enqueueCreate({ title: 'Uno' }, TARGET);
		await queue.enqueueCreate({ title: 'Dos' }, TARGET);

		await queue.flush();

		expect(client.createTask).toHaveBeenCalledTimes(1);
		expect(storage.operations[0]?.state).toBe('recoverable_error');
		expect(storage.operations[1]?.state).toBe('pending_local');
	});

	it('sin token no se gasta un intento ni se marca nada', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		client.createTask.mockResolvedValue(failure('no_token'));
		const queue = queueWith(client, storage);
		await queue.enqueueCreate({ title: 'Comprar pan' }, TARGET);

		await queue.flush();

		expect(storage.operations[0]).toMatchObject({ state: 'pending_local', attempts: 0 });
	});
});

describe('OperationQueue: dispositivos y gestión manual', () => {
	it('no procesa las operaciones de OTRO dispositivo', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		const other = queueWith(client, asDevice(storage, 'device-b'));
		await other.enqueueCreate({ title: 'De la otra máquina' }, TARGET);
		expect(storage.operations[0]?.deviceId).toBe('device-b');

		const mine = queueWith(client, storage);
		await mine.flush();

		expect(client.createTask).not.toHaveBeenCalled();
		expect(mine.pending()).toHaveLength(0);
		expect(storage.operations[0]?.state).toBe('pending_local');
	});

	it('pending() lista lo que no está materializado', async () => {
		const storage = memoryStorage();
		const queue = queueWith(fakeClient(), storage);
		await queue.enqueueCreate({ title: 'Uno' }, TARGET);
		expect(queue.pending()).toHaveLength(1);

		await queue.flush();
		expect(queue.pending()).toHaveLength(0);
	});

	it('retry pone los intentos a cero y relee sin reenviar si ya se había enviado', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		client.getTask.mockResolvedValue({ ok: true, value: null });
		const queue = queueWith(client, storage);
		const operation = await queue.enqueueCreate({ title: 'Uno' }, TARGET);
		await queue.flush();
		expect(storage.operations[0]?.attempts).toBe(1);

		await queue.retry(operation.id);

		expect(storage.operations[0]).toMatchObject({ state: 'sent', attempts: 0, error: null });
		client.getTask.mockResolvedValue({ ok: true, value: task() });
		await queue.flush();
		expect(client.createTask).toHaveBeenCalledTimes(1);
		expect(storage.operations[0]?.state).toBe('materialized');
	});

	it('retry de una rechazada que nunca se envió la devuelve a pending_local', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		client.createTask.mockResolvedValue(failure('unauthorized', 401));
		const queue = queueWith(client, storage);
		const operation = await queue.enqueueCreate({ title: 'Uno' }, TARGET);
		await queue.flush();

		await queue.retry(operation.id);

		expect(storage.operations[0]?.state).toBe('pending_local');
	});

	it('discard saca la operación de la cola', async () => {
		const storage = memoryStorage();
		const queue = queueWith(fakeClient(), storage);
		const operation = await queue.enqueueCreate({ title: 'Uno' }, TARGET);

		await queue.discard(operation.id);

		expect(storage.operations).toHaveLength(0);
	});
});

describe('OperationQueue: una entrada del BRL', () => {
	it('manda createBrlEntry con el id fijado aquí y confirma releyendo el JSON del día', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		const queue = queueWith(client, storage);
		const operation = await queue.enqueueBrl('2026-09-03', '- Llamé al fontanero', TARGET);
		client.brlJson.mockResolvedValue({
			ok: true,
			value: {
				date: '2026-09-03',
				entries: [{ id: operation.entryId, time: '11:20', entry: '- Llamé al fontanero' }],
			},
		});

		await queue.flush();

		expect(client.mutate).toHaveBeenCalledWith({
			op: 'createBrlEntry',
			entryId: operation.entryId,
			date: '2026-09-03',
			entry: '- Llamé al fontanero',
		});
		expect(client.brlJson).toHaveBeenCalledWith('2026-09-03');
		// Una entrada del BRL no es una tarea: `getTask` no pinta nada aquí.
		expect(client.getTask).not.toHaveBeenCalled();
		expect(storage.operations[0]?.state).toBe('materialized');
	});

	it('si el día releído no trae el id, se queda en sent con un intento más', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		const queue = queueWith(client, storage);
		await queue.enqueueBrl('2026-09-03', '= Un pensamiento', TARGET);

		await queue.flush();

		expect(client.brlJson).toHaveBeenCalledTimes(2);
		expect(storage.operations[0]).toMatchObject({ state: 'sent', attempts: 1 });
	});
});

describe('OperationQueue: un vínculo nota↔lista', () => {
	const NOTE_TARGET: LinkTarget = { notePath: 'Proyectos/Cocina.md', label: 'Cocina', excerpt: null };

	it('link manda listLink y confirma releyendo que la url está presente', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		const queue = queueWith(client, storage);
		const operation = await queue.enqueueListLink('link', 'list-1', 'obsidian://open?vault=v&file=Cocina', 'Cocina', NOTE_TARGET);
		client.listLinks.mockResolvedValue({
			ok: true,
			value: [
				{
					id: 'row-1',
					listId: 'list-1',
					kind: 'obsidian',
					targetKey: operation.url,
					url: operation.url,
					label: 'Cocina',
					updatedAt: '2026-09-05T10:00:00.000Z',
				},
			],
		});

		await queue.flush();

		expect(client.listLink).toHaveBeenCalledWith({
			listId: 'list-1',
			url: 'obsidian://open?vault=v&file=Cocina',
			label: 'Cocina',
		});
		expect(client.listLinks).toHaveBeenCalledWith('list-1');
		expect(storage.operations[0]?.state).toBe('materialized');
	});

	it('unlink manda la MISMA url que se guardó, byte a byte', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		const queue = queueWith(client, storage);
		const url = 'obsidian://open?vault=v&file=Notas%20con%20espacios';
		await queue.enqueueListLink('unlink', 'list-1', url, 'Notas con espacios', NOTE_TARGET);

		await queue.flush();

		expect(client.listUnlink).toHaveBeenCalledWith({ listId: 'list-1', url, label: 'Notas con espacios' });
	});

	it('unlink con removed:false en el servidor igualmente se confirma: la ausencia en la relectura basta', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		const queue = queueWith(client, storage);
		// La relectura ya no trae la url, tanto si el servidor la quitó de verdad
		// como si `removed: false` porque ya no estaba: la cola no distingue los
		// dos casos, y no hace falta.
		client.listLinks.mockResolvedValue({ ok: true, value: [] });
		await queue.enqueueListLink('unlink', 'list-1', 'url-vieja', 'Cocina', NOTE_TARGET);

		await queue.flush();

		expect(storage.operations[0]?.state).toBe('materialized');
	});

	it('un 404 (lista de otra cuenta o borrada) deja la operación rejected, no se reintenta', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		client.listLink.mockResolvedValue(failure('not_found', 404));
		const queue = queueWith(client, storage);
		await queue.enqueueListLink('link', 'list-ajena', 'url', 'Cocina', NOTE_TARGET);

		await queue.flush();

		expect(storage.operations[0]?.state).toBe('rejected');
		expect(client.listLinks).not.toHaveBeenCalled();
	});

	it('si la url mandada no aparece en la relectura, se queda en sent con un intento más', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		const queue = queueWith(client, storage);
		await queue.enqueueListLink('link', 'list-1', 'url-nueva', 'Cocina', NOTE_TARGET);
		// La relectura no trae la url que se acaba de mandar.
		client.listLinks.mockResolvedValue({ ok: true, value: [] });

		await queue.flush();

		expect(storage.operations[0]).toMatchObject({ state: 'sent', attempts: 1 });
	});
});

describe('OperationQueue: un lote aprobado', () => {
	const OPS: BatchOperation[] = [
		{ type: 'create', clientTaskId: 'nueva-1', draft: { title: 'Uno' } },
		{ type: 'mutateRaw', taskId: 'task-9', kind: 'complete', payload: { done: true } },
	];

	it('manda las ops por batch y confirma releyendo las tareas creadas', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		const queue = queueWith(client, storage);
		await queue.enqueueBatch(OPS, ['nueva-1'], TARGET);

		await queue.flush();

		expect(client.batch).toHaveBeenCalledWith(OPS);
		expect(client.getTasksByIds).toHaveBeenCalledWith(['nueva-1']);
		expect(storage.operations[0]?.state).toBe('materialized');
	});

	it('un éxito PARCIAL queda enviado, con el índice y el motivo de lo que falló', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		client.batch.mockResolvedValue({
			ok: true,
			value: [
				{ index: 0, type: 'ingest', ok: true },
				{ index: 1, type: 'mutate', ok: false, error: 'kind inválido' },
			],
		});
		const queue = queueWith(client, storage);
		await queue.enqueueBatch(OPS, ['nueva-1'], TARGET);

		await queue.flush();

		// Las ops VÁLIDAS ya están aplicadas en Lumbre: dar el lote por no enviado
		// llevaría a reenviarlo, y un `addSubtask` no es idempotente.
		const stored = storage.operations[0] as BatchQueuedOperation | undefined;
		expect(stored?.sentAt).not.toBeNull();
		expect(stored?.failedItems).toEqual([{ index: 1, error: 'kind inválido' }]);
	});

	it('reintentar un lote ya aceptado NO lo vuelve a mandar', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		client.batch.mockResolvedValue({
			ok: true,
			value: [
				{ index: 0, type: 'ingest', ok: true },
				{ index: 1, type: 'mutate', ok: false, error: 'kind inválido' },
			],
		});
		const queue = queueWith(client, storage);
		const operation = await queue.enqueueBatch(OPS, ['nueva-1'], TARGET);
		await queue.flush();
		expect(client.batch).toHaveBeenCalledTimes(1);

		await queue.retry(operation.id);
		await queue.flush();

		expect(client.batch).toHaveBeenCalledTimes(1);
	});

	it('una op del lote rechazada no deja el lote esperando esa tarea para siempre', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		client.batch.mockResolvedValue({
			ok: true,
			value: [
				{ index: 0, type: 'ingest', ok: false, error: 'texto vacío' },
				{ index: 1, type: 'mutate', ok: true },
			],
		});
		const queue = queueWith(client, storage);
		await queue.enqueueBatch(OPS, ['nueva-1'], TARGET);

		await queue.flush();

		// La única alta del lote fue la que cayó: no hay nada que releer.
		expect(client.getTasksByIds).not.toHaveBeenCalled();
		expect(storage.operations[0]?.state).toBe('materialized');
	});

	it('describeFailedItems nombra la acción por su posición, en base 1', () => {
		expect(
			describeFailedItems([
				{ index: 1, error: 'kind inválido' },
				{ index: 3, error: null },
			]),
		).toBe('acción 2 (kind inválido); acción 4');
	});

	it('un lote sin altas se confirma sin releer nada', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		const queue = queueWith(client, storage);
		await queue.enqueueBatch([OPS[1] as BatchOperation], [], TARGET);

		await queue.flush();

		expect(client.getTasksByIds).not.toHaveBeenCalled();
		expect(storage.operations[0]?.state).toBe('materialized');
	});
});

describe('OperationQueue: poda de la cola', () => {
	/** Una materializada ya guardada, con la antigüedad que se le pida. */
	function done(id: string, updatedAt: string): QueuedOperation {
		return {
			id,
			deviceId: DEVICE,
			state: 'materialized',
			attempts: 0,
			error: null,
			createdAt: updatedAt,
			updatedAt,
			sentAt: updatedAt,
			materializedAt: updatedAt,
			kind: 'status',
			taskId: `tarea-${id}`,
			done: true,
			target: TARGET,
		};
	}

	it('descarta las materializadas de más de 7 días y conserva 50 como mucho', async () => {
		const now = new Date('2026-09-03T12:00:00.000Z');
		const storage = memoryStorage();
		// 60 materializadas: 30 de hace un mes y 30 de ayer.
		for (let i = 0; i < 30; i += 1) storage.operations.push(done(`vieja-${i}`, '2026-08-01T12:00:00.000Z'));
		for (let i = 0; i < 30; i += 1) {
			storage.operations.push(done(`reciente-${i}`, `2026-09-02T12:00:${String(i).padStart(2, '0')}.000Z`));
		}
		const queue = new OperationQueue({ client: fakeClient(), storage, now: () => now });

		// Tres pendientes nuevas: la poda ocurre al ESCRIBIR la cola.
		await queue.enqueueStatus('task-1', true, TARGET);
		await queue.enqueueStatus('task-2', true, TARGET);
		await queue.enqueueStatus('task-3', true, TARGET);

		const kept = storage.operations;
		expect(kept.filter((operation) => operation.state !== 'materialized')).toHaveLength(3);
		const materialized = kept.filter((operation) => operation.state === 'materialized');
		expect(materialized.length).toBeLessThanOrEqual(50);
		expect(materialized.every((operation) => operation.updatedAt > '2026-08-27')).toBe(true);
	});
});

describe('OperationQueue: una operación aceptada que nunca se confirma', () => {
	it('deja de reintentarse tras MAX_ATTEMPTS y queda visible con su motivo', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		// El servidor acepta, pero la tarea no aparece nunca al releer.
		client.getTask.mockResolvedValue({ ok: true, value: null });
		const queue = queueWith(client, storage);
		await queue.enqueueStatus('task-1', true, TARGET);

		for (let attempt = 0; attempt < MAX_ATTEMPTS + 3; attempt += 1) await queue.flush();

		expect(storage.operations[0]).toMatchObject({
			state: 'recoverable_error',
			attempts: MAX_ATTEMPTS,
		});
		expect(storage.operations[0]?.error).toContain('no la confirma');
		// Cinco relecturas dobles y ni una sexta: ya no es accionable.
		expect(client.getTask).toHaveBeenCalledTimes(MAX_ATTEMPTS * 2);
		expect(client.mutate).toHaveBeenCalledTimes(1);
	});
});

describe('OperationQueue: economía de peticiones', () => {
	it('un flush con cinco operaciones nuevas no gasta ningún drenaje aparte', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		const queue = queueWith(client, storage);
		for (let i = 0; i < 5; i += 1) await queue.enqueueStatus(`task-${i}`, true, TARGET);
		client.getTask.mockImplementation(async (id: string) => ({
			ok: true,
			value: task({ id, done: true }),
		}));

		await queue.flush();

		expect(client.mutate).toHaveBeenCalledTimes(5);
		expect(client.flush.mock.calls.length).toBeLessThanOrEqual(1);
	});

	it('las que ya estaban enviadas comparten UN solo drenaje', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		client.getTask.mockResolvedValue({ ok: true, value: null });
		const queue = queueWith(client, storage);
		for (let i = 0; i < 3; i += 1) await queue.enqueueStatus(`task-${i}`, true, TARGET);
		await queue.flush();
		client.flush.mockClear();

		await queue.flush();

		expect(client.flush).toHaveBeenCalledTimes(1);
	});

	it('un 429 no gasta intentos y aplaza el siguiente intento', async () => {
		const clock = { at: new Date('2026-09-03T12:00:00.000Z') };
		const storage = memoryStorage();
		const client = fakeClient();
		client.mutate.mockResolvedValue(failure('rate_limited', 429));
		const queue = new OperationQueue({
			client,
			storage,
			sleep: vi.fn(async (_ms: number): Promise<void> => undefined),
			now: () => clock.at,
		});
		await queue.enqueueStatus('task-1', true, TARGET);

		for (let attempt = 0; attempt < 3; attempt += 1) {
			await queue.flush();
			// Pasa la espera: si no, la operación ni siquiera sería accionable.
			clock.at = new Date(clock.at.getTime() + RATE_LIMIT_BACKOFF_MS + 1000);
		}

		expect(client.mutate).toHaveBeenCalledTimes(3);
		expect(storage.operations[0]).toMatchObject({ state: 'recoverable_error', attempts: 0 });
	});

	it('mientras dura la espera del 429 la operación no se toca', async () => {
		const clock = { at: new Date('2026-09-03T12:00:00.000Z') };
		const storage = memoryStorage();
		const client = fakeClient();
		client.mutate.mockResolvedValue(failure('rate_limited', 429));
		const queue = new OperationQueue({ client, storage, now: () => clock.at });
		await queue.enqueueStatus('task-1', true, TARGET);

		await queue.flush();
		await queue.flush();

		expect(client.mutate).toHaveBeenCalledTimes(1);
	});
});

describe('OperationQueue: encolar durante un flush en vuelo', () => {
	it('la operación encolada mientras se drena se envía en el flush encadenado', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		const gate = deferred();
		client.mutate.mockImplementationOnce(async () => {
			await gate.promise;
			return OK;
		});
		const queue = queueWith(client, storage);
		await queue.enqueueStatus('task-1', true, TARGET);

		// El primer flush se queda dentro de `mutate`, sin resolver.
		const first = queue.flush();
		await queue.enqueueStatus('task-2', true, TARGET);
		const second = queue.flush();
		gate.resolve();
		await Promise.all([first, second]);

		expect(client.mutate).toHaveBeenCalledTimes(2);
		expect(storage.operations.every((operation) => operation.sentAt !== null)).toBe(true);
	});
});

describe('OperationQueue: registro de diagnóstico', () => {
	function loggedQueue(
		client: ReturnType<typeof fakeClient>,
		storage: QueueStorage,
	): { queue: OperationQueue; logger: Logger } {
		const logger = Logger.create({ console: null, level: 'info' });
		const queue = new OperationQueue({
			client,
			storage,
			sleep: vi.fn(async (_ms: number): Promise<void> => undefined),
			logger: logger.child('queue'),
		});
		return { queue, logger };
	}

	it('apunta el encolado y la transición hasta materializar, con from → to', async () => {
		const storage = memoryStorage();
		const { queue, logger } = loggedQueue(fakeClient(), storage);

		await queue.enqueueCreate({ title: 'Comprar pan' }, TARGET);
		await queue.flush();

		const messages = logger.recent().map((event) => event.message);
		expect(messages).toContain('Operación encolada');
		expect(messages).toContain('Flush terminado');

		const transitions = logger
			.recent()
			.filter((event) => event.message === 'Operación de la cola')
			.map((event) => event.data);
		expect(transitions).toContainEqual(
			expect.objectContaining({ from: 'pending_local', to: 'sent' }),
		);
		expect(transitions).toContainEqual(
			expect.objectContaining({ from: 'sent', to: 'materialized', attempts: 0 }),
		);
	});

	it('un fallo permanente sale como `error` con su motivo', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		client.mutate.mockResolvedValue(failure('bad_request', 400));
		const { queue, logger } = loggedQueue(client, storage);

		await queue.enqueueStatus('task-1', true, TARGET);
		await queue.flush();

		const rejected = logger
			.recent()
			.find((event) => event.message === 'Operación de la cola' && event.level === 'error');
		expect(rejected?.data).toMatchObject({ to: 'rejected', reason: 'bad_request' });
	});

	it('avisa al tercer fallo recuperable y da error al agotar los intentos', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		client.mutate.mockResolvedValue(failure('network'));
		const { queue, logger } = loggedQueue(client, storage);
		await queue.enqueueStatus('task-1', true, TARGET);

		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) await queue.flush();

		const levels = logger
			.recent()
			.filter((event) => event.message === 'Operación de la cola')
			.map((event) => event.level);
		expect(levels.slice(0, 2)).toEqual(['info', 'info']);
		expect(levels).toContain('warn');
		expect(levels.at(-1)).toBe('error');
	});

	it('avisa de las operaciones de OTRO dispositivo con el número, no con su id', async () => {
		const storage = memoryStorage();
		const otherQueue = new OperationQueue({
			client: fakeClient(),
			storage: asDevice(storage, 'device-b'),
		});
		await otherQueue.enqueueStatus('task-9', true, TARGET);
		const { queue, logger } = loggedQueue(fakeClient(), storage);

		await queue.flush();

		const warning = logger
			.recent()
			.find((event) => event.message === 'Operaciones de otro dispositivo, se saltan');
		expect(warning?.data).toEqual({ count: 1 });
		expect(JSON.stringify(warning?.data)).not.toContain('device-b');
	});

	it('el texto de una entrada del BRL no entra en el registro', async () => {
		const storage = memoryStorage();
		const { queue, logger } = loggedQueue(fakeClient(), storage);

		await queue.enqueueBrl('2026-09-03', '- lo que escribí en mi registro privado', TARGET);

		expect(JSON.stringify(logger.recent())).not.toContain('registro privado');
		expect(logger.recent()[0]?.data).toMatchObject({ kind: 'brl', length: 39 });
	});
});
