import { describe, expect, it, vi } from 'vitest';

import {
	ChangeFeed,
	CHANGE_FEED_INTERVAL_MS,
	CHANGE_FEED_MAX_PAGES,
	CHANGE_FEED_PAGE_LIMIT,
	pollChangeFeedOnce,
	startChangeFeedPoll,
	type ChangeFeedPollDeps,
} from './change-feed';
import type { LumbreResult } from './client';
import type { LumbreTask } from './types';

function task(id: string, updatedAt: string): LumbreTask {
	return {
		id,
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
		parentId: null,
		updatedAt,
	};
}

/** Un `tasksUpdatedSince` que sirve páginas fijadas de antemano, y apunta las llamadas. */
function pagedClient(pages: LumbreTask[][]) {
	const calls: { since: string }[] = [];
	let index = 0;
	return {
		calls,
		tasksUpdatedSince: vi.fn(async ({ since }: { since: string }): Promise<LumbreResult<LumbreTask[]>> => {
			calls.push({ since });
			const page = pages[index] ?? [];
			index += 1;
			return { ok: true, value: page };
		}),
	};
}

describe('ChangeFeed.poll', () => {
	it('una página no llena avanza el cursor al updatedAt mayor y no repite', async () => {
		const client = pagedClient([[task('1', '2026-09-05T10:00:00.000Z'), task('2', '2026-09-05T10:00:01.000Z')]]);
		const feed = new ChangeFeed({ client }, '2026-09-05T09:00:00.000Z');

		const result = await feed.poll();

		expect(result?.tasks.map((t) => t.id)).toEqual(['1', '2']);
		expect(result?.pages).toBe(1);
		expect(feed.currentCursor()).toBe('2026-09-05T10:00:01.000Z');
		expect(client.tasksUpdatedSince).toHaveBeenCalledTimes(1);
		expect(client.calls[0]?.since).toBe('2026-09-05T09:00:00.000Z');
	});

	it('un delta vacío no mueve el cursor', async () => {
		const client = pagedClient([[]]);
		const feed = new ChangeFeed({ client }, '2026-09-05T09:00:00.000Z');

		const result = await feed.poll();

		expect(result?.tasks).toEqual([]);
		expect(feed.currentCursor()).toBe('2026-09-05T09:00:00.000Z');
	});

	it('página llena: pide una segunda con since = último updatedAt menos 1 ms', async () => {
		const full = Array.from({ length: CHANGE_FEED_PAGE_LIMIT }, (_, i) =>
			task(`t${i}`, '2026-09-05T10:00:00.000Z'),
		);
		const client = pagedClient([full, [task('last', '2026-09-05T10:00:01.000Z')]]);
		const feed = new ChangeFeed({ client }, '2026-09-05T09:00:00.000Z');

		const result = await feed.poll();

		expect(client.tasksUpdatedSince).toHaveBeenCalledTimes(2);
		// El último elemento de la página llena tiene ese updatedAt: la segunda
		// petición pide desde un milisegundo antes, para no perder gemelas.
		expect(client.calls[1]?.since).toBe('2026-09-05T09:59:59.999Z');
		expect(result?.pages).toBe(2);
		expect(feed.currentCursor()).toBe('2026-09-05T10:00:01.000Z');
	});

	it('el empate en el borde de una página llena no duplica ni se pierde', async () => {
		// Los tres últimos de la página llena comparten EXACTAMENTE el mismo
		// updatedAt; la repetición trae ese instante otra vez (incluidas las
		// que ya se vieron) y `poll` las descarta por id.
		const tied = '2026-09-05T10:00:00.000Z';
		const full = [
			...Array.from({ length: CHANGE_FEED_PAGE_LIMIT - 2 }, (_, i) => task(`t${i}`, '2026-09-05T09:59:00.000Z')),
			task('tie-1', tied),
			task('tie-2', tied),
		];
		// La repetición (since = tied - 1ms) vuelve a traer las dos gemelas del
		// empate MÁS una tercera que se había quedado fuera del corte anterior.
		const second = [task('tie-1', tied), task('tie-2', tied), task('tie-3', tied)];
		const client = pagedClient([full, second]);
		const feed = new ChangeFeed({ client }, '2026-09-05T09:00:00.000Z');

		const result = await feed.poll();

		const ids = result?.tasks.map((t) => t.id) ?? [];
		expect(ids.filter((id) => id === 'tie-1')).toHaveLength(1);
		expect(ids.filter((id) => id === 'tie-2')).toHaveLength(1);
		expect(ids).toContain('tie-3');
		expect(feed.currentCursor()).toBe(tied);
	});

	it('si una página falla, el cursor no se mueve y devuelve null', async () => {
		const client = {
			tasksUpdatedSince: vi.fn(
				async (): Promise<LumbreResult<LumbreTask[]>> => ({ ok: false, reason: 'network' }),
			),
		};
		const feed = new ChangeFeed({ client }, '2026-09-05T09:00:00.000Z');

		const result = await feed.poll();

		expect(result).toBeNull();
		expect(feed.currentCursor()).toBe('2026-09-05T09:00:00.000Z');
	});

	it('un tope de páginas patológico se corta y conserva el progreso hecho', async () => {
		const tied = '2026-09-05T10:00:00.000Z';
		const alwaysFull = Array.from({ length: CHANGE_FEED_PAGE_LIMIT }, (_, i) => task(`t${i}`, tied));
		const client = pagedClient(Array.from({ length: CHANGE_FEED_MAX_PAGES + 5 }, () => alwaysFull));
		const feed = new ChangeFeed({ client }, '2026-09-05T09:00:00.000Z');

		const result = await feed.poll();

		expect(client.tasksUpdatedSince).toHaveBeenCalledTimes(CHANGE_FEED_MAX_PAGES);
		expect(result?.pages).toBe(CHANGE_FEED_MAX_PAGES);
		expect(feed.currentCursor()).toBe(tied);
	});
});

