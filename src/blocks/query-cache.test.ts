import { describe, expect, it, vi } from 'vitest';

import type { LumbreResult } from '../lumbre/client';
import type { LumbreTask } from '../lumbre/types';
import {
	IDLE_ENTRY_TTL_MS,
	QueryCache,
	REFRESH_COALESCE_MS,
	type QuerySnapshot,
} from './query-cache';
import { parseQuery, resolveQuery, type ResolvedQuery } from './query-parser';
import { CONTEXT_SUBTASK_TASK_CAP } from './task-context';

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

/** Una consulta resuelta a partir del texto que llevaría el bloque. */
function query(source: string): ResolvedQuery {
	const parsed = parseQuery(source);
	if (!parsed.ok) throw new Error(parsed.error);
	return resolveQuery(parsed.query, { noteListId: null, resolveList: () => null });
}

/** Cliente que devuelve siempre lo mismo y cuenta las llamadas. */
function okClient(tasks: LumbreTask[] = [task('1')]) {
	return {
		listTasks: vi.fn(
			async (): Promise<LumbreResult<LumbreTask[]>> => ({ ok: true, value: tasks }),
		),
	};
}

/** Una promesa que se resuelve desde fuera, para congelar una petición en vuelo. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

describe('QueryCache', () => {
	it('lee una vez y sirve de la caché mientras no pase el TTL', async () => {
		const client = okClient();
		const cache = new QueryCache({ client, ttlMs: 30_000, now: () => 0 });

		await cache.get(query(''));
		await cache.get(query(''));
		expect(client.listTasks).toHaveBeenCalledTimes(1);
	});

	it('vuelve a pedir cuando pasa el TTL', async () => {
		const client = okClient();
		let clock = 0;
		const cache = new QueryCache({ client, ttlMs: 30_000, now: () => clock });

		await cache.get(query(''));
		clock = 30_001;
		await cache.get(query(''));
		expect(client.listTasks).toHaveBeenCalledTimes(2);
	});

	it('dos consultas distintas no comparten entrada', async () => {
		const client = okClient();
		const cache = new QueryCache({ client, now: () => 0 });

		await cache.get(query('scope: today'));
		await cache.get(query('scope: week'));
		expect(client.listTasks).toHaveBeenCalledTimes(2);
		expect(cache.size()).toBe(2);
	});

	it('deduplica las peticiones en vuelo: dos bloques a la vez, una llamada', async () => {
		const pending = deferred<LumbreResult<LumbreTask[]>>();
		const listTasks = vi.fn(async (): Promise<LumbreResult<LumbreTask[]>> => pending.promise);
		const cache = new QueryCache({ client: { listTasks }, now: () => 0 });

		const first = cache.get(query(''));
		const second = cache.get(query(''));
		pending.resolve({ ok: true, value: [task('1')] });

		expect((await first).tasks).toHaveLength(1);
		expect((await second).tasks).toHaveLength(1);
		expect(listTasks).toHaveBeenCalledTimes(1);
	});

	it('si la lectura falla, conserva la última confirmada y guarda el motivo', async () => {
		let response: LumbreResult<LumbreTask[]> = { ok: true, value: [task('1')] };
		let clock = 0;
		const cache = new QueryCache({
			client: { listTasks: async (): Promise<LumbreResult<LumbreTask[]>> => response },
			ttlMs: 1,
			now: () => clock,
		});

		const good = await cache.get(query(''));
		expect(good.fetchedAt).toBe(0);

		clock = 100;
		response = { ok: false, reason: 'network' };
		const stale = await cache.get(query(''));
		expect(stale.tasks).toHaveLength(1);
		expect(stale.fetchedAt).toBe(0);
		expect(stale.error).not.toBeNull();
	});

	it('avisa a los suscriptores y deja de avisar al darse de baja', async () => {
		const cache = new QueryCache({ client: okClient(), now: () => 0 });
		const seen: QuerySnapshot[] = [];
		const unsubscribe = cache.subscribe(query(''), (snapshot) => {
			seen.push(snapshot);
		});

		await cache.get(query(''), true);
		const afterFirst = seen.length;
		expect(afterFirst).toBeGreaterThan(0);

		unsubscribe();
		await cache.get(query(''), true);
		expect(seen).toHaveLength(afterFirst);
	});

	it('refreshAll refresca una vez por consulta, no una vez por bloque', async () => {
		const client = okClient();
		const cache = new QueryCache({ client, now: () => 0 });

		// Dos bloques con la MISMA consulta, y uno con otra distinta.
		cache.subscribe(query(''), () => undefined);
		cache.subscribe(query(''), () => undefined);
		cache.subscribe(query('scope: week'), () => undefined);
		await cache.get(query(''));
		await cache.get(query('scope: week'));
		expect(client.listTasks).toHaveBeenCalledTimes(2);

		await cache.refreshAll();
		expect(client.listTasks).toHaveBeenCalledTimes(4);
	});

	it('refreshAll no gasta peticiones en consultas sin bloques montados', async () => {
		const client = okClient();
		const cache = new QueryCache({ client, now: () => 0 });

		await cache.get(query(''));
		expect(client.listTasks).toHaveBeenCalledTimes(1);

		await cache.refreshAll();
		expect(client.listTasks).toHaveBeenCalledTimes(1);
	});

	it('al materializar, los bloques montados reciben la lectura nueva', async () => {
		let tasks = [task('1', 'Comprar pan')];
		const cache = new QueryCache({
			client: { listTasks: async (): Promise<LumbreResult<LumbreTask[]>> => ({ ok: true, value: tasks }) },
			now: () => 0,
		});
		const seen: LumbreTask[][] = [];
		cache.subscribe(query(''), (snapshot) => {
			seen.push(snapshot.tasks);
		});

		await cache.get(query(''));
		tasks = [task('1', 'Comprar pan'), task('2', 'Y leche')];
		// Esto es lo que dispara `onMaterialized` de la cola.
		await cache.refreshAll();

		expect(seen.at(-1)).toHaveLength(2);
	});

	it('invalidate obliga a la siguiente lectura a ir al servidor', async () => {
		const client = okClient();
		const cache = new QueryCache({ client, ttlMs: 30_000, now: () => 0 });

		await cache.get(query(''));
		cache.invalidate();
		await cache.get(query(''));
		expect(client.listTasks).toHaveBeenCalledTimes(2);
	});

	it('el botón Actualizar salta el TTL', async () => {
		const client = okClient();
		const cache = new QueryCache({ client, ttlMs: 30_000, now: () => 0 });

		await cache.get(query(''));
		await cache.get(query(''), true);
		expect(client.listTasks).toHaveBeenCalledTimes(2);
	});

	it('peek no pide nada', () => {
		const client = okClient();
		const cache = new QueryCache({ client, now: () => 0 });

		expect(cache.peek(query('')).fetchedAt).toBeNull();
		expect(client.listTasks).not.toHaveBeenCalled();
	});

	it('peek de una consulta desconocida NO crea la entrada', () => {
		const cache = new QueryCache({ client: okClient(), now: () => 0 });

		cache.peek(query(''));
		expect(cache.size()).toBe(0);
	});

	it('una entrada vieja y sin bloques montados se desaloja en el siguiente refresco', async () => {
		let clock = 0;
		const cache = new QueryCache({ client: okClient(), now: () => clock });

		await cache.get(query(''));
		expect(cache.size()).toBe(1);

		clock = IDLE_ENTRY_TTL_MS + 1;
		await cache.refreshAll();
		expect(cache.size()).toBe(0);
	});

	it('una entrada sin bloques montados pero RECIENTE se conserva', async () => {
		let clock = 0;
		const cache = new QueryCache({ client: okClient(), now: () => clock });

		await cache.get(query(''));
		clock = IDLE_ENTRY_TTL_MS - 1;
		await cache.refreshAll();
		expect(cache.size()).toBe(1);
	});

	it('una entrada CON bloques montados no se desaloja por vieja', async () => {
		let clock = 0;
		const cache = new QueryCache({ client: okClient(), now: () => clock });
		cache.subscribe(query(''), () => undefined);

		await cache.get(query(''));
		clock = IDLE_ENTRY_TTL_MS * 10;
		await cache.refreshAll();
		expect(cache.size()).toBe(1);
	});

	it('refreshSoon coalesce: diez materializaciones seguidas son UNA ronda', async () => {
		const client = okClient();
		const cache = new QueryCache({ client, now: () => 0, wait: async () => undefined });
		cache.subscribe(query(''), () => undefined);
		await cache.get(query(''));
		expect(client.listTasks).toHaveBeenCalledTimes(1);

		// Esto es lo que hace `onMaterialized` con un lote de diez operaciones.
		const rounds = Array.from({ length: 10 }, () => cache.refreshSoon());
		await Promise.all(rounds);

		expect(client.listTasks).toHaveBeenCalledTimes(2);
	});

	it('refreshSoon espera la ventana de coalescencia antes de pedir nada', async () => {
		const client = okClient();
		const waits: number[] = [];
		const cache = new QueryCache({
			client,
			now: () => 0,
			wait: async (ms: number) => {
				waits.push(ms);
			},
		});
		cache.subscribe(query(''), () => undefined);

		await cache.refreshSoon();
		expect(waits).toEqual([REFRESH_COALESCE_MS]);
	});

	it('una materialización posterior a la ronda sí abre otra', async () => {
		const client = okClient();
		const cache = new QueryCache({ client, now: () => 0, wait: async () => undefined });
		cache.subscribe(query(''), () => undefined);

		await cache.refreshSoon();
		await cache.refreshSoon();
		expect(client.listTasks).toHaveBeenCalledTimes(2);
	});

	it('context: none nunca llama a getTask, aunque el cliente lo tenga', async () => {
		const getTask = vi.fn();
		const cache = new QueryCache({ client: { ...okClient(), getTask }, now: () => 0 });

		await cache.get(query(''));
		expect(getTask).not.toHaveBeenCalled();
	});

	it('context: full pide subtareas de cada tarea de primer nivel con getTask', async () => {
		const tasks = [task('1'), task('2')];
		const getTask = vi.fn(async (id: string): Promise<LumbreResult<LumbreTask | null>> => ({
			ok: true,
			value: { ...task(id), subtasks: [{ id: `${id}-s1`, content: 'Paso', done: false }] },
		}));
		const cache = new QueryCache({
			client: { listTasks: async () => ({ ok: true, value: tasks }), getTask },
			now: () => 0,
		});

		const snapshot = await cache.get(query('context: full'));
		expect(getTask).toHaveBeenCalledTimes(2);
		expect(getTask).toHaveBeenCalledWith('1');
		expect(getTask).toHaveBeenCalledWith('2');
		expect(snapshot.tasks.map((t) => t.subtasks)).toEqual([
			[{ id: '1-s1', content: 'Paso', done: false }],
			[{ id: '2-s1', content: 'Paso', done: false }],
		]);
		expect(snapshot.subtasksLimited).toBe(false);
	});

	it('context: full NO pide subtareas de una subtarea (parentId no nulo)', async () => {
		const sub = { ...task('2'), parentId: '1' };
		const getTask = vi.fn(async (): Promise<LumbreResult<LumbreTask | null>> => ({
			ok: true,
			value: null,
		}));
		const cache = new QueryCache({
			client: { listTasks: async () => ({ ok: true, value: [task('1'), sub] }), getTask },
			now: () => 0,
		});

		await cache.get(query('context: full'));
		expect(getTask).toHaveBeenCalledTimes(1);
		expect(getTask).toHaveBeenCalledWith('1');
	});

	it('context: full recorta a CONTEXT_SUBTASK_TASK_CAP y lo dice en subtasksLimited', async () => {
		const many = Array.from({ length: CONTEXT_SUBTASK_TASK_CAP + 5 }, (_, i) => task(`t${i}`));
		const getTask = vi.fn(async (): Promise<LumbreResult<LumbreTask | null>> => ({
			ok: true,
			value: null,
		}));
		const cache = new QueryCache({
			client: { listTasks: async () => ({ ok: true, value: many }), getTask },
			now: () => 0,
		});

		const snapshot = await cache.get(query('context: full'));
		expect(getTask).toHaveBeenCalledTimes(CONTEXT_SUBTASK_TASK_CAP);
		expect(snapshot.subtasksLimited).toBe(true);
	});

	it('context: full sin getTask en el cliente no revienta, solo no trae subtareas', async () => {
		const cache = new QueryCache({ client: okClient([task('1')]), now: () => 0 });

		const snapshot = await cache.get(query('context: full'));
		expect(snapshot.tasks).toHaveLength(1);
		expect(snapshot.subtasksLimited).toBe(false);
	});

	it('un getTask que falla para una tarea no tira la lectura entera', async () => {
		const getTask = vi.fn(async (id: string): Promise<LumbreResult<LumbreTask | null>> =>
			id === '1' ? { ok: false, reason: 'network' } : { ok: true, value: task(id) },
		);
		const cache = new QueryCache({
			client: { listTasks: async () => ({ ok: true, value: [task('1'), task('2')] }), getTask },
			now: () => 0,
		});

		const snapshot = await cache.get(query('context: full'));
		expect(snapshot.tasks).toHaveLength(2);
		expect(snapshot.error).toBeNull();
	});

	it('onRefresh solo salta con una lectura buena', async () => {
		let response: LumbreResult<LumbreTask[]> = { ok: false, reason: 'network' };
		const onRefresh = vi.fn();
		const cache = new QueryCache({
			client: { listTasks: async (): Promise<LumbreResult<LumbreTask[]>> => response },
			ttlMs: 0,
			now: () => 0,
			onRefresh,
		});

		await cache.get(query(''));
		expect(onRefresh).not.toHaveBeenCalled();

		response = { ok: true, value: [task('1')] };
		await cache.get(query(''));
		expect(onRefresh).toHaveBeenCalledTimes(1);
	});
});
