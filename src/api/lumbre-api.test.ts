import { describe, expect, it, vi } from 'vitest';

import { QueryCache } from '../blocks/query-cache';
import { Logger } from '../diagnostics/logger';
import type { LumbreTaskLink } from '../links/link-store';
import type { LumbreResult } from '../lumbre/client';
import type { CreateOperation, LinkTarget, StatusOperation } from '../lumbre/queue';
import type { LumbreList, LumbreTask, TaskDraft } from '../lumbre/types';
import { LumbreApi, TASKS_CHANGED_EVENT, type LumbreApiDeps } from './lumbre-api';

function task(id: string, content = 'Comprar pan'): LumbreTask {
	return {
		id,
		content,
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
	};
}

function list(id: string, name: string): LumbreList {
	return { id, name, icon: null, color: null, parentListId: null, pinned: false, taskCount: 0 };
}

/** Lo que la cola apunta de cada llamada, para poder afirmar sobre ello. */
interface QueueLog {
	creates: { draft: TaskDraft; target: LinkTarget }[];
	statuses: { taskId: string; done: boolean }[];
	flushes: number;
}

function harness(overrides: Partial<LumbreApiDeps> = {}): {
	api: LumbreApi;
	log: QueueLog;
	opened: string[];
	triggered: string[];
	tasks: LumbreTask[];
	logger: Logger;
} {
	const log: QueueLog = { creates: [], statuses: [], flushes: 0 };
	const opened: string[] = [];
	const triggered: string[] = [];
	const tasks = [task('1', 'Comprar pan #casa'), task('2', 'Escribir el informe')];

	const cache = new QueryCache({
		client: {
			listTasks: async (): Promise<LumbreResult<LumbreTask[]>> => ({ ok: true, value: tasks }),
		},
		now: () => 0,
	});

	const deps: LumbreApiDeps = {
		version: '9.9.9',
		client: {
			ping: async (): Promise<LumbreResult<void>> => ({ ok: true, value: undefined }),
			getTask: async (id: string): Promise<LumbreResult<LumbreTask | null>> => ({
				ok: true,
				value: tasks.find((candidate) => candidate.id === id) ?? null,
			}),
		},
		queue: {
			enqueueCreate: async (draft, target): Promise<CreateOperation> => {
				log.creates.push({ draft, target });
				return { clientTaskId: 'nuevo-id' } as CreateOperation;
			},
			enqueueStatus: async (taskId, done): Promise<StatusOperation> => {
				log.statuses.push({ taskId, done });
				return {} as StatusOperation;
			},
			flush: async (): Promise<void> => {
				log.flushes += 1;
			},
			pending: () => [],
		},
		links: {
			linksForNote: (path: string): LumbreTaskLink[] =>
				path === 'Notas/Cocina.md' ? ([{ id: 'link-1' }] as LumbreTaskLink[]) : [],
		},
		cache,
		lists: {
			get: async (): Promise<LumbreList[]> => [list('lista-1', 'Casa')],
			nameFor: (raw: string) => (raw === 'lista-1' || raw === 'Casa' ? 'Casa' : null),
		},
		openUrl: (url: string) => {
			opened.push(url);
		},
		webOrigin: () => 'https://app.lumbre.pro',
		isDesktopApp: () => true,
		triggerWorkspace: (event: string) => {
			triggered.push(event);
		},
		// Sin consola: en los tests el registro solo tiene que llenar su buffer,
		// que es lo que se afirma.
		logger: Logger.create({ console: null }).child('api'),
		buildReport: () => 'informe de prueba',
		weeklySnapshot: async (options): Promise<string> =>
			`## Foto de prueba (${options?.seed ?? 'sin semilla'})`,
		...overrides,
	};

	return { api: new LumbreApi(deps), log, opened, triggered, tasks, logger: deps.logger };
}

