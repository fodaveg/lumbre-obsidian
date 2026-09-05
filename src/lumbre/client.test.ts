import { describe, expect, it, vi } from 'vitest';

import { Logger, type LogLevel } from '../diagnostics/logger';
import {
	AGENT_RATE_LIMIT,
	EXPORT_RATE_LIMIT,
	LumbreClient,
	MAX_ATTACHMENT_BYTES,
	MUTATIONS_RATE_LIMIT,
	SLOW_REQUEST_MS,
	TASKS_RATE_LIMIT,
	warnThreshold,
	type LumbreRequestInit,
	type LumbreRequestFn,
	type MutationOp,
	type MutationOutcome,
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

/** El cuerpo JSON de una petición apuntada. Los cuerpos binarios no pasan por aquí. */
function jsonBody(init: LumbreRequestInit | undefined): unknown {
	const body = init?.body;
	return typeof body === 'string' ? JSON.parse(body) : {};
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
		// Campos que la fila cruda no traía: valor por defecto, no invención.
		expect(result.value[0]).toMatchObject({ someday: false, time: null });
		// `rolloverCount` no cae a cero: AUSENTE es "este Lumbre no lo informa", y un
		// cero se leería como "no ha rodado nunca", que es otra cosa.
		expect(result.value[0]).not.toHaveProperty('rolloverCount');

		const conCampo = await clientWith(respondWith(200, [apiTask({ rolloverCount: 0 })])).listTasks();
		expect(conCampo.ok && conCampo.value[0]?.rolloverCount).toBe(0);
		expect(result.value[1]?.priority).toBe('p4');
	});

	it('una tarea sin lista sale con list null', async () => {
		const { client } = recordingClient([apiTask({ somedayListId: null, list: null })]);

		const result = await client.listTasks();

		expect(result.ok && result.value[0]?.list).toBeNull();
	});
});

describe('LumbreClient.tasksUpdatedSince', () => {
	it('monta updatedSince, limit y notes; ignora scope/list/section/includeDone', async () => {
		const { client, calls } = recordingClient([]);

		await client.tasksUpdatedSince({
			since: '2026-09-05T10:00:00.000Z',
			limit: 500,
			notes: 'none',
		});

		expect(calls[0]?.url).toBe(
			'https://app.lumbre.pro/api/tasks?updatedSince=2026-09-05T10%3A00%3A00.000Z&limit=500&notes=none',
		);
	});

	it('sin limit ni notes, solo updatedSince', async () => {
		const { client, calls } = recordingClient([]);

		await client.tasksUpdatedSince({ since: '2026-09-05' });

		expect(calls[0]?.url).toBe('https://app.lumbre.pro/api/tasks?updatedSince=2026-09-05');
	});

	it('trae el updatedAt de cada tarea', async () => {
		const { client } = recordingClient([apiTask({ updatedAt: '2026-09-05T10:00:00.001Z' })]);

		const result = await client.tasksUpdatedSince({ since: '2026-09-05' });

		expect(result.ok && result.value[0]?.updatedAt).toBe('2026-09-05T10:00:00.001Z');
	});

	it('comparte el pestillo de lecturas con listTasks: un 401 apaga las dos', async () => {
		const client = clientWith(respondWith(401));

		const first = await client.tasksUpdatedSince({ since: '2026-09-05' });
		expect(first).toEqual({ ok: false, reason: 'unauthorized', status: 401 });

		const second = await client.listTasks();
		expect(second).toEqual({ ok: false, reason: 'unauthorized', status: 401 });
	});
});

describe('LumbreClient.getTask y getTasksByIds', () => {
	it('getTask pide ?id= con includeArchived y devuelve la primera tarea', async () => {
		const { client, calls } = recordingClient([apiTask()]);

		const result = await client.getTask('task-1');

		// Sin `includeArchived`, una tarea archivada responde `200 []` y no se
		// distingue de una que no existe: la cola la releería para siempre.
		expect(calls[0]?.url).toBe(
			'https://app.lumbre.pro/api/tasks?id=task-1&includeArchived=true',
		);
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
		expect(calls[0]?.url).toBe(
			'https://app.lumbre.pro/api/tasks?ids=a%2Cb&includeArchived=true',
		);
	});
});

describe('LumbreClient: la espera que pide un 429', () => {
	it('lee los segundos de Retry-After cuando el servidor los manda', async () => {
		const client = clientWith(async () => ({
			status: 429,
			headers: { 'retry-after': '12' },
		}));

		const result = await client.ping();

		expect(result).toMatchObject({ reason: 'rate_limited', retryAfterSeconds: 12 });
	});

	it('sin esa cabecera no se inventa ninguna espera', async () => {
		const client = clientWith(respondWith(429));

		const result = await client.ping();

		expect(result).toMatchObject({ reason: 'rate_limited' });
		expect(result).not.toHaveProperty('retryAfterSeconds');
	});
});

