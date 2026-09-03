import { describe, expect, it, vi } from 'vitest';

import {
	LumbreClient,
	type LumbreRequestInit,
	type LumbreRequestFn,
	type MutationOp,
} from './client';

const ORIGIN = 'https://app.lumbre.pro';

function clientWith(request: LumbreRequestFn, token: string | null = 'tok-123'): LumbreClient {
	return new LumbreClient({ apiOrigin: ORIGIN, getToken: async () => token, request });
}

function respondWith(status: number, json?: unknown): LumbreRequestFn {
	return async () => ({ status, json });
}

/** Cliente que además apunta las peticiones que recibe, para poder aseverarlas. */
function recordingClient(json?: unknown): { client: LumbreClient; calls: LumbreRequestInit[] } {
	const calls: LumbreRequestInit[] = [];
	const client = clientWith(async (init) => {
		calls.push(init);
		return { status: 200, json };
	});
	return { client, calls };
}

/** Promesa que se resuelve desde fuera, para poder parar una petición a medias. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = (): void => undefined;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/** Una tarea con la FORMA exacta que devuelve `serializeTask` en el repo de Lumbre. */
function apiTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 'task-1',
		content: 'Comprar pan',
		notes: null,
		notesUpdatedAt: null,
		done: false,
		cancelledAt: null,
		archivedAt: null,
		priority: 2,
		date: '2026-09-03',
		deadline: null,
		list: 'Casa',
		somedayListId: 'list-1',
		section: 'Compras',
		sectionId: 'section-1',
		parentId: null,
		recurrence: null,
		seriesId: null,
		createdAt: '2026-09-01T10:00:00.000Z',
		attachments: [],
		...overrides,
	};
}

describe('LumbreClient.ping', () => {
	it('devuelve no_token cuando no hay token guardado', async () => {
		const request = vi.fn(respondWith(200));

		const result = await clientWith(request, null).ping();

		expect(result).toEqual({ ok: false, reason: 'no_token' });
		expect(request).not.toHaveBeenCalled();
	});

	it('devuelve ok con un 200', async () => {
		expect(await clientWith(respondWith(200)).ping()).toEqual({ ok: true });
	});

	it.each([401, 403])('devuelve unauthorized con un %i', async (status) => {
		expect(await clientWith(respondWith(status)).ping()).toEqual({
			ok: false,
			reason: 'unauthorized',
			status,
		});
	});

	it('devuelve bad_request con un 400', async () => {
		expect(await clientWith(respondWith(400)).ping()).toEqual({
			ok: false,
			reason: 'bad_request',
			status: 400,
		});
	});

	it('devuelve rate_limited con un 429', async () => {
		expect(await clientWith(respondWith(429)).ping()).toEqual({
			ok: false,
			reason: 'rate_limited',
			status: 429,
		});
	});

	it('devuelve server con un 500', async () => {
		expect(await clientWith(respondWith(500)).ping()).toEqual({
			ok: false,
			reason: 'server',
			status: 500,
		});
	});

	it('devuelve network cuando la petición lanza', async () => {
		const request: LumbreRequestFn = async () => {
			throw new Error('getaddrinfo ENOTFOUND');
		};

		expect(await clientWith(request).ping()).toEqual({ ok: false, reason: 'network' });
	});

	it('pide la URL exacta con la cabecera Authorization exacta', async () => {
		const { client, calls } = recordingClient();

		await client.ping();

		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe('https://app.lumbre.pro/api/tasks?limit=1&notes=none');
		expect(calls[0]?.headers['Authorization']).toBe('Bearer tok-123');
		expect(calls[0]?.method).toBe('GET');
	});
});