describe('LumbreApi', () => {
	it('publica la versión del plugin', () => {
		expect(harness().api.version).toBe('9.9.9');
	});

	it('isConnected pregunta al cliente y emite connection-changed al cambiar', async () => {
		const { api } = harness();
		const seen: boolean[] = [];
		api.on('connection-changed', (connected) => {
			seen.push(connected);
		});

		expect(await api.isConnected()).toBe(true);
		// La segunda vez el estado no ha cambiado: no se repite el evento.
		await api.isConnected();
		expect(seen).toEqual([true]);
	});

	it('listTasks acepta el texto del bloque', async () => {
		const { api } = harness();
		expect(await api.listTasks('scope: today')).toHaveLength(2);
	});

	it('listTasks acepta un objeto con las mismas claves', async () => {
		const { api } = harness();
		const filtered = await api.listTasks({ scope: 'all', tag: 'casa' });
		expect(filtered.map((item) => item.id)).toEqual(['1']);
	});

	it('listTasks aplica el tope en cliente', async () => {
		const { api } = harness();
		expect(await api.listTasks({ scope: 'all', limit: 1 })).toHaveLength(1);
	});

	it('listTasks lanza con una consulta que no se entiende', async () => {
		const { api } = harness();
		await expect(api.listTasks('scope: cuandosea')).rejects.toThrow(/scope/);
	});

	it('listTasks va por la caché: dos llamadas iguales, una petición', async () => {
		const listTasks = vi.fn(
			async (): Promise<LumbreResult<LumbreTask[]>> => ({ ok: true, value: [task('1')] }),
		);
		const { api } = harness({ cache: new QueryCache({ client: { listTasks }, now: () => 0 }) });

		await api.listTasks('');
		await api.listTasks('');
		expect(listTasks).toHaveBeenCalledTimes(1);
	});

	it('listTasks devuelve la última lectura confirmada cuando la red falla', async () => {
		let response: LumbreResult<LumbreTask[]> = { ok: true, value: [task('1')] };
		const cache = new QueryCache({
			client: { listTasks: async (): Promise<LumbreResult<LumbreTask[]>> => response },
			ttlMs: 0,
			now: () => 0,
		});
		const { api } = harness({ cache });

		await api.listTasks('');
		response = { ok: false, reason: 'network' };
		expect(await api.listTasks('')).toHaveLength(1);
	});

	it('listTasks lanza si nunca hubo lectura buena y la petición falla', async () => {
		const cache = new QueryCache({
			client: {
				listTasks: async (): Promise<LumbreResult<LumbreTask[]>> => ({
					ok: false,
					reason: 'network',
				}),
			},
			now: () => 0,
		});
		const { api } = harness({ cache });
		await expect(api.listTasks('')).rejects.toThrow(/conectar/);
	});

	it('getTask devuelve la tarea, o null si no existe', async () => {
		const { api } = harness();
		expect(await api.getTask('1')).not.toBeNull();
		expect(await api.getTask('nope')).toBeNull();
	});

	it('getTask lanza con el motivo cuando la lectura falla', async () => {
		const { api } = harness({
			client: {
				ping: async (): Promise<LumbreResult<void>> => ({ ok: true, value: undefined }),
				getTask: async (): Promise<LumbreResult<LumbreTask | null>> => ({
					ok: false,
					reason: 'unauthorized',
					status: 401,
				}),
			},
		});
		await expect(api.getTask('1')).rejects.toThrow(/token/);
	});

	it('listLists sale de la caché de listas', async () => {
		expect(await harness().api.listLists()).toEqual([list('lista-1', 'Casa')]);
	});

	it('createTask encola, drena y devuelve el clientTaskId', async () => {
		const { api, log } = harness();
		const id = await api.createTask({ title: 'Comprar pan' }, { notePath: 'Notas/Cocina.md' });

		expect(id).toBe('nuevo-id');
		expect(log.creates).toHaveLength(1);
		expect(log.creates[0]?.draft.title).toBe('Comprar pan');
		expect(log.creates[0]?.target.notePath).toBe('Notas/Cocina.md');
		expect(log.flushes).toBe(1);
	});

	it('createTask sin destino deja el hueco de la nota vacío', async () => {
		const { api, log } = harness();
		await api.createTask({ title: 'Suelta' });
		expect(log.creates[0]?.target).toEqual({ notePath: '', label: 'Sin nota', excerpt: null });
	});

	it('completeTask y reopenTask encolan el estado, no lo escriben a pelo', async () => {
		const { api, log } = harness();
		await api.completeTask('1');
		await api.reopenTask('2');

		expect(log.statuses).toEqual([
			{ taskId: '1', done: true },
			{ taskId: '2', done: false },
		]);
		expect(log.flushes).toBe(2);
	});

	it('cada mutación emite tasks-changed y el evento del workspace', async () => {
		const { api, triggered } = harness();
		const seen: number[] = [];
		api.on('tasks-changed', () => {
			seen.push(1);
		});

		await api.completeTask('1');
		expect(seen).toHaveLength(1);
		expect(triggered).toEqual([TASKS_CHANGED_EVENT]);
	});

	it('on devuelve cómo darse de baja', async () => {
		const { api } = harness();
		const seen: number[] = [];
		const off = api.on('tasks-changed', () => {
			seen.push(1);
		});

		await api.completeTask('1');
		off();
		await api.completeTask('1');
		expect(seen).toHaveLength(1);
	});

	it('linksForNote devuelve los vínculos de esa nota', () => {
		const { api } = harness();
		expect(api.linksForNote('Notas/Cocina.md')).toHaveLength(1);
		expect(api.linksForNote('Otra.md')).toHaveLength(0);
	});

	it('openInLumbre abre el esquema nativo en escritorio y la web en móvil', () => {
		const desktop = harness();
		desktop.api.openInLumbre('task-1');
		expect(desktop.opened).toEqual(['lumbre://tarea/task-1']);

		const mobile = harness({ isDesktopApp: () => false });
		mobile.api.openInLumbre('task-1');
		expect(mobile.opened).toEqual(['https://app.lumbre.pro/?tarea=task-1']);
	});
});

