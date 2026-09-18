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
	MutationOutcome,
	TaskLinkRow,
	TaskLinkTarget,
} from './client';
import { Logger } from '../diagnostics/logger';
import {
	describeFailedItems,
	MAX_ATTEMPTS,
	OperationQueue,
	RATE_LIMIT_BACKOFF_MS,
	type BatchQueuedOperation,
	type LinkTarget,
	type MutationCheck,
	type QueuedOperation,
	type QueueStorage,
} from './queue';
import type { LumbreList, LumbreSubtask, LumbreTask, TaskDraft } from './types';

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
		// Sin `outcome`, como un Lumbre anterior al contrato: la cola sigue
		// releyendo como siempre. Los tests de `outcome` lo sobrescriben.
		mutate: vi.fn(
			async (_op: MutationOp): Promise<LumbreResult<{ outcome?: MutationOutcome }>> => ({
				ok: true,
				value: {},
			}),
		),
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
		listLists: vi.fn(
			async (): Promise<LumbreResult<LumbreList[]>> => ({ ok: true, value: [] }),
		),
		listNotes: vi.fn(
			async (
				_listId: string,
			): Promise<LumbreResult<{ found: boolean; notes: string | null }>> => ({
				ok: true,
				value: { found: false, notes: null },
			}),
		),
		listLink: vi.fn(async (_target: ListLinkTarget): Promise<LumbreResult<void>> => OK),
		listUnlink: vi.fn(async (_target: ListLinkTarget): Promise<LumbreResult<void>> => OK),
		listLinks: vi.fn(
			async (_listId: string): Promise<LumbreResult<ListLinkRow[]>> => ({ ok: true, value: [] }),
		),
		taskLink: vi.fn(async (_target: TaskLinkTarget): Promise<LumbreResult<void>> => OK),
		taskUnlink: vi.fn(async (_target: TaskLinkTarget): Promise<LumbreResult<void>> => OK),
		taskLinks: vi.fn(
			async (_taskId: string): Promise<LumbreResult<TaskLinkRow[]>> => ({ ok: true, value: [] }),
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

	// H7, ya cerrado por el `outcome` del servidor (contrato del 2026-09-03,
	// commit `9e44cca9`): reabrir una tarea que en Lumbre YA estaba abierta
	// responde `noop`, y eso es justo lo que antes no se podía distinguir de un
	// `applied` de verdad. Ver `matchesOperation` en `queue.ts` para el límite
	// que sigue vigente contra un Lumbre SIN el contrato (más abajo, describe
	// «outcome de las mutaciones»).
	it('reabrir una tarea que ya estaba abierta responde noop y queda materialized sin relectura', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		client.mutate.mockResolvedValue({ ok: true, value: { outcome: 'noop' } });
		const queue = queueWith(client, storage);
		await queue.enqueueStatus('task-1', false, TARGET);

		await queue.flush();

		expect(client.mutate).toHaveBeenCalledWith({ op: 'complete', taskId: 'task-1', done: false });
		expect(client.getTask).not.toHaveBeenCalled();
		expect(storage.operations[0]?.state).toBe('materialized');
	});
});