describe('LumbreClient.listLists', () => {
	it('pide includeLists=1 y lee el array lists', async () => {
		const { client, calls } = recordingClient({
			lists: [{ id: 'list-1', name: 'Casa', taskCount: 4 }],
		});

		const result = await client.listLists();

		expect(calls[0]?.url).toBe('https://app.lumbre.pro/api/tasks?includeLists=1');
		// Una lista de un servidor anterior al SHA 861cfb4d: sin icon/color/parent
		// y sin `pinned`, que caen a su valor por defecto.
		expect(result.ok && result.value[0]).toEqual({
			id: 'list-1',
			name: 'Casa',
			icon: null,
			color: null,
			parentListId: null,
			pinned: false,
			taskCount: 4,
		});
	});

	it('lee los campos que Lumbre sirve desde 861cfb4d, pinned incluido', async () => {
		const { client } = recordingClient({
			lists: [
				{
					id: 'list-1',
					name: 'Casa',
					icon: 'home',
					color: '#ff0000',
					parentListId: 'list-0',
					pinned: true,
					taskCount: 4,
				},
			],
		});

		const result = await client.listLists();

		expect(result.ok && result.value[0]).toEqual({
			id: 'list-1',
			name: 'Casa',
			icon: 'home',
			color: '#ff0000',
			parentListId: 'list-0',
			pinned: true,
			taskCount: 4,
		});
	});
});

describe('LumbreClient.exportData', () => {
	it('pide GET /api/export y devuelve el texto TAL CUAL, con sus bytes', async () => {
		const calls: LumbreRequestInit[] = [];
		const body = '{"tasks":[{"content":"Comprar café"}]}';
		const client = clientWith(async (init) => {
			calls.push(init);
			return { status: 200, text: body };
		});

		const result = await client.exportData();

		expect(calls[0]?.url).toBe('https://app.lumbre.pro/api/export');
		expect(calls[0]?.method).toBe('GET');
		expect(calls[0]?.headers['Authorization']).toBe('Bearer tok-123');
		expect(result).toEqual({ ok: true, value: { text: body, bytes: new TextEncoder().encode(body).length } });
	});

	it('cuenta los bytes en UTF-8, no en unidades UTF-16', async () => {
		const body = 'café'; // "é" ocupa 2 bytes en UTF-8, 1 unidad UTF-16
		const client = clientWith(async () => ({ status: 200, text: body }));

		const result = await client.exportData();

		expect(result.ok && result.value.bytes).toBe(5);
		expect(body.length).toBe(4);
	});

	it('un 401 apaga el pestillo de lecturas, igual que el resto de superficies', async () => {
		const client = clientWith(async () => ({ status: 401, text: '' }));

		const first = await client.exportData();
		expect(first).toEqual({ ok: false, reason: 'unauthorized', status: 401 });
		expect(client.readsAreLocked).toBe(true);
	});
});