describe('LumbreApi: la foto semanal', () => {
	it('devuelve el Markdown que compone el plugin y le pasa las opciones', async () => {
		const { api } = harness();

		expect(await api.weeklySnapshot()).toBe('## Foto de prueba (sin semilla)');
		expect(await api.weeklySnapshot({ seed: '2026-09-03' })).toBe('## Foto de prueba (2026-09-03)');
	});

	it('se apunta como una llamada más de la API', async () => {
		const { api, logger } = harness();

		await api.weeklySnapshot();

		const calls = logger.recent().filter((event) => event.message === 'Llamada a la API pública');
		expect(calls.map((event) => event.data)).toEqual([{ method: 'weeklySnapshot' }]);
	});
});

describe('LumbreApi: diagnóstico', () => {
	it('`diagnostics.report()` devuelve el informe que compone el plugin', () => {
		expect(harness().api.diagnostics.report()).toBe('informe de prueba');
	});

	it('`diagnostics.events()` devuelve los últimos eventos del registro', async () => {
		const { api, logger } = harness();

		await api.listLists();

		const events = api.diagnostics.events();
		expect(events.map((event) => event.message)).toContain('Llamada a la API pública');
		expect(logger.recent().length).toBeGreaterThan(0);
	});

	it('apunta UN evento por llamada, con el nombre del método', async () => {
		const { api, logger } = harness();

		await api.listTasks({ scope: 'today' });

		const calls = logger.recent().filter((event) => event.message === 'Llamada a la API pública');
		expect(calls).toHaveLength(1);
		expect(calls[0]?.data).toEqual({ method: 'listTasks' });
	});

	it('los argumentos solo se apuntan en `debug`', async () => {
		const { api, logger } = harness();
		await api.createTask({ title: 'Comprar pan' });
		expect(logger.recent().some((event) => event.message === 'Argumentos de la llamada')).toBe(
			false,
		);

		logger.setLevel('debug');
		await api.createTask({ title: 'Comprar pan' });

		const args = logger.recent().find((event) => event.message === 'Argumentos de la llamada');
		expect(args?.data).toMatchObject({ method: 'createTask', title: 'Comprar pan' });
	});
});