describe('OperationQueue: outcome de las mutaciones (status y notes)', () => {
	it.each<['status' | 'notes', MutationOutcome]>([
		['status', 'applied'],
		['status', 'noop'],
		['notes', 'applied'],
		['notes', 'noop'],
	])('%s con outcome %s queda materialized SIN relectura', async (kind, outcome) => {
		const storage = memoryStorage();
		const client = fakeClient();
		client.mutate.mockResolvedValue({ ok: true, value: { outcome } });
		const queue = queueWith(client, storage);
		if (kind === 'status') {
			await queue.enqueueStatus('task-1', true, TARGET);
		} else {
			await queue.enqueueNotes('task-1', 'Notas', 'cabecera', TARGET);
		}

		await queue.flush();

		expect(client.getTask).not.toHaveBeenCalled();
		expect(storage.operations[0]?.state).toBe('materialized');
		expect(storage.operations[0]?.materializedAt).not.toBeNull();
	});

	it.each<'status' | 'notes'>(['status', 'notes'])(
		'%s con outcome not-found queda rejected, sin gastar un intento ni releer',
		async (kind) => {
			const storage = memoryStorage();
			const client = fakeClient();
			client.mutate.mockResolvedValue({ ok: true, value: { outcome: 'not-found' } });
			const queue = queueWith(client, storage);
			if (kind === 'status') {
				await queue.enqueueStatus('task-1', true, TARGET);
			} else {
				await queue.enqueueNotes('task-1', 'Notas', 'cabecera', TARGET);
			}

			await queue.flush();

			expect(client.getTask).not.toHaveBeenCalled();
			expect(storage.operations[0]?.state).toBe('rejected');
			expect(storage.operations[0]?.attempts).toBe(0);
			expect(storage.operations[0]?.error).toContain('ya no existe');
		},
	);

	it('status con outcome queued sigue el camino de siempre: sent y relectura', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		client.mutate.mockResolvedValue({ ok: true, value: { outcome: 'queued' } });
		const queue = queueWith(client, storage);
		await queue.enqueueStatus('task-1', true, TARGET);

		await queue.flush();

		expect(client.getTask).toHaveBeenCalledTimes(2);
		expect(storage.operations[0]).toMatchObject({ state: 'sent', attempts: 1 });
	});

	it('status sin outcome (Lumbre anterior al contrato) sigue el camino de siempre', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		client.getTask.mockResolvedValue({ ok: true, value: task({ done: true }) });
		const queue = queueWith(client, storage);
		await queue.enqueueStatus('task-1', true, TARGET);

		await queue.flush();

		expect(client.getTask).toHaveBeenCalledWith('task-1');
		expect(storage.operations[0]?.state).toBe('materialized');
	});

	it('create y brl ignoran outcome aunque el servidor lo mande: siguen relayendo', async () => {
		// `brl` manda por `mutate` (createBrlEntry) igual que `status`/`notes`,
		// pero `outcomeOf` lo excluye a propósito: su `not-found` no cabe (la
		// entrada la crea el propio plugin) y su relectura es OTRA (el JSON del
		// día, no `getTask`).
		const storage = memoryStorage();
		const client = fakeClient();
		client.mutate.mockResolvedValue({ ok: true, value: { outcome: 'applied' } });
		client.brlJson.mockResolvedValue({ ok: true, value: { date: '2026-09-05', entries: [] } });
		const queue = queueWith(client, storage);
		await queue.enqueueBrl('2026-09-05', '- Nota', TARGET);

		await queue.flush();

		expect(client.brlJson).toHaveBeenCalled();
		expect(storage.operations[0]?.state).toBe('sent');
	});
});