describe('LumbreClient: cubo de /api/export, propio y más estricto que /api/tasks', () => {
	it('avisa al pasar de su propio umbral, sin gastar el cubo de /api/tasks', async () => {
		const logger = Logger.create({ console: null, level: 'info' });
		const client = new LumbreClient({
			apiOrigin: ORIGIN,
			getToken: async () => 'tok-123',
			request: async () => ({ status: 200, text: '{}' }),
			logger: logger.child('http'),
			now: () => 1000,
		});

		for (let index = 0; index < warnThreshold(EXPORT_RATE_LIMIT) + 1; index += 1) {
			await client.exportData();
		}

		const warnings = logger
			.recent()
			.filter((event) => event.message === 'Muchas peticiones en un minuto');
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.data).toMatchObject({
			limit: warnThreshold(EXPORT_RATE_LIMIT),
			serverLimit: EXPORT_RATE_LIMIT,
			method: 'GET',
			path: '/api/export',
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
		expect(jsonBody(calls[0])).toEqual({
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
		expect(jsonBody(calls[0])).toEqual({
			taskId: 'task-1',
			kind: 'complete',
			payload: { done: true },
		});
	});

	it('update traduce la prioridad al nivel numérico', async () => {
		const { client, calls } = recordingClient({ ok: true });

		await client.mutate({ op: 'update', taskId: 'task-1', priority: 'p3', notes: 'nota' });

		expect(jsonBody(calls[0])).toEqual({
			taskId: 'task-1',
			kind: 'update',
			payload: { notes: 'nota', priority: 3 },
		});
	});

	it('update con p4 manda priority null, que es quitar la prioridad', async () => {
		const { client, calls } = recordingClient({ ok: true });

		await client.mutate({ op: 'update', taskId: 'task-1', priority: 'p4' });

		expect(jsonBody(calls[0])).toEqual({
			taskId: 'task-1',
			kind: 'update',
			payload: { priority: null },
		});
	});

	it('completeSubtask es un complete dirigido al id de la subtarea', async () => {
		const { client, calls } = recordingClient({ ok: true });

		await client.mutate({ op: 'completeSubtask', subtaskId: 'sub-1', done: false });

		expect(jsonBody(calls[0])).toEqual({
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

		expect(jsonBody(calls[0])).toEqual({ taskId: 't', kind, payload });
	});

	it.each<MutationOutcome>(['applied', 'noop', 'not-found', 'queued'])(
		'lee outcome: %s de la respuesta',
		async (outcome) => {
			const { client } = recordingClient({ ok: true, outcome, outcomes: [outcome] });

			const result = await client.mutate({ op: 'complete', taskId: 'task-1' });

			expect(result).toEqual({ ok: true, value: { outcome } });
		},
	);

	it('sin outcome en la respuesta (un Lumbre anterior al contrato) sale undefined', async () => {
		const { client } = recordingClient({ ok: true });

		const result = await client.mutate({ op: 'complete', taskId: 'task-1' });

		expect(result).toEqual({ ok: true, value: { outcome: undefined } });
	});

	it('un outcome que no es de los cuatro valores sale undefined, no se propaga tal cual', async () => {
		const { client } = recordingClient({ ok: true, outcome: 'algo-inventado' });

		const result = await client.mutate({ op: 'complete', taskId: 'task-1' });

		expect(result).toEqual({ ok: true, value: { outcome: undefined } });
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
		expect(jsonBody(calls[0])).toEqual({
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

describe('LumbreClient.brl y brlJson', () => {
	it('brl pide el Markdown del día y devuelve el texto tal cual', async () => {
		const calls: LumbreRequestInit[] = [];
		const client = clientWith(async (init) => {
			calls.push(init);
			return { status: 200, text: '# BRL 2026-09-03\n\n- 11:20 Una nota\n' };
		});

		const result = await client.brl('2026-09-03');

		expect(calls[0]?.url).toBe('https://app.lumbre.pro/api/brl/2026-09-03');
		expect(calls[0]?.method).toBe('GET');
		expect(calls[0]?.headers['Authorization']).toBe('Bearer tok-123');
		expect(calls[0]?.body).toBeUndefined();
		expect(result).toEqual({ ok: true, value: '# BRL 2026-09-03\n\n- 11:20 Una nota\n' });
	});

	it('brl acepta el literal today, que resuelve el servidor', async () => {
		const { client, calls } = recordingClient();

		await client.brl('today');

		expect(calls[0]?.url).toBe('https://app.lumbre.pro/api/brl/today');
	});

	it('brlJson pide format=json y lee las entradas con su id', async () => {
		const { client, calls } = recordingClient({
			date: '2026-09-03',
			entries: [
				{ id: 'entry-1', time: '11:20', entry: '- Una nota' },
				{ id: 'entry-2', time: '', entry: '= Un pensamiento' },
				{ time: '12:00', entry: 'sin id, se descarta' },
			],
			tasks: [],
		});

		const result = await client.brlJson('today');

		expect(calls[0]?.url).toBe('https://app.lumbre.pro/api/brl/today?format=json');
		expect(result.ok && result.value).toEqual({
			date: '2026-09-03',
			entries: [
				{ id: 'entry-1', time: '11:20', entry: '- Una nota' },
				{ id: 'entry-2', time: '', entry: '= Un pensamiento' },
			],
		});
	});

	it('con el add-on apagado, el 403 sale como unauthorized con su status', async () => {
		expect(await clientWith(respondWith(403)).brl('today')).toEqual({
			ok: false,
			reason: 'unauthorized',
			status: 403,
		});
	});
});

describe('LumbreClient.mutate con createBrlEntry', () => {
	it('manda el id de la entrada en taskId y NO manda la hora', async () => {
		const { client, calls } = recordingClient({ ok: true });

		await client.mutate({
			op: 'createBrlEntry',
			entryId: 'entry-1',
			date: '2026-09-03',
			entry: '= Un pensamiento',
		});

		expect(calls[0]?.url).toBe('https://app.lumbre.pro/api/mutations');
		expect(jsonBody(calls[0])).toEqual({
			taskId: 'entry-1',
			kind: 'createBrlEntry',
			payload: { date: '2026-09-03', entry: '= Un pensamiento' },
		});
	});
});

describe('LumbreClient.listLink, listUnlink y listLinks', () => {
	it('listLink manda type link con el target completo', async () => {
		const { client, calls } = recordingClient({ ok: true, type: 'link', listId: 'list-1', deleted: false });

		const result = await client.listLink({
			listId: 'list-1',
			url: 'obsidian://open?vault=v&file=Cocina',
			label: 'Cocina',
		});

		expect(calls[0]?.url).toBe('https://app.lumbre.pro/api/list-links');
		expect(calls[0]?.method).toBe('POST');
		expect(jsonBody(calls[0])).toEqual({
			type: 'link',
			listId: 'list-1',
			target: { kind: 'obsidian', url: 'obsidian://open?vault=v&file=Cocina', label: 'Cocina' },
		});
		expect(result).toEqual({ ok: true, value: undefined });
	});

	it('listUnlink manda type unlink, con el MISMO label que se guardó', async () => {
		const { client, calls } = recordingClient({ ok: true, type: 'unlink', listId: 'list-1', removed: true });

		await client.listUnlink({ listId: 'list-1', url: 'obsidian://open?vault=v&file=Cocina', label: 'Cocina' });

		expect(jsonBody(calls[0])).toMatchObject({ type: 'unlink' });
	});

	it('un unlink con removed:false en el cuerpo sigue siendo ok: no es un fallo', async () => {
		const client = clientWith(async () => ({
			status: 200,
			json: { ok: true, type: 'unlink', listId: 'list-1', removed: false },
		}));

		const result = await client.listUnlink({ listId: 'list-1', url: 'url', label: 'Cocina' });

		expect(result).toEqual({ ok: true, value: undefined });
	});

	it('listLinks pide GET con listId y lee las filas', async () => {
		const { client, calls } = recordingClient({
			links: [
				{
					id: 'row-1',
					listId: 'list-1',
					kind: 'obsidian',
					targetKey: 'obsidian://open?vault=v&file=Cocina',
					url: 'obsidian://open?vault=v&file=Cocina',
					label: 'Cocina',
					updatedAt: '2026-09-05T10:00:00.000Z',
				},
			],
		});

		const result = await client.listLinks('list-1');

		expect(calls[0]?.url).toBe('https://app.lumbre.pro/api/list-links?listId=list-1');
		expect(calls[0]?.method).toBe('GET');
		expect(result.ok && result.value).toEqual([
			{
				id: 'row-1',
				listId: 'list-1',
				kind: 'obsidian',
				targetKey: 'obsidian://open?vault=v&file=Cocina',
				url: 'obsidian://open?vault=v&file=Cocina',
				label: 'Cocina',
				updatedAt: '2026-09-05T10:00:00.000Z',
			},
		]);
	});

	it('un 404 (lista de otra cuenta o borrada) sale como not_found, no reintentable', async () => {
		expect(await clientWith(respondWith(404)).listLink({ listId: 'x', url: 'u', label: 'l' })).toEqual({
			ok: false,
			reason: 'not_found',
			status: 404,
		});
	});
});

describe('LumbreClient.taskLink, taskUnlink y taskLinks (gemelo de list-links)', () => {
	it('taskLink manda type link con el target completo', async () => {
		const { client, calls } = recordingClient({
			ok: true,
			type: 'link',
			taskId: 'task-1',
			archived: false,
		});

		const result = await client.taskLink({
			taskId: 'task-1',
			url: 'obsidian://open?vault=v&file=Cocina',
			label: 'Cocina',
		});

		expect(calls[0]?.url).toBe('https://app.lumbre.pro/api/task-links');
		expect(calls[0]?.method).toBe('POST');
		expect(jsonBody(calls[0])).toEqual({
			type: 'link',
			taskId: 'task-1',
			target: { kind: 'obsidian', url: 'obsidian://open?vault=v&file=Cocina', label: 'Cocina' },
		});
		expect(result).toEqual({ ok: true, value: undefined });
	});

	it('taskLink sale ok aunque la tarea esté archivada (200 con archived:true, no un 409)', async () => {
		const client = clientWith(async () => ({
			status: 200,
			json: { ok: true, type: 'link', taskId: 'task-1', archived: true, link: {} },
		}));

		const result = await client.taskLink({ taskId: 'task-1', url: 'u', label: 'l' });

		expect(result).toEqual({ ok: true, value: undefined });
	});

	it('taskUnlink manda type unlink, con el MISMO label que se guardó', async () => {
		const { client, calls } = recordingClient({ ok: true, type: 'unlink', taskId: 'task-1', archived: false });

		await client.taskUnlink({ taskId: 'task-1', url: 'obsidian://open?vault=v&file=Cocina', label: 'Cocina' });

		expect(jsonBody(calls[0])).toMatchObject({ type: 'unlink' });
	});

	it('un unlink con removed:false en el cuerpo sigue siendo ok: no es un fallo', async () => {
		const client = clientWith(async () => ({
			status: 200,
			json: { ok: true, type: 'unlink', taskId: 'task-1', archived: false, removed: false },
		}));

		const result = await client.taskUnlink({ taskId: 'task-1', url: 'url', label: 'Cocina' });

		expect(result).toEqual({ ok: true, value: undefined });
	});

	it('taskLinks pide GET con taskId y lee las filas', async () => {
		const { client, calls } = recordingClient({
			links: [
				{
					id: 'row-1',
					taskId: 'task-1',
					kind: 'obsidian',
					targetKey: 'obsidian://open?vault=v&file=Cocina',
					url: 'obsidian://open?vault=v&file=Cocina',
					label: 'Cocina',
					updatedAt: '2026-09-05T10:00:00.000Z',
				},
			],
		});

		const result = await client.taskLinks('task-1');

		expect(calls[0]?.url).toBe('https://app.lumbre.pro/api/task-links?taskId=task-1');
		expect(calls[0]?.method).toBe('GET');
		expect(result.ok && result.value).toEqual([
			{
				id: 'row-1',
				taskId: 'task-1',
				kind: 'obsidian',
				targetKey: 'obsidian://open?vault=v&file=Cocina',
				url: 'obsidian://open?vault=v&file=Cocina',
				label: 'Cocina',
				updatedAt: '2026-09-05T10:00:00.000Z',
			},
		]);
	});

	it('un 404 (tarea de otra cuenta o borrada) sale como not_found, no reintentable', async () => {
		expect(await clientWith(respondWith(404)).taskLink({ taskId: 'x', url: 'u', label: 'l' })).toEqual({
			ok: false,
			reason: 'not_found',
			status: 404,
		});
	});
});

describe('LumbreClient.agent', () => {
	it('manda el texto como prompt y empareja plan con preview por índice', async () => {
		const { client, calls } = recordingClient({
			ok: true,
			dryRun: true,
			plan: [
				{ op: 'add', id: 'nueva-1', content: 'Comprar pan', list: null, extra: {} },
				{ op: 'mutation', taskId: 'task-9', kind: 'complete', payload: { done: true } },
			],
			preview: [
				{ op: 'add', taskId: 'nueva-1', text: 'Crear «Comprar pan»' },
				{ op: 'complete', taskId: 'task-9', text: 'Completar «Llamar al banco»' },
			],
			summary: 'Dos cosas.',
		});

		const result = await client.agent('compra pan y da por hecho lo del banco');

		expect(calls[0]?.url).toBe('https://app.lumbre.pro/api/agent');
		expect(calls[0]?.method).toBe('POST');
		expect(calls[0]?.headers['Content-Type']).toBe('application/json');
		expect(jsonBody(calls[0])).toEqual({ prompt: 'compra pan y da por hecho lo del banco' });
		expect(result.ok && result.value.plan).toHaveLength(2);
		expect(result.ok && result.value.preview[1]).toEqual({
			op: 'complete',
			taskId: 'task-9',
			text: 'Completar «Llamar al banco»',
		});
		expect(result.ok && result.value.summary).toBe('Dos cosas.');
	});

	it('una acción sin su línea de preview se descarta: no se aplica lo que no se ha visto', async () => {
		const { client } = recordingClient({
			plan: [
				{ op: 'add', id: 'nueva-1', content: 'Uno' },
				{ op: 'add', id: 'nueva-2', content: 'Dos' },
			],
			preview: [{ op: 'add', taskId: 'nueva-1', text: 'Crear «Uno»' }],
		});

		const result = await client.agent('dos cosas');

		expect(result.ok && result.value.plan).toHaveLength(1);
		expect(result.ok && result.value.preview).toHaveLength(1);
	});

	it('sin plan devuelve las dos listas vacías, no lanza', async () => {
		const { client } = recordingClient({ ok: true, summary: 'No he entendido nada.' });

		const result = await client.agent('   ');

		expect(result).toEqual({
			ok: true,
			value: { plan: [], preview: [], summary: 'No he entendido nada.', truncated: false },
		});
	});

	it('sin consentimiento, el 403 llega con su status para poder distinguirlo del 401', async () => {
		expect(await clientWith(respondWith(403)).agent('hola')).toEqual({
			ok: false,
			reason: 'unauthorized',
			status: 403,
		});
	});
});

describe('LumbreClient.agentConsent', () => {
	it('pide GET /api/agent/consent con el Bearer', async () => {
		const { client, calls } = recordingClient({ consentedAt: null, version: 1 });

		await client.agentConsent();

		expect(calls[0]?.url).toBe('https://app.lumbre.pro/api/agent/consent');
		expect(calls[0]?.method).toBe('GET');
		expect(calls[0]?.headers['Authorization']).toBe('Bearer tok-123');
	});

	it('un 200 con consentedAt es granted', async () => {
		const respuesta = { consentedAt: '2026-09-01T10:00:00.000Z', version: 1 };

		expect(await clientWith(respondWith(200, respuesta)).agentConsent()).toBe('granted');
	});

	it('un 200 sin consentedAt, y un 403, son los dos missing', async () => {
		expect(await clientWith(respondWith(200, { consentedAt: null })).agentConsent()).toBe('missing');
		expect(await clientWith(respondWith(403)).agentConsent()).toBe('missing');
	});

	it('un 401 es unknown, NO token malo: un Lumbre viejo lo devuelve a un token VÁLIDO', async () => {
		// Antes de aceptar el Bearer, este endpoint iba solo por cookie de sesión y
		// respondía 401 a cualquier token. Leerlo como "token caducado" sacaría un
		// aviso falso justo en la cuenta que sí lo tiene bien.
		expect(await clientWith(respondWith(401)).agentConsent()).toBe('unknown');
	});

	it('la red caída, un 429 y un 5xx también son unknown', async () => {
		const caida = clientWith(async () => {
			throw new Error('sin red');
		});

		expect(await caida.agentConsent()).toBe('unknown');
		expect(await clientWith(respondWith(429)).agentConsent()).toBe('unknown');
		expect(await clientWith(respondWith(503)).agentConsent()).toBe('unknown');
	});

	it('sin token es unknown y no se gasta la petición', async () => {
		const request = vi.fn(respondWith(200));

		expect(await clientWith(request, null).agentConsent()).toBe('unknown');
		expect(request).not.toHaveBeenCalled();
	});
});

describe('LumbreClient.batch con mutateRaw', () => {
	it('reenvía kind y payload VERBATIM, sin traducirlos', async () => {
		const { client, calls } = recordingClient({ ok: true, results: [] });

		await client.batch([
			{
				type: 'mutateRaw',
				taskId: 'task-9',
				kind: 'reschedule',
				payload: { date: '2026-09-10' },
			},
		]);

		expect(jsonBody(calls[0])).toEqual({
			ops: [
				{ type: 'mutate', taskId: 'task-9', kind: 'reschedule', payload: { date: '2026-09-10' } },
			],
		});
	});
});

describe('LumbreClient.uploadAttachment', () => {
	const BYTES = new Uint8Array([1, 2, 3, 4]).buffer;

	it('sube el binario con las cabeceras exactas de la vía de máquina', async () => {
		const { client, calls } = recordingClient({
			id: 'att-1',
			taskId: 'task-1',
			filename: 'plano de la cocina.pdf',
			mime: 'application/pdf',
			size: 4,
			storageKey: 'u/t/x',
			createdAt: 0,
		});

		const result = await client.uploadAttachment(
			'task-1',
			'plano de la cocina.pdf',
			'application/pdf',
			BYTES,
		);

		expect(calls[0]?.url).toBe('https://app.lumbre.pro/api/attachments?taskId=task-1');
		expect(calls[0]?.method).toBe('POST');
		expect(calls[0]?.headers).toEqual({
			Authorization: 'Bearer tok-123',
			// Siempre octet-stream: `text/plain` u otro mime de formulario haría que
			// SvelteKit rechazara con 403 antes de llegar al handler.
			'Content-Type': 'application/octet-stream',
			'x-lumbre-filename': 'plano%20de%20la%20cocina.pdf',
			'x-lumbre-content-type': 'application/pdf',
		});
		expect(calls[0]?.body).toBe(BYTES);
		expect(result.ok && result.value).toEqual({
			id: 'att-1',
			taskId: 'task-1',
			filename: 'plano de la cocina.pdf',
			mime: 'application/pdf',
			size: 4,
		});
	});

	it('por encima de 25 MB no gasta la petición', async () => {
		const { client, calls } = recordingClient();

		const result = await client.uploadAttachment(
			'task-1',
			'grande.mov',
			'video/quicktime',
			new ArrayBuffer(MAX_ATTACHMENT_BYTES + 1),
		);

		expect(result).toEqual({ ok: false, reason: 'too_large' });
		expect(calls).toHaveLength(0);
	});

	it('un fichero vacío tampoco se sube: el servidor lo rechazaría con un 400', async () => {
		const { client, calls } = recordingClient();

		const result = await client.uploadAttachment('task-1', 'vacio.txt', 'text/plain', new ArrayBuffer(0));

		expect(result).toEqual({ ok: false, reason: 'bad_request' });
		expect(calls).toHaveLength(0);
	});
});

describe('LumbreClient: registro de diagnóstico', () => {
	/** Cliente con un logger silencioso, para poder afirmar sobre sus eventos. */
	function loggedClient(
		options: { level?: LogLevel; status?: number; token?: string | null; now?: () => number } = {},
	): { client: LumbreClient; logger: Logger } {
		const logger = Logger.create({ console: null, level: options.level ?? 'info' });
		const client = new LumbreClient({
			apiOrigin: ORIGIN,
			getToken: async () => (options.token === undefined ? 'tok-123' : options.token),
			request: async () => ({ status: options.status ?? 200, json: [] }),
			logger: logger.child('http'),
			...(options.now === undefined ? {} : { now: options.now }),
		});
		return { client, logger };
	}

	it('apunta UN evento por petición, con método, ruta, status y milisegundos', async () => {
		const { client, logger } = loggedClient();

		await client.listTasks({ scope: 'today' });

		const events = logger.recent();
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ level: 'info', module: 'http', message: 'Petición' });
		expect(events[0]?.data).toMatchObject({ method: 'GET', path: '/api/tasks', status: 200 });
		expect(typeof events[0]?.data?.['ms']).toBe('number');
	});

	it('en `info` la ruta va SIN los parámetros de la consulta', async () => {
		const { client, logger } = loggedClient();

		await client.listTasks({ scope: 'today', list: 'Casa' });

		expect(logger.recent()[0]?.data).not.toHaveProperty('query');
		expect(logger.recent()[0]?.data?.['path']).toBe('/api/tasks');
	});

	it('en `debug` sí van los parámetros', async () => {
		const { client, logger } = loggedClient({ level: 'debug' });

		await client.listTasks({ scope: 'today' });

		expect(logger.recent()[0]?.data?.['query']).toContain('scope=today');
	});

	it('una petición fallida sale como aviso con su motivo traducido', async () => {
		const { client, logger } = loggedClient({ status: 401 });

		await client.ping();

		expect(logger.recent()[0]).toMatchObject({ level: 'warn', message: 'Petición fallida' });
		expect(logger.recent()[0]?.data).toMatchObject({ status: 401 });
	});

	it('una petición lenta sale como aviso', async () => {
		let clock = 0;
		const { client, logger } = loggedClient({
			now: () => {
				clock += SLOW_REQUEST_MS;
				return clock;
			},
		});

		await client.ping();

		expect(logger.recent().some((event) => event.message === 'Petición lenta')).toBe(true);
	});

	it('avisa UNA vez al pasar de las 100 peticiones en un minuto en el cubo de /api/tasks', async () => {
		const { client, logger } = loggedClient({ now: () => 1000 });
		const threshold = warnThreshold(TASKS_RATE_LIMIT);

		for (let index = 0; index < threshold + 5; index += 1) await client.ping();

		const warnings = logger
			.recent()
			.filter((event) => event.message === 'Muchas peticiones en un minuto');
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.data).toMatchObject({
			limit: threshold,
			serverLimit: TASKS_RATE_LIMIT,
			method: 'GET',
			path: '/api/tasks',
		});
	});

	it('CADA ENDPOINT lleva su propio cubo: 26 peticiones a /api/agent avisan aunque /api/tasks no llegue a las 100', async () => {
		// Este es el bug que midió lumbre-3a: con un cubo GLOBAL, Soplo se comía
		// un 429 en `/api/agent` a la petición 30 sin que el registro dijera nada,
		// porque el contador único todavía marcaba muy por debajo del aviso.
		const { client, logger } = loggedClient({ now: () => 1000 });

		for (let index = 0; index < warnThreshold(AGENT_RATE_LIMIT) + 1; index += 1) {
			await client.agent('hola');
		}

		const warnings = logger
			.recent()
			.filter((event) => event.message === 'Muchas peticiones en un minuto');
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.data).toMatchObject({
			limit: warnThreshold(AGENT_RATE_LIMIT),
			serverLimit: AGENT_RATE_LIMIT,
			method: 'POST',
			path: '/api/agent',
		});
	});

	it('gastar el cubo de /api/agent no afecta al de /api/mutations, y viceversa', async () => {
		const { client, logger } = loggedClient({ now: () => 1000 });

		// Se gasta el cubo entero de /api/agent (avisa una vez) sin tocar mutaciones.
		for (let index = 0; index < warnThreshold(AGENT_RATE_LIMIT) + 1; index += 1) {
			await client.agent('hola');
		}
		// Y unas pocas mutaciones, muy por debajo de SU propio aviso.
		const fewMutations = warnThreshold(MUTATIONS_RATE_LIMIT) - 1;
		for (let index = 0; index < fewMutations; index += 1) await client.mutate({ op: 'restore', taskId: 't1' });

		const warnings = logger
			.recent()
			.filter((event) => event.message === 'Muchas peticiones en un minuto');
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.data).toMatchObject({ path: '/api/agent' });
		expect(warnings.some((event) => event.data?.['path'] === '/api/mutations')).toBe(false);
	});

	it('sin token no se gasta petición y queda apuntado en `debug`', async () => {
		const { client, logger } = loggedClient({ token: null, level: 'debug' });

		await client.ping();

		expect(logger.recent()[0]?.message).toBe('Petición sin token, no se envía');
	});

	it('guarda la última prueba de conexión, para el informe', async () => {
		const { client } = loggedClient({ status: 500 });

		expect(client.lastPing).toBeNull();
		await client.ping();

		expect(client.lastPing).toMatchObject({ ok: false, reason: 'server', status: 500 });
	});

	it('el token NUNCA sale en un evento, ni siquiera en `debug`', async () => {
		const secret = 'lum_tok_9f8e7d6c5b4a3210';
		const logger = Logger.create({ console: null, level: 'debug', secrets: () => [secret] });
		const client = new LumbreClient({
			apiOrigin: ORIGIN,
			getToken: async () => secret,
			request: async () => ({ status: 200, json: [] }),
			logger: logger.child('http'),
		});

		await client.listTasks();

		expect(JSON.stringify(logger.recent())).not.toContain(secret);
	});
});

describe('LumbreClient: pestillo de lecturas ante un 401', () => {
	/**
	 * Cliente cuya red se puede aseverar: cada llamada consume el siguiente
	 * status de la lista (el último se repite si se piden más peticiones).
	 */
	function gateClient(statuses: number[]): { client: LumbreClient; request: ReturnType<typeof vi.fn> } {
		let index = 0;
		const request = vi.fn(async () => {
			const status = statuses[Math.min(index, statuses.length - 1)] ?? 200;
			index += 1;
			return { status, json: [] };
		});
		return { client: clientWith(request), request };
	}

	it('un 401 en una lectura apaga las lecturas de TODAS las superficies, aunque sean métodos distintos', async () => {
		const { client, request } = gateClient([401, 200, 200]);

		const first = await client.listTasks();
		expect(first).toEqual({ ok: false, reason: 'unauthorized', status: 401 });
		expect(request).toHaveBeenCalledTimes(1);

		// listLists() es OTRA superficie (el catálogo de listas) y OTRO método: no
		// gasta petición, aunque el servidor de mentira respondería 200 si llegara.
		const second = await client.listLists();
		expect(second).toEqual({ ok: false, reason: 'unauthorized', status: 401 });
		expect(request).toHaveBeenCalledTimes(1);

		// Y una tercera, getTask(), tampoco.
		const third = await client.getTask('t1');
		expect(third).toEqual({ ok: false, reason: 'unauthorized', status: 401 });
		expect(request).toHaveBeenCalledTimes(1);
	});

	it('un 403 NO apaga las lecturas: en este plugin es "falta el consentimiento de Soplo", no token malo', async () => {
		const { client, request } = gateClient([403, 200]);

		await client.listTasks();
		expect(request).toHaveBeenCalledTimes(1);

		const second = await client.listLists();
		expect(second.ok).toBe(true);
		expect(request).toHaveBeenCalledTimes(2);
	});

	it('agentConsent con un 401 NO apaga las lecturas: ahí un 401 es "unknown", no token malo (ver su comentario)', async () => {
		const { client, request } = gateClient([401, 200]);

		const consent = await client.agentConsent();
		expect(consent).toBe('unknown');
		expect(client.readsAreLocked).toBe(false);

		const second = await client.listTasks();
		expect(second.ok).toBe(true);
		expect(request).toHaveBeenCalledTimes(2);
	});

	it('las ESCRITURAS no se ven afectadas por el pestillo: mutate() sigue pidiendo con el pestillo echado', async () => {
		const { client, request } = gateClient([401, 200]);

		await client.listTasks();
		expect(client.readsAreLocked).toBe(true);

		const write = await client.mutate({ op: 'restore', taskId: 't1' });
		expect(write.ok).toBe(true);
		expect(request).toHaveBeenCalledTimes(2);
	});

	it('unlockReads vuelve a permitir lecturas y apunta quién lo pidió', async () => {
		const logger = Logger.create({ console: null, level: 'info' });
		const request = vi.fn(async () => ({ status: 401, json: [] }));
		const client = new LumbreClient({
			apiOrigin: ORIGIN,
			getToken: async () => 'tok-123',
			request,
			logger: logger.child('http'),
		});

		await client.listTasks();
		expect(client.readsAreLocked).toBe(true);

		client.unlockReads('settings');
		expect(client.readsAreLocked).toBe(false);
		expect(
			logger
				.recent()
				.some(
					(event) =>
						event.message === 'Lecturas encendidas de nuevo' && event.data?.['source'] === 'settings',
				),
		).toBe(true);

		request.mockResolvedValueOnce({ status: 200, json: [] });
		const result = await client.listTasks();
		expect(result.ok).toBe(true);
		expect(request).toHaveBeenCalledTimes(2);
	});

	it('sin unlockReads, un segundo 401 no vuelve a apuntar el aviso (ya está echado)', async () => {
		const logger = Logger.create({ console: null, level: 'info' });
		const client = new LumbreClient({
			apiOrigin: ORIGIN,
			getToken: async () => 'tok-123',
			request: async () => ({ status: 401, json: [] }),
			logger: logger.child('http'),
		});

		await client.listTasks();
		await client.listLists();

		const warnings = logger.recent().filter((event) => event.message === 'Lecturas apagadas: el token no vale');
		// La segunda lectura ni siquiera llega a la red (el pestillo ya está
		// echado), así que solo hay UN aviso de apagado, no dos.
		expect(warnings).toHaveLength(1);
	});
});
