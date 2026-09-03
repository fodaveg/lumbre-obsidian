import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
	BatchOperation,
	BatchResultItem,
	BrlDay,
	LumbreFailure,
	LumbreResult,
	MutationOp,
} from './client';
import {
	MAX_ATTEMPTS,
	OperationQueue,
	type CreateOperation,
	type LinkTarget,
	type QueuedOperation,
	type QueueStorage,
} from './queue';
import type { LumbreTask, TaskDraft } from './types';

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

	it('envía, hace flush, relee y solo entonces marca materialized guardando la tarea', async () => {
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
		expect(client.flush).toHaveBeenCalledTimes(1);
		expect(client.getTask).toHaveBeenCalledWith(operation.clientTaskId);
		const [stored] = storage.operations;
		expect(stored?.state).toBe('materialized');
		expect((stored as CreateOperation | undefined)?.task).toEqual(created);
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

	it('un informe con una op en rojo NO se da por enviado', async () => {
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

		// `/api/batch` responde 200 con éxito PARCIAL: el 200 no es la señal.
		expect(storage.operations[0]?.state).toBe('rejected');
		expect(storage.operations[0]?.sentAt).toBeNull();
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