describe('LumbreClient.listTasks', () => {
	it('monta la query con los parámetros que acepta el endpoint', async () => {
		const { client, calls } = recordingClient([]);

		await client.listTasks({
			scope: 'upcoming',
			days: 3,
			list: 'Casa',
			section: 'Compras',
			includeDone: true,
			limit: 50,
			notes: 'length',
		});

		expect(calls[0]?.url).toBe(
			'https://app.lumbre.pro/api/tasks?scope=upcoming&days=3&list=Casa&section=Compras&includeDone=true&limit=50&notes=length',
		);
	});

	it('sin parámetros pide /api/tasks pelado', async () => {
		const { client, calls } = recordingClient([]);

		await client.listTasks();

		expect(calls[0]?.url).toBe('https://app.lumbre.pro/api/tasks');
	});

	it('traduce la prioridad numérica y la residencia de la tarea', async () => {
		const { client } = recordingClient([apiTask(), apiTask({ id: 'task-2', priority: null })]);

		const result = await client.listTasks();

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value[0]).toMatchObject({
			id: 'task-1',
			content: 'Comprar pan',
			priority: 'p2',
			list: { id: 'list-1', name: 'Casa' },
			section: { id: 'section-1', name: 'Compras' },
			done: false,
			cancelledAt: null,
		});
		// Campos que la API todavía no manda: valor por defecto, no invención.
		expect(result.value[0]).toMatchObject({ someday: false, time: null, rolloverCount: 0 });
		expect(result.value[1]?.priority).toBe('p4');
	});

	it('una tarea sin lista sale con list null', async () => {
		const { client } = recordingClient([apiTask({ somedayListId: null, list: null })]);

		const result = await client.listTasks();

		expect(result.ok && result.value[0]?.list).toBeNull();
	});
});

describe('LumbreClient.getTask y getTasksByIds', () => {
	it('getTask pide ?id= y devuelve la primera tarea', async () => {
		const { client, calls } = recordingClient([apiTask()]);

		const result = await client.getTask('task-1');

		expect(calls[0]?.url).toBe('https://app.lumbre.pro/api/tasks?id=task-1');
		expect(result.ok && result.value?.id).toBe('task-1');
	});

	it('getTask devuelve null cuando la respuesta viene vacía', async () => {
		const { client } = recordingClient([]);

		expect(await client.getTask('task-1')).toEqual({ ok: true, value: null });
	});

	it('getTasksByIds pide ?ids= separado por comas y no llama con la lista vacía', async () => {
		const { client, calls } = recordingClient([apiTask()]);

		expect(await client.getTasksByIds([])).toEqual({ ok: true, value: [] });
		expect(calls).toHaveLength(0);

		await client.getTasksByIds(['a', 'b']);
		expect(calls[0]?.url).toBe('https://app.lumbre.pro/api/tasks?ids=a%2Cb');
	});
});

describe('LumbreClient.listLists', () => {
	it('pide includeLists=1 y lee el array lists', async () => {
		const { client, calls } = recordingClient({
			lists: [{ id: 'list-1', name: 'Casa', taskCount: 4 }],
		});

		const result = await client.listLists();

		expect(calls[0]?.url).toBe('https://app.lumbre.pro/api/tasks?includeLists=1');
		expect(result.ok && result.value[0]).toEqual({
			id: 'list-1',
			name: 'Casa',
			icon: null,
			color: null,
			parentListId: null,
			taskCount: 4,
		});
	});
});

describe('LumbreClient.createTask', () => {
	it('manda el clientTaskId y solo las claves informadas', async () => {
		const { client, calls } = recordingClient({ ok: true });

		await client.createTask(
			{ title: 'Comprar pan', list: 'Casa', priority: 'p1', date: null },
			'uuid-1',
		);

		expect(calls[0]?.url).toBe('https://app.lumbre.pro/api/ingest');
		expect(calls[0]?.method).toBe('POST');
		expect(calls[0]?.headers['Content-Type']).toBe('application/json');
		expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
			text: 'Comprar pan',
			clientTaskId: 'uuid-1',
			list: 'Casa',
			priority: 'p1',
		});
	});
});