describe('OperationQueue: una mutación genérica', () => {
	/** El caso más corto: cambiar la fecha de una tarea y comprobarla por valor. */
	const RESCHEDULE: MutationOp = { op: 'reschedule', taskId: 'task-1', date: '2026-09-20' };
	const RESCHEDULE_CHECK: MutationCheck = {
		check: 'taskField',
		taskId: 'task-1',
		field: 'date',
		expected: '2026-09-20',
	};

	function subtask(overrides: Partial<LumbreSubtask> = {}): LumbreSubtask {
		return { id: 'sub-1', content: 'Un paso', done: false, ...overrides };
	}

	function list(overrides: Partial<LumbreList> = {}): LumbreList {
		return {
			id: 'list-1',
			name: 'Cocina',
			icon: null,
			color: null,
			parentListId: null,
			pinned: false,
			taskCount: 0,
			...overrides,
		};
	}

	it('encola la op VERBATIM con su comprobación y la manda por mutate', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		client.mutate.mockResolvedValue({ ok: true, value: { outcome: 'applied' } });
		const queue = queueWith(client, storage);

		const operation = await queue.enqueueMutation(RESCHEDULE, RESCHEDULE_CHECK, TARGET);
		expect(operation.state).toBe('pending_local');
		expect(operation.op).toEqual(RESCHEDULE);
		expect(operation.check).toEqual(RESCHEDULE_CHECK);

		await queue.flush();

		// Tal cual se encoló: la cola no reinterpreta el payload.
		expect(client.mutate).toHaveBeenCalledWith(RESCHEDULE);
	});

	it.each<MutationOutcome>(['applied', 'noop'])(
		'con outcome %s queda materialized SIN relectura',
		async (outcome) => {
			const storage = memoryStorage();
			const client = fakeClient();
			client.mutate.mockResolvedValue({ ok: true, value: { outcome } });
			const materialized: QueuedOperation[] = [];
			const queue = new OperationQueue({
				client,
				storage,
				sleep: vi.fn(async (_ms: number): Promise<void> => undefined),
				onMaterialized: (operation) => materialized.push(operation),
			});
			await queue.enqueueMutation(RESCHEDULE, RESCHEDULE_CHECK, TARGET);

			await queue.flush();

			expect(client.getTask).not.toHaveBeenCalled();
			expect(storage.operations[0]?.state).toBe('materialized');
			expect(storage.operations[0]?.materializedAt).not.toBeNull();
			expect(materialized).toHaveLength(1);
		},
	);

	it('con outcome not-found queda rejected, sin gastar un intento ni releer', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		client.mutate.mockResolvedValue({ ok: true, value: { outcome: 'not-found' } });
		const queue = queueWith(client, storage);
		await queue.enqueueMutation(RESCHEDULE, RESCHEDULE_CHECK, TARGET);

		await queue.flush();

		expect(client.getTask).not.toHaveBeenCalled();
		expect(storage.operations[0]?.state).toBe('rejected');
		expect(storage.operations[0]?.attempts).toBe(0);
		expect(storage.operations[0]?.error).toContain('ya no existe');
	});

	it('con outcome queued cae a la relectura de respaldo y confirma', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		client.mutate.mockResolvedValue({ ok: true, value: { outcome: 'queued' } });
		client.getTask.mockResolvedValue({ ok: true, value: task({ date: '2026-09-20' }) });
		const queue = queueWith(client, storage);
		await queue.enqueueMutation(RESCHEDULE, RESCHEDULE_CHECK, TARGET);

		await queue.flush();

		expect(client.getTask).toHaveBeenCalledWith('task-1');
		expect(client.getTask).toHaveBeenCalledTimes(1);
		expect(storage.operations[0]?.state).toBe('materialized');
	});

	it('sin outcome (un Lumbre anterior al contrato) también relee y confirma', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		client.getTask.mockResolvedValue({ ok: true, value: task({ date: '2026-09-20' }) });
		const queue = queueWith(client, storage);
		await queue.enqueueMutation(RESCHEDULE, RESCHEDULE_CHECK, TARGET);

		await queue.flush();

		expect(storage.operations[0]?.state).toBe('materialized');
	});

	it('si la relectura nunca confirma, gasta los intentos y acaba en recoverable_error', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		client.mutate.mockResolvedValue({ ok: true, value: { outcome: 'queued' } });
		// La fecha que llega NO es la que se pidió: la mutación no está aplicada.
		client.getTask.mockResolvedValue({ ok: true, value: task({ date: '2026-09-01' }) });
		const queue = queueWith(client, storage);
		await queue.enqueueMutation(RESCHEDULE, RESCHEDULE_CHECK, TARGET);

		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) await queue.flush();

		// Un solo envío: los flushes siguientes solo releen.
		expect(client.mutate).toHaveBeenCalledTimes(1);
		expect(storage.operations[0]).toMatchObject({
			state: 'recoverable_error',
			attempts: MAX_ATTEMPTS,
		});
		expect(storage.operations[0]?.error).toContain('no la confirma');
		// Agotada: el flush siguiente ya no la toca.
		await queue.flush();
		expect(storage.operations[0]?.attempts).toBe(MAX_ATTEMPTS);
	});

	it('un addSubtask ya enviado se RELEE y nunca se reenvía', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		client.mutate.mockResolvedValue({ ok: true, value: { outcome: 'queued' } });
		client.getTask.mockResolvedValue({ ok: true, value: task({ subtasks: [] }) });
		const queue = queueWith(client, storage);
		await queue.enqueueMutation(
			{ op: 'addSubtask', taskId: 'task-1', subtasks: ['Un paso'] },
			{ check: 'subtasksInclude', parentId: 'task-1', titles: ['Un paso'] },
			TARGET,
		);

		await queue.flush();
		expect(client.mutate).toHaveBeenCalledTimes(1);
		expect(storage.operations[0]).toMatchObject({ state: 'sent', attempts: 1 });

		client.getTask.mockResolvedValue({ ok: true, value: task({ subtasks: [subtask()] }) });
		await queue.flush();

		// `addSubtask` NO es idempotente: reenviarlo añadiría el paso dos veces.
		expect(client.mutate).toHaveBeenCalledTimes(1);
		expect(client.flush).toHaveBeenCalledTimes(1);
		expect(storage.operations[0]?.state).toBe('materialized');
	});

	it('confirma una subtarea completada mirando el done de la del padre', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		client.mutate.mockResolvedValue({ ok: true, value: { outcome: 'queued' } });
		client.getTask.mockResolvedValue({
			ok: true,
			value: task({ subtasks: [subtask({ done: true })] }),
		});
		const queue = queueWith(client, storage);
		await queue.enqueueMutation(
			{ op: 'completeSubtask', subtaskId: 'sub-1', done: true },
			{ check: 'subtaskDone', parentId: 'task-1', subtaskId: 'sub-1', done: true },
			TARGET,
		);

		await queue.flush();

		// Se relee el PADRE: una subtarea no aparece en un getTask por su id.
		expect(client.getTask).toHaveBeenCalledWith('task-1');
		expect(storage.operations[0]?.state).toBe('materialized');
	});

	it.each<[string, boolean, string | null, boolean]>([
		['cancel', true, '2026-09-18T10:00:00.000Z', true],
		['cancel sin cancelar', true, null, false],
		['restore', false, null, true],
		['restore sin restaurar', false, '2026-09-18T10:00:00.000Z', false],
	])(
		'comprueba cancelledAt por PRESENCIA (%s)',
		async (_name, set, cancelledAt, shouldConfirm) => {
			const storage = memoryStorage();
			const client = fakeClient();
			client.mutate.mockResolvedValue({ ok: true, value: { outcome: 'queued' } });
			client.getTask.mockResolvedValue({ ok: true, value: task({ cancelledAt }) });
			const queue = queueWith(client, storage);
			await queue.enqueueMutation(
				set ? { op: 'cancel', taskId: 'task-1' } : { op: 'restore', taskId: 'task-1' },
				{ check: 'taskFieldSet', taskId: 'task-1', field: 'cancelledAt', set },
				TARGET,
			);

			await queue.flush();

			expect(storage.operations[0]?.state).toBe(shouldConfirm ? 'materialized' : 'sent');
		},
	);

	it.each<['id' | 'name', string]>([
		['id', 'list-1'],
		['name', 'Cocina'],
	])('comprueba la lista de la tarea por %s', async (by, expected) => {
		const storage = memoryStorage();
		const client = fakeClient();
		client.mutate.mockResolvedValue({ ok: true, value: { outcome: 'queued' } });
		client.getTask.mockResolvedValue({
			ok: true,
			value: task({ list: { id: 'list-1', name: 'Cocina' } }),
		});
		const queue = queueWith(client, storage);
		await queue.enqueueMutation(
			{ op: 'moveToList', taskId: 'task-1', listId: 'list-1' },
			{ check: 'taskRef', taskId: 'task-1', field: 'list', by, expected },
			TARGET,
		);

		await queue.flush();

		expect(storage.operations[0]?.state).toBe('materialized');
	});

	it('una sección que sigue vacía no se confirma', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		client.mutate.mockResolvedValue({ ok: true, value: { outcome: 'queued' } });
		const queue = queueWith(client, storage);
		await queue.enqueueMutation(
			{ op: 'setSection', taskId: 'task-1', section: 'Compras' },
			{ check: 'taskRef', taskId: 'task-1', field: 'section', by: 'name', expected: 'Compras' },
			TARGET,
		);

		await queue.flush();

		expect(storage.operations[0]).toMatchObject({ state: 'sent', attempts: 1 });
	});

	it('createList se confirma con el catálogo de listas, no con getTask', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		client.mutate.mockResolvedValue({ ok: true, value: { outcome: 'queued' } });
		client.listLists.mockResolvedValue({ ok: true, value: [list()] });
		const queue = queueWith(client, storage);
		await queue.enqueueMutation(
			{ op: 'createList', listId: 'list-1', name: 'Cocina' },
			{ check: 'listExists', listId: 'list-1' },
			TARGET,
		);

		await queue.flush();

		expect(client.listLists).toHaveBeenCalled();
		expect(client.getTask).not.toHaveBeenCalled();
		expect(storage.operations[0]?.state).toBe('materialized');
	});

	it('setListNotes se confirma por la cabecera de la foto dentro de la nota de la lista', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		client.mutate.mockResolvedValue({ ok: true, value: { outcome: 'queued' } });
		client.listNotes.mockResolvedValue({
			ok: true,
			value: { found: true, notes: '## Desde Obsidian (18 sep)\nlo que sea' },
		});
		const queue = queueWith(client, storage);
		await queue.enqueueMutation(
			{ op: 'setListNotes', listId: 'list-1', notes: 'texto final' },
			{ check: 'listNotes', listId: 'list-1', header: '## Desde Obsidian (18 sep)' },
			TARGET,
		);

		await queue.flush();

		expect(client.listNotes).toHaveBeenCalledWith('list-1');
		expect(storage.operations[0]?.state).toBe('materialized');
	});

	it('borrar la nota de una lista se confirma cuando la lista está y su nota ya no', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		client.mutate.mockResolvedValue({ ok: true, value: { outcome: 'queued' } });
		client.listNotes.mockResolvedValue({ ok: true, value: { found: true, notes: null } });
		const queue = queueWith(client, storage);
		await queue.enqueueMutation(
			{ op: 'setListNotes', listId: 'list-1', notes: null },
			{ check: 'listNotes', listId: 'list-1', header: null },
			TARGET,
		);

		await queue.flush();

		expect(storage.operations[0]?.state).toBe('materialized');
	});

	it('una lista que no está en el catálogo no confirma su nota', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		client.mutate.mockResolvedValue({ ok: true, value: { outcome: 'queued' } });
		// `found: false` (borrada o de otra cuenta) NO es "no tiene nota".
		client.listNotes.mockResolvedValue({ ok: true, value: { found: false, notes: null } });
		const queue = queueWith(client, storage);
		await queue.enqueueMutation(
			{ op: 'setListNotes', listId: 'list-1', notes: null },
			{ check: 'listNotes', listId: 'list-1', header: null },
			TARGET,
		);

		await queue.flush();

		expect(storage.operations[0]).toMatchObject({ state: 'sent', attempts: 1 });
	});

	it('el outcome noop de un setListNotes NO confirma nada: manda la relectura', async () => {
		// `setListNotes` sobre una lista borrada responde `noop`, igual que
		// `setListNotes` sobre una lista viva con el mismo texto que ya tenía: el
		// `outcome` no distingue los dos casos (ver el JSDoc de `rereadRequired`).
		const storage = memoryStorage();
		const client = fakeClient();
		client.mutate.mockResolvedValue({ ok: true, value: { outcome: 'noop' } });
		// La lista ya no está en el catálogo: la relectura NO confirma.
		client.listNotes.mockResolvedValue({ ok: true, value: { found: false, notes: null } });
		const queue = queueWith(client, storage);
		await queue.enqueueMutation(
			{ op: 'setListNotes', listId: 'list-1', notes: 'texto final' },
			{ check: 'listNotes', listId: 'list-1', header: '=== Foto de la nota ===' },
			TARGET,
		);

		await queue.flush();

		// Dos relecturas (con su espera en medio) y NADA materializado.
		expect(client.listNotes).toHaveBeenCalledTimes(2);
		expect(storage.operations[0]).toMatchObject({ state: 'sent', attempts: 1 });
	});

	it('el outcome noop de un setListNotes SÍ confirma cuando la relectura encuentra la cabecera', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		client.mutate.mockResolvedValue({ ok: true, value: { outcome: 'noop' } });
		client.listNotes.mockResolvedValue({
			ok: true,
			value: { found: true, notes: '=== Foto de la nota === ya estaba' },
		});
		const queue = queueWith(client, storage);
		await queue.enqueueMutation(
			{ op: 'setListNotes', listId: 'list-1', notes: 'texto final' },
			{ check: 'listNotes', listId: 'list-1', header: '=== Foto de la nota ===' },
			TARGET,
		);

		await queue.flush();

		expect(storage.operations[0]?.state).toBe('materialized');
	});

	it('el outcome applied de un updateBrlEntry NO confirma nada: manda la relectura', async () => {
		// Medido en el repo de Lumbre (`inbound-materialize.ts`, `origin/main`): los
		// tres kinds del BRL devuelven `applied` exista o no la entrada.
		const storage = memoryStorage();
		const client = fakeClient();
		client.mutate.mockResolvedValue({ ok: true, value: { outcome: 'applied' } });
		client.brlJson.mockResolvedValue({ ok: true, value: { date: '2026-09-18', entries: [] } });
		const queue = queueWith(client, storage);
		await queue.enqueueMutation(
			{ op: 'updateBrlEntry', entryId: 'entry-1', entry: '- Corregido' },
			{ check: 'brlEntry', date: '2026-09-18', entryId: 'entry-1', entry: '- Corregido' },
			TARGET,
		);

		await queue.flush();

		// Dos relecturas (con su espera en medio) y NADA materializado.
		expect(client.brlJson).toHaveBeenCalledTimes(2);
		expect(storage.operations[0]).toMatchObject({ state: 'sent', attempts: 1 });
	});

	it('una entrada del BRL editada se confirma por su texto', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		client.mutate.mockResolvedValue({ ok: true, value: { outcome: 'applied' } });
		client.brlJson.mockResolvedValue({
			ok: true,
			value: { date: '2026-09-18', entries: [{ id: 'entry-1', time: '10:00', entry: '- Corregido' }] },
		});
		const queue = queueWith(client, storage);
		await queue.enqueueMutation(
			{ op: 'updateBrlEntry', entryId: 'entry-1', entry: '- Corregido' },
			{ check: 'brlEntry', date: '2026-09-18', entryId: 'entry-1', entry: '- Corregido' },
			TARGET,
		);

		await queue.flush();

		expect(storage.operations[0]?.state).toBe('materialized');
	});

	it('borrar una entrada del BRL se confirma por su AUSENCIA', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		client.mutate.mockResolvedValue({ ok: true, value: { outcome: 'applied' } });
		client.brlJson.mockResolvedValue({ ok: true, value: { date: '2026-09-18', entries: [] } });
		const queue = queueWith(client, storage);
		await queue.enqueueMutation(
			{ op: 'removeBrlEntry', entryId: 'entry-1' },
			{ check: 'brlEntry', date: '2026-09-18', entryId: 'entry-1', entry: null },
			TARGET,
		);

		await queue.flush();

		expect(storage.operations[0]?.state).toBe('materialized');
	});

	it('registerHabit se cree el outcome applied, que es lo único que tiene', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		client.mutate.mockResolvedValue({ ok: true, value: { outcome: 'applied' } });
		const queue = queueWith(client, storage);
		await queue.enqueueMutation(
			{ op: 'registerHabit', habitId: 'habit-1', date: '2026-09-18' },
			{ check: 'none' },
			TARGET,
		);

		await queue.flush();

		expect(storage.operations[0]?.state).toBe('materialized');
	});

	it('registerHabit con outcome queued se aparca para reintento A MANO', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		client.mutate.mockResolvedValue({ ok: true, value: { outcome: 'queued' } });
		const sleep = vi.fn(async (_ms: number): Promise<void> => undefined);
		const queue = queueWith(client, storage, sleep);
		await queue.enqueueMutation(
			{ op: 'registerHabit', habitId: 'habit-1', date: '2026-09-18' },
			{ check: 'none' },
			TARGET,
		);

		await queue.flush();

		// Ni relee (no hay qué) ni espera para volver a intentarlo.
		expect(client.getTask).not.toHaveBeenCalled();
		expect(sleep).not.toHaveBeenCalled();
		expect(storage.operations[0]).toMatchObject({
			state: 'recoverable_error',
			attempts: MAX_ATTEMPTS,
		});
		expect(storage.operations[0]?.error).toContain('no puede comprobar');

		// Y no se reenvía sola en el flush siguiente.
		await queue.flush();
		expect(client.mutate).toHaveBeenCalledTimes(1);
	});

	it('el registro no lleva el payload de la op, solo sus discriminantes', async () => {
		const storage = memoryStorage();
		const logger = Logger.create({ console: null, level: 'info' });
		const queue = new OperationQueue({
			client: fakeClient(),
			storage,
			logger: logger.child('queue'),
			sleep: vi.fn(async (_ms: number): Promise<void> => undefined),
		});

		await queue.enqueueMutation(
			{ op: 'createList', listId: 'list-1', name: 'Una lista privada' },
			{ check: 'listExists', listId: 'list-1' },
			TARGET,
		);

		const entry = logger.recent().find((event) => event.message === 'Operación encolada');
		expect(entry?.data).toMatchObject({ kind: 'mutation', op: 'createList', check: 'listExists' });
		expect(JSON.stringify(logger.recent())).not.toContain('Una lista privada');
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

describe('OperationQueue: la foto de una nota en las notes de una tarea', () => {
	it('manda update notes y confirma releyendo que la cabecera está dentro de notes', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		const queue = queueWith(client, storage);
		const header = '=== Foto de la nota Casa.md · 2026-09-05 13:20 ===';
		const notes = `Nota vieja.\n\n${header}\n\nTexto de la nota`;
		await queue.enqueueNotes('task-1', notes, header, TARGET);
		client.getTask.mockResolvedValue({ ok: true, value: task({ notes }) });

		await queue.flush();

		expect(client.mutate).toHaveBeenCalledWith({ op: 'update', taskId: 'task-1', notes });
		expect(client.getTask).toHaveBeenCalledWith('task-1');
		expect(storage.operations[0]?.state).toBe('materialized');
		// De lo RELEÍDO no se guarda nada: la tarea entera no aparece en la operación.
		expect(storage.operations[0]).not.toHaveProperty('task');
	});

	it('si la relectura no trae la cabecera todavía, se queda en sent con un intento más', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		const queue = queueWith(client, storage);
		const header = '=== Foto de la nota Casa.md · 2026-09-05 13:20 ===';
		await queue.enqueueNotes('task-1', `${header}\n\nTexto`, header, TARGET);
		// La tarea releída todavía no lleva la cabecera de esta foto.
		client.getTask.mockResolvedValue({ ok: true, value: task({ notes: 'Otra cosa' }) });

		await queue.flush();

		expect(storage.operations[0]).toMatchObject({ state: 'sent', attempts: 1 });
	});

	it('una tarea que ya no existe deja la foto sin confirmar, sin gastar intentos de más', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		const queue = queueWith(client, storage);
		const header = '=== Foto de la nota Casa.md · 2026-09-05 13:20 ===';
		client.getTask.mockResolvedValue({ ok: true, value: null });
		await queue.enqueueNotes('task-1', `${header}\n\nTexto`, header, TARGET);

		await queue.flush();

		expect(storage.operations[0]?.state).toBe('sent');
	});

	it('el texto de la nota no entra en el registro, solo cuánto ocupa', async () => {
		const storage = memoryStorage();
		const logger = Logger.create({ console: null, level: 'info' });
		const queue = new OperationQueue({ client: fakeClient(), storage, logger: logger.child('queue') });
		const header = '=== Foto de la nota Casa.md · 2026-09-05 13:20 ===';
		const notes = `${header}\n\nUn párrafo bastante privado`;

		await queue.enqueueNotes('task-1', notes, header, TARGET);

		expect(JSON.stringify(logger.recent())).not.toContain('bastante privado');
		expect(logger.recent()[0]?.data).toMatchObject({ kind: 'notes', taskId: 'task-1', length: notes.length });
	});
});