describe('startChangeFeedPoll', () => {
	it('registra UN temporizador de un minuto', () => {
		const registered: { handler: () => void; ms: number }[] = [];
		startChangeFeedPoll({
			...pollDeps(),
			register: (handler, ms) => registered.push({ handler, ms }),
		});

		expect(registered).toHaveLength(1);
		expect(registered[0]?.ms).toBe(CHANGE_FEED_INTERVAL_MS);
	});
});

/** Deps de `pollChangeFeedOnce` con guardas todas en verde y un feed que devuelve un delta vacío. */
function pollDeps(overrides: Partial<ChangeFeedPollDeps> = {}): ChangeFeedPollDeps {
	return {
		feed: { poll: vi.fn(async () => ({ tasks: [], pages: 1 })) },
		isNeeded: () => true,
		isOnline: () => true,
		isHidden: () => false,
		isReadsLocked: () => false,
		refreshQueries: vi.fn(async () => undefined),
		notesForTask: () => [],
		refreshLinksForNote: vi.fn(async () => undefined),
		notifyDataChange: vi.fn(),
		register: () => undefined,
		...overrides,
	};
}

describe('pollChangeFeedOnce: guardas', () => {
	it('sin nada montado que lo necesite, no pide', async () => {
		const deps = pollDeps({ isNeeded: () => false });
		await pollChangeFeedOnce(deps);
		expect(deps.feed.poll).not.toHaveBeenCalled();
	});

	it('sin conexión, no pide', async () => {
		const deps = pollDeps({ isOnline: () => false });
		await pollChangeFeedOnce(deps);
		expect(deps.feed.poll).not.toHaveBeenCalled();
	});

	it('con la pestaña oculta, no pide', async () => {
		const deps = pollDeps({ isHidden: () => true });
		await pollChangeFeedOnce(deps);
		expect(deps.feed.poll).not.toHaveBeenCalled();
	});

	it('con el pestillo de lecturas echado, no pide', async () => {
		const deps = pollDeps({ isReadsLocked: () => true });
		await pollChangeFeedOnce(deps);
		expect(deps.feed.poll).not.toHaveBeenCalled();
	});
});

describe('pollChangeFeedOnce: reacción al delta', () => {
	it('un delta vacío no dispara ninguna ronda', async () => {
		const deps = pollDeps({ feed: { poll: vi.fn(async () => ({ tasks: [], pages: 1 })) } });

		await pollChangeFeedOnce(deps);

		expect(deps.refreshQueries).not.toHaveBeenCalled();
		expect(deps.notifyDataChange).not.toHaveBeenCalled();
	});

	it('un fallo del feed (null) tampoco dispara nada', async () => {
		const deps = pollDeps({ feed: { poll: vi.fn(async () => null) } });

		await pollChangeFeedOnce(deps);

		expect(deps.refreshQueries).not.toHaveBeenCalled();
		expect(deps.notifyDataChange).not.toHaveBeenCalled();
	});

	it('un delta con 3 tareas dispara UNA ronda de refreshQueries', async () => {
		const tasks = [task('1', 'x'), task('2', 'x'), task('3', 'x')];
		const deps = pollDeps({ feed: { poll: vi.fn(async () => ({ tasks, pages: 1 })) } });

		await pollChangeFeedOnce(deps);

		expect(deps.refreshQueries).toHaveBeenCalledTimes(1);
		expect(deps.notifyDataChange).toHaveBeenCalledTimes(1);
	});

	it('relee solo las notas vinculadas a alguna tarea del delta, sin repetir ruta', async () => {
		const tasks = [task('1', 'x'), task('2', 'x')];
		const notesForTask = vi.fn((taskId: string) =>
			taskId === '1' ? ['nota-a.md', 'nota-b.md'] : ['nota-b.md'],
		);
		const refreshLinksForNote = vi.fn(async () => undefined);
		const deps = pollDeps({
			feed: { poll: vi.fn(async () => ({ tasks, pages: 1 })) },
			notesForTask,
			refreshLinksForNote,
		});

		await pollChangeFeedOnce(deps);

		expect(refreshLinksForNote).toHaveBeenCalledTimes(2);
		expect(refreshLinksForNote).toHaveBeenCalledWith('nota-a.md');
		expect(refreshLinksForNote).toHaveBeenCalledWith('nota-b.md');
	});

	it('sin ninguna nota vinculada, no relee ninguna pero sí avisa al panel', async () => {
		const tasks = [task('1', 'x')];
		const refreshLinksForNote = vi.fn(async () => undefined);
		const deps = pollDeps({
			feed: { poll: vi.fn(async () => ({ tasks, pages: 1 })) },
			notesForTask: () => [],
			refreshLinksForNote,
		});

		await pollChangeFeedOnce(deps);

		expect(refreshLinksForNote).not.toHaveBeenCalled();
		expect(deps.notifyDataChange).toHaveBeenCalledTimes(1);
	});
});