describe('LumbreClient.mutate', () => {
	it('complete manda done true por defecto', async () => {
		const { client, calls } = recordingClient({ ok: true });

		await client.mutate({ op: 'complete', taskId: 'task-1' });

		expect(calls[0]?.url).toBe('https://app.lumbre.pro/api/mutations');
		expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
			taskId: 'task-1',
			kind: 'complete',
			payload: { done: true },
		});
	});

	it('update traduce la prioridad al nivel numérico', async () => {
		const { client, calls } = recordingClient({ ok: true });

		await client.mutate({ op: 'update', taskId: 'task-1', priority: 'p3', notes: 'nota' });

		expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
			taskId: 'task-1',
			kind: 'update',
			payload: { notes: 'nota', priority: 3 },
		});
	});

	it('update con p4 manda priority null, que es quitar la prioridad', async () => {
		const { client, calls } = recordingClient({ ok: true });

		await client.mutate({ op: 'update', taskId: 'task-1', priority: 'p4' });

		expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
			taskId: 'task-1',
			kind: 'update',
			payload: { priority: null },
		});
	});

	it('completeSubtask es un complete dirigido al id de la subtarea', async () => {
		const { client, calls } = recordingClient({ ok: true });

		await client.mutate({ op: 'completeSubtask', subtaskId: 'sub-1', done: false });

		expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
			taskId: 'sub-1',
			kind: 'complete',
			payload: { done: false },
		});
	});

	it.each<[MutationOp, string, Record<string, unknown>]>([
		[{ op: 'reschedule', taskId: 't', date: null }, 'reschedule', { date: null }],
		[{ op: 'setSection', taskId: 't', section: 'A' }, 'setSection', { section: 'A' }],
		[{ op: 'moveToList', taskId: 't', listId: null }, 'moveToList', { listId: null }],
		[{ op: 'cancel', taskId: 't' }, 'cancel', { cancelled: true }],
		[{ op: 'restore', taskId: 't' }, 'restore', {}],
		[{ op: 'addSubtask', taskId: 't', subtasks: ['a'] }, 'addSubtask', { subtasks: ['a'] }],
	])('traduce %o al kind del servidor', async (op, kind, payload) => {
		const { client, calls } = recordingClient({ ok: true });

		await client.mutate(op);

		expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ taskId: 't', kind, payload });
	});
});

describe('LumbreClient.batch', () => {
	it('manda ops con la forma del endpoint y devuelve el informe', async () => {
		const { client, calls } = recordingClient({
			ok: true,
			results: [{ index: 0, type: 'ingest', ok: true, id: 'uuid-1' }],
		});

		const result = await client.batch([
			{ type: 'create', clientTaskId: 'uuid-1', draft: { title: 'Uno' } },
			{ type: 'mutate', op: { op: 'complete', taskId: 'task-1' } },
		]);

		expect(calls[0]?.url).toBe('https://app.lumbre.pro/api/batch');
		expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
			ops: [
				{ type: 'ingest', task: { text: 'Uno', clientTaskId: 'uuid-1' } },
				{ type: 'mutate', taskId: 'task-1', kind: 'complete', payload: { done: true } },
			],
		});
		expect(result.ok && result.value).toHaveLength(1);
	});

	it('con la lista vacía no llama a la red', async () => {
		const { client, calls } = recordingClient();

		expect(await client.batch([])).toEqual({ ok: true, value: [] });
		expect(calls).toHaveLength(0);
	});
});

describe('LumbreClient.flush', () => {
	it('pide POST a /api/sync/flush sin cuerpo', async () => {
		const { client, calls } = recordingClient({ ok: true });

		await client.flush();

		expect(calls[0]?.url).toBe('https://app.lumbre.pro/api/sync/flush');
		expect(calls[0]?.method).toBe('POST');
		expect(calls[0]?.body).toBeUndefined();
	});

	it('comparte el flush en vuelo: dos llamadas a la vez son UNA petición', async () => {
		const gates = [deferred(), deferred()];
		let call = 0;
		const request = vi.fn<LumbreRequestFn>(async () => {
			await gates[call++]?.promise;
			return { status: 200, json: { ok: true } };
		});
		const client = clientWith(request);

		const first = client.flush();
		const second = client.flush();
		await vi.waitFor(() => {
			expect(request).toHaveBeenCalledTimes(1);
		});

		gates[0]?.resolve();
		expect(await first).toEqual({ ok: true });
		expect(await second).toEqual({ ok: true });
		expect(request).toHaveBeenCalledTimes(1);

		// Terminado el primero, el siguiente flush SÍ vuelve a llamar.
		const third = client.flush();
		gates[1]?.resolve();
		await third;
		expect(request).toHaveBeenCalledTimes(2);
	});
});