describe('OperationQueue: un vínculo nota↔tarea (gemelo del de nota↔lista)', () => {
	const NOTE_TARGET: LinkTarget = { notePath: 'Proyectos/Cocina.md', label: 'Cocina', excerpt: null };

	it('link manda taskLink y confirma releyendo que la url está presente', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		const queue = queueWith(client, storage);
		const operation = await queue.enqueueTaskLink(
			'link',
			'task-1',
			'obsidian://open?vault=v&file=Cocina',
			'Cocina',
			NOTE_TARGET,
		);
		client.taskLinks.mockResolvedValue({
			ok: true,
			value: [
				{
					id: 'row-1',
					taskId: 'task-1',
					kind: 'obsidian',
					targetKey: operation.url,
					url: operation.url,
					label: 'Cocina',
					updatedAt: '2026-09-05T10:00:00.000Z',
				},
			],
		});

		await queue.flush();

		expect(client.taskLink).toHaveBeenCalledWith({
			taskId: 'task-1',
			url: 'obsidian://open?vault=v&file=Cocina',
			label: 'Cocina',
		});
		expect(client.taskLinks).toHaveBeenCalledWith('task-1');
		expect(storage.operations[0]?.state).toBe('materialized');
	});

	it('unlink manda la MISMA url que se guardó, byte a byte', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		const queue = queueWith(client, storage);
		const url = 'obsidian://open?vault=v&file=Notas%20con%20espacios';
		await queue.enqueueTaskLink('unlink', 'task-1', url, 'Notas con espacios', NOTE_TARGET);

		await queue.flush();

		expect(client.taskUnlink).toHaveBeenCalledWith({ taskId: 'task-1', url, label: 'Notas con espacios' });
	});

	it('un 404 (tarea de otra cuenta o borrada) deja la operación rejected, no se reintenta', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		client.taskLink.mockResolvedValue(failure('not_found', 404));
		const queue = queueWith(client, storage);
		await queue.enqueueTaskLink('link', 'task-ajena', 'url', 'Cocina', NOTE_TARGET);

		await queue.flush();

		expect(storage.operations[0]?.state).toBe('rejected');
		expect(client.taskLinks).not.toHaveBeenCalled();
	});

	it('si la url mandada no aparece en la relectura, se queda en sent con un intento más', async () => {
		const storage = memoryStorage();
		const client = fakeClient();
		const queue = queueWith(client, storage);
		await queue.enqueueTaskLink('link', 'task-1', 'url-nueva', 'Cocina', NOTE_TARGET);
		client.taskLinks.mockResolvedValue({ ok: true, value: [] });

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
			return { ok: true, value: {} };
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
