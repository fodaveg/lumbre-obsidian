import { describe, expect, it, vi } from 'vitest';

import { Logger } from '../diagnostics/logger';
import type { LumbreResult } from '../lumbre/client';
import type { LumbreTask } from '../lumbre/types';
import {
	LinkStore,
	MANY_LINKS_WARNING,
	movedPath,
	renameTaskLinkChanges,
	taskLinksPastGrace,
	TASK_LINK_ORPHAN_GRACE_MS,
	type LinkStorage,
	type LumbreTaskLink,
} from './link-store';

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

function memoryStorage(): LinkStorage & { links: LumbreTaskLink[] } {
	return {
		links: [],
		readLinks(): LumbreTaskLink[] {
			return this.links;
		},
		async writeLinks(links: LumbreTaskLink[]): Promise<void> {
			this.links = links;
			await Promise.resolve();
		},
	};
}

function storeWith(storage: LinkStorage): LinkStore {
	return new LinkStore({ storage });
}

const TARGET = { label: 'Comprar pan', excerpt: 'Lista de la compra' };

describe('LinkStore: enlazar y desenlazar', () => {
	it('enlaza una tarea con una nota y la encuentra por ruta y por tarea', async () => {
		const storage = memoryStorage();
		const store = storeWith(storage);

		const link = await store.link('Cocina.md', task(), TARGET);

		expect(link).toMatchObject({
			taskId: 'task-1',
			notePath: 'Cocina.md',
			label: 'Comprar pan',
			syncState: 'materialized',
			orphanedAt: null,
		});
		expect(store.linksForNote('Cocina.md')).toHaveLength(1);
		expect(store.notesForTask('task-1')).toEqual(['Cocina.md']);
	});

	it('enlazar dos veces la MISMA tarea en la MISMA nota actualiza, no duplica', async () => {
		const storage = memoryStorage();
		const store = storeWith(storage);
		const first = await store.link('Cocina.md', task(), TARGET);

		const second = await store.link('Cocina.md', task({ done: true }), {
			label: 'Comprar pan integral',
			excerpt: null,
		});

		expect(second.id).toBe(first.id);
		expect(storage.links).toHaveLength(1);
		expect(second.label).toBe('Comprar pan integral');
		expect(second.task.done).toBe(true);
	});

	it('la misma tarea puede estar en dos notas', async () => {
		const store = storeWith(memoryStorage());
		await store.link('Cocina.md', task(), TARGET);
		await store.link('Compras.md', task(), TARGET);

		expect(store.notesForTask('task-1')).toEqual(['Cocina.md', 'Compras.md']);
	});

	it('unlink quita solo ese enlace', async () => {
		const storage = memoryStorage();
		const store = storeWith(storage);
		const link = await store.link('Cocina.md', task(), TARGET);
		await store.link('Cocina.md', task({ id: 'task-2' }), TARGET);

		await store.unlink(link.id);

		expect(storage.links).toHaveLength(1);
		expect(storage.links[0]?.taskId).toBe('task-2');
	});
});

describe('LinkStore: renombrados y borrados del vault', () => {
	it('renombrar un fichero mueve sus enlaces a la ruta nueva', async () => {
		const store = storeWith(memoryStorage());
		await store.link('Cocina.md', task(), TARGET);

		const moved = await store.renamePath('Cocina.md', 'Casa/Cocina.md');

		expect(moved).toBe(1);
		expect(store.linksForNote('Cocina.md')).toHaveLength(0);
		expect(store.linksForNote('Casa/Cocina.md')).toHaveLength(1);
	});

	it('renombrar una CARPETA mueve todas las notas que cuelgan de ella', async () => {
		const store = storeWith(memoryStorage());
		await store.link('Proyectos/Cocina.md', task(), TARGET);
		await store.link('Proyectos/Obra/Baño.md', task({ id: 'task-2' }), TARGET);
		await store.link('Otros/Cocina.md', task({ id: 'task-3' }), TARGET);

		const moved = await store.renamePath('Proyectos', 'Archivo/Proyectos');

		expect(moved).toBe(2);
		expect(store.linksForNote('Archivo/Proyectos/Cocina.md')).toHaveLength(1);
		expect(store.linksForNote('Archivo/Proyectos/Obra/Baño.md')).toHaveLength(1);
		// Una ruta que solo COMPARTE nombre de fichero no se toca.
		expect(store.linksForNote('Otros/Cocina.md')).toHaveLength(1);
	});

	it('un renombrado que no afecta a nadie no escribe', async () => {
		const storage = memoryStorage();
		const write = vi.spyOn(storage, 'writeLinks');
		const store = storeWith(storage);
		await store.link('Cocina.md', task(), TARGET);
		write.mockClear();

		expect(await store.renamePath('Otra.md', 'Movida.md')).toBe(0);
		expect(write).not.toHaveBeenCalled();
	});

	it('borrar una nota marca sus enlaces como huérfanos sin borrarlos', async () => {
		const storage = memoryStorage();
		const store = storeWith(storage);
		await store.link('Cocina.md', task(), TARGET);

		const marked = await store.markDeleted('Cocina.md');

		expect(marked).toBe(1);
		expect(storage.links).toHaveLength(1);
		expect(storage.links[0]?.orphanedAt).not.toBeNull();
	});

	it('borrar una carpeta marca todo lo que colgaba de ella', async () => {
		const storage = memoryStorage();
		const store = storeWith(storage);
		await store.link('Proyectos/Cocina.md', task(), TARGET);
		await store.link('Proyectos/Obra.md', task({ id: 'task-2' }), TARGET);

		expect(await store.markDeleted('Proyectos')).toBe(2);
		expect(storage.links.every((link) => link.orphanedAt !== null)).toBe(true);
	});

	it('una nota que VUELVE deja de ser huérfana (Sync borra y vuelve a crear)', async () => {
		const storage = memoryStorage();
		const store = storeWith(storage);
		await store.link('Cocina.md', task(), TARGET);
		await store.markDeleted('Cocina.md');

		const cleared = await store.markCreated('Cocina.md');

		expect(cleared).toBe(1);
		expect(storage.links[0]?.orphanedAt).toBeNull();
	});

	it('crear una nota que nunca fue huérfana no escribe nada', async () => {
		const storage = memoryStorage();
		const write = vi.spyOn(storage, 'writeLinks');
		const store = storeWith(storage);
		await store.link('Cocina.md', task(), TARGET);
		write.mockClear();

		expect(await store.markCreated('Cocina.md')).toBe(0);
		expect(write).not.toHaveBeenCalled();
	});

	it('una carpeta que vuelve limpia todo lo que colgaba de ella', async () => {
		const storage = memoryStorage();
		const store = storeWith(storage);
		await store.link('Proyectos/Cocina.md', task(), TARGET);
		await store.link('Proyectos/Obra.md', task({ id: 'task-2' }), TARGET);
		await store.markDeleted('Proyectos');

		expect(await store.markCreated('Proyectos')).toBe(2);
		expect(storage.links.every((link) => link.orphanedAt === null)).toBe(true);
	});
});

describe('LinkStore: entriesUnder', () => {
	it('encuentra la entrada exacta de una nota', async () => {
		const store = storeWith(memoryStorage());
		await store.link('Cocina.md', task(), TARGET);

		expect(store.entriesUnder('Cocina.md')).toHaveLength(1);
		expect(store.entriesUnder('Otra.md')).toHaveLength(0);
	});

	it('encuentra todas las que cuelgan de una carpeta renombrada', async () => {
		const store = storeWith(memoryStorage());
		await store.link('Proyectos/Cocina.md', task(), TARGET);
		await store.link('Proyectos/Sub/Menú.md', task({ id: 'task-2' }), TARGET);
		await store.link('Otro/Nota.md', task({ id: 'task-3' }), TARGET);

		const under = store.entriesUnder('Proyectos');
		expect(under.map((link) => link.notePath).sort()).toEqual([
			'Proyectos/Cocina.md',
			'Proyectos/Sub/Menú.md',
		]);
	});
});

describe('LinkStore.setDeepLink', () => {
	it('registra la url y el label mandados', async () => {
		const storage = memoryStorage();
		const store = storeWith(storage);
		await store.link('Cocina.md', task(), TARGET);

		await store.setDeepLink('Cocina.md', 'task-1', {
			url: 'obsidian://open?vault=v&file=Cocina',
			label: 'Cocina',
		});

		expect(storage.links[0]?.deepLink).toEqual({
			url: 'obsidian://open?vault=v&file=Cocina',
			label: 'Cocina',
		});
	});

	it('undefined limpia el campo', async () => {
		const storage = memoryStorage();
		const store = storeWith(storage);
		await store.link('Cocina.md', task(), TARGET);
		await store.setDeepLink('Cocina.md', 'task-1', { url: 'url-1', label: 'l' });

		await store.setDeepLink('Cocina.md', 'task-1', undefined);

		expect(storage.links[0]?.deepLink).toBeUndefined();
	});

	it('sin esa pareja (nota, tarea) no hace nada', async () => {
		const storage = memoryStorage();
		const write = vi.spyOn(storage, 'writeLinks');
		const store = storeWith(storage);
		await store.link('Cocina.md', task(), TARGET);
		write.mockClear();

		await store.setDeepLink('Cocina.md', 'task-ajena', { url: 'u', label: 'l' });

		expect(write).not.toHaveBeenCalled();
	});
});

describe('movedPath', () => {
	it('casa la ruta exacta', () => {
		expect(movedPath('Cocina.md', 'Cocina.md', 'Recetas/Cocina.md')).toBe('Recetas/Cocina.md');
	});

	it('casa el prefijo de una carpeta', () => {
		expect(movedPath('Proyectos/Sub/Cocina.md', 'Proyectos', 'Trabajo')).toBe('Trabajo/Sub/Cocina.md');
	});

	it('devuelve null si no le afecta', () => {
		expect(movedPath('Otro/Cocina.md', 'Proyectos', 'Trabajo')).toBeNull();
	});
});

describe('renameTaskLinkChanges', () => {
	const buildUrl = (notePath: string): string => `obsidian://open?vault=v&file=${notePath}`;

	it('solo entran los vínculos con deepLink; los demás no están registrados en Lumbre', () => {
		const entries = [
			{ taskId: 'task-1', notePath: 'Cocina.md', deepLink: { url: 'url-vieja', label: 'Cocina' } },
			{ taskId: 'task-2', notePath: 'Cocina.md', deepLink: undefined },
		];

		const changes = renameTaskLinkChanges(entries, 'Cocina.md', 'Recetas/Cocina.md', buildUrl);

		expect(changes).toEqual([
			{ type: 'unlink', taskId: 'task-1', url: 'url-vieja', label: 'Cocina', notePath: 'Cocina.md' },
			{
				type: 'link',
				taskId: 'task-1',
				url: 'obsidian://open?vault=v&file=Recetas/Cocina.md',
				label: 'Cocina',
				notePath: 'Recetas/Cocina.md',
			},
		]);
	});

	it('para una carpeta, cada tarea con deepLink lleva su propio par unlink→link', () => {
		const entries = [
			{ taskId: 'task-1', notePath: 'Proyectos/Cocina.md', deepLink: { url: 'url-cocina', label: 'Cocina' } },
			{ taskId: 'task-2', notePath: 'Proyectos/Menú.md', deepLink: { url: 'url-menu', label: 'Menú' } },
		];

		const changes = renameTaskLinkChanges(entries, 'Proyectos', 'Trabajo', buildUrl);

		expect(changes.map((change) => change.type)).toEqual(['unlink', 'link', 'unlink', 'link']);
		expect(changes[1]).toMatchObject({ notePath: 'Trabajo/Cocina.md', taskId: 'task-1' });
		expect(changes[3]).toMatchObject({ notePath: 'Trabajo/Menú.md', taskId: 'task-2' });
	});

	it('ignora las entradas que no caen bajo el renombrado', () => {
		const entries = [
			{ taskId: 'task-1', notePath: 'Otro/Nota.md', deepLink: { url: 'url-1', label: 'Nota' } },
		];

		expect(renameTaskLinkChanges(entries, 'Proyectos', 'Trabajo', buildUrl)).toEqual([]);
	});
});

describe('taskLinksPastGrace', () => {
	const NOW = new Date('2026-09-05T12:00:00.000Z');

	function link(overrides: Partial<LumbreTaskLink> = {}): LumbreTaskLink {
		return {
			id: 'link-1',
			taskId: 'task-1',
			notePath: 'Cocina.md',
			label: 'Cocina',
			excerpt: null,
			task: task(),
			syncState: 'materialized',
			error: null,
			updatedAt: NOW.toISOString(),
			orphanedAt: null,
			deepLink: { url: 'url-1', label: 'Cocina' },
			...overrides,
		};
	}

	it('sin deepLink no es candidata, huérfana o no', () => {
		const links = [link({ deepLink: undefined, orphanedAt: new Date(NOW.getTime() - 1_000_000).toISOString() })];
		expect(taskLinksPastGrace(links, NOW, () => false)).toEqual([]);
	});

	it('huérfana pero DENTRO de la gracia no es candidata', () => {
		const justOrphaned = new Date(NOW.getTime() - (TASK_LINK_ORPHAN_GRACE_MS - 1000)).toISOString();
		expect(taskLinksPastGrace([link({ orphanedAt: justOrphaned })], NOW, () => false)).toEqual([]);
	});

	it('huérfana, pasada la gracia, pero la nota YA EXISTE: no es candidata', () => {
		const longAgo = new Date(NOW.getTime() - (TASK_LINK_ORPHAN_GRACE_MS + 1000)).toISOString();
		expect(taskLinksPastGrace([link({ orphanedAt: longAgo })], NOW, () => true)).toEqual([]);
	});

	it('huérfana, pasada la gracia y la nota sigue sin existir: SÍ es candidata', () => {
		const longAgo = new Date(NOW.getTime() - (TASK_LINK_ORPHAN_GRACE_MS + 1000)).toISOString();
		const links = [link({ orphanedAt: longAgo })];
		expect(taskLinksPastGrace(links, NOW, () => false)).toEqual(links);
	});
});

describe('LinkStore.refresh', () => {
	it('relee por ids y actualiza la caché', async () => {
		const storage = memoryStorage();
		const store = storeWith(storage);
		await store.link('Cocina.md', task(), TARGET);
		const getTasksByIds = vi.fn(
			async (_ids: string[]): Promise<LumbreResult<LumbreTask[]>> => ({
				ok: true,
				value: [task({ content: 'Comprar pan de masa madre', done: true })],
			}),
		);

		await store.refresh('Cocina.md', { getTasksByIds });

		expect(getTasksByIds).toHaveBeenCalledWith(['task-1']);
		expect(storage.links[0]?.task.content).toBe('Comprar pan de masa madre');
		expect(storage.links[0]?.syncState).toBe('materialized');
		expect(storage.links[0]?.error).toBeNull();
	});

	it('si la lectura falla, CONSERVA la caché y marca recoverable_error', async () => {
		const storage = memoryStorage();
		const store = storeWith(storage);
		await store.link('Cocina.md', task(), TARGET);
		const getTasksByIds = vi.fn(
			async (_ids: string[]): Promise<LumbreResult<LumbreTask[]>> => ({
				ok: false,
				reason: 'network',
			}),
		);

		await store.refresh('Cocina.md', { getTasksByIds });

		expect(storage.links[0]?.task.content).toBe('Comprar pan');
		expect(storage.links[0]?.syncState).toBe('recoverable_error');
		expect(storage.links[0]?.error).toContain('network');
	});

	it('una tarea que Lumbre no devuelve conserva su caché y queda marcada', async () => {
		const storage = memoryStorage();
		const store = storeWith(storage);
		await store.link('Cocina.md', task(), TARGET);
		const getTasksByIds = vi.fn(
			async (_ids: string[]): Promise<LumbreResult<LumbreTask[]>> => ({ ok: true, value: [] }),
		);

		await store.refresh('Cocina.md', { getTasksByIds });

		expect(storage.links[0]?.task.content).toBe('Comprar pan');
		expect(storage.links[0]?.syncState).toBe('recoverable_error');
	});

	it('una nota sin enlaces no llama a la red', async () => {
		const store = storeWith(memoryStorage());
		const getTasksByIds = vi.fn(
			async (_ids: string[]): Promise<LumbreResult<LumbreTask[]>> => ({ ok: true, value: [] }),
		);

		expect(await store.refresh('Vacía.md', { getTasksByIds })).toEqual([]);
		expect(getTasksByIds).not.toHaveBeenCalled();
	});

	it('una tarea ARCHIVADA en Lumbre se relee sin error: archivar no es borrar', async () => {
		const storage = memoryStorage();
		const store = storeWith(storage);
		await store.link('Cocina.md', task(), TARGET);
		const getTasksByIds = vi.fn(
			async (_ids: string[]): Promise<LumbreResult<LumbreTask[]>> => ({
				ok: true,
				value: [task({ archivedAt: '2026-09-01T10:00:00.000Z' })],
			}),
		);

		await store.refresh('Cocina.md', { getTasksByIds });

		expect(storage.links[0]?.syncState).toBe('materialized');
		expect(storage.links[0]?.error).toBeNull();
		expect(storage.links[0]?.task.archivedAt).not.toBeNull();
	});

	it('si la nota SIGUE en el vault, la relectura le quita el huérfano', async () => {
		const storage = memoryStorage();
		const store = new LinkStore({ storage, exists: (path: string) => path === 'Cocina.md' });
		await store.link('Cocina.md', task(), TARGET);
		await store.markDeleted('Cocina.md');
		const getTasksByIds = vi.fn(
			async (_ids: string[]): Promise<LumbreResult<LumbreTask[]>> => ({
				ok: true,
				value: [task()],
			}),
		);

		await store.refresh('Cocina.md', { getTasksByIds });

		expect(storage.links[0]?.orphanedAt).toBeNull();
	});

	it('si la nota NO está en el vault, la relectura respeta el huérfano', async () => {
		const storage = memoryStorage();
		const store = new LinkStore({ storage, exists: () => false });
		await store.link('Cocina.md', task(), TARGET);
		await store.markDeleted('Cocina.md');
		const getTasksByIds = vi.fn(
			async (_ids: string[]): Promise<LumbreResult<LumbreTask[]>> => ({
				ok: true,
				value: [task()],
			}),
		);

		await store.refresh('Cocina.md', { getTasksByIds });

		expect(storage.links[0]?.orphanedAt).not.toBeNull();
	});
});

describe('LinkStore: registro de diagnóstico', () => {
	function loggedStore(storage: LinkStorage): { store: LinkStore; logger: Logger } {
		const logger = Logger.create({ console: null, level: 'info' });
		return { store: new LinkStore({ storage, logger: logger.child('links') }), logger };
	}

	it('apunta el vínculo creado con la ruta y el id de la tarea', async () => {
		const { store, logger } = loggedStore(memoryStorage());

		await store.link('Cocina.md', task(), TARGET);

		expect(logger.recent()[0]).toMatchObject({ level: 'info', message: 'Vínculo creado' });
		expect(logger.recent()[0]?.data).toMatchObject({
			notePath: 'Cocina.md',
			taskId: 'task-1',
			inNote: 1,
		});
	});

	it('en `info` NO apunta el título de la tarea, que lo escribe el usuario', async () => {
		const { store, logger } = loggedStore(memoryStorage());

		await store.link('Cocina.md', task({ content: 'Llamar al médico por lo del lunes' }), TARGET);

		expect(JSON.stringify(logger.recent())).not.toContain('médico');
	});

	it('apunta el desvinculado y el renombrado con las dos rutas', async () => {
		const storage = memoryStorage();
		const { store, logger } = loggedStore(storage);
		const link = await store.link('Cocina.md', task(), TARGET);

		await store.renamePath('Cocina.md', 'Casa/Cocina.md');
		await store.unlink(link.id);

		const messages = logger.recent().map((event) => event.message);
		expect(messages).toContain('Vínculos movidos por un renombrado');
		expect(messages).toContain('Vínculo quitado');
		const renamed = logger
			.recent()
			.find((event) => event.message === 'Vínculos movidos por un renombrado');
		expect(renamed?.data).toMatchObject({
			oldPath: 'Cocina.md',
			newPath: 'Casa/Cocina.md',
			moved: 1,
		});
	});

	it('la relectura dice cuántos vínculos había y cuántos faltaron', async () => {
		const storage = memoryStorage();
		const { store, logger } = loggedStore(storage);
		await store.link('Cocina.md', task(), TARGET);
		await store.link('Cocina.md', task({ id: 'task-2' }), TARGET);

		await store.refresh('Cocina.md', {
			getTasksByIds: async (): Promise<LumbreResult<LumbreTask[]>> => ({
				ok: true,
				value: [task()],
			}),
		});

		const refreshed = logger.recent().find((event) => event.message === 'Vínculos releídos');
		expect(refreshed?.level).toBe('warn');
		expect(refreshed?.data).toMatchObject({ links: 2, refreshed: 1, missing: 1 });
	});

	it('una relectura fallida sale como aviso con su motivo', async () => {
		const { store, logger } = loggedStore(memoryStorage());
		await store.link('Cocina.md', task(), TARGET);

		await store.refresh('Cocina.md', {
			getTasksByIds: async (): Promise<LumbreResult<LumbreTask[]>> => ({
				ok: false,
				reason: 'network',
			}),
		});

		expect(
			logger.recent().find((event) => event.message === 'Relectura de los vínculos fallida'),
		).toMatchObject({ level: 'warn' });
	});

	it('avisa cuando una nota pasa de 50 vínculos', async () => {
		const storage = memoryStorage();
		const { store, logger } = loggedStore(storage);

		for (let index = 0; index <= MANY_LINKS_WARNING; index += 1) {
			await store.link('Cocina.md', task({ id: `task-${index}` }), TARGET);
		}

		const warning = logger
			.recent()
			.find((event) => event.message === 'Esa nota tiene muchísimos vínculos');
		expect(warning?.data).toMatchObject({ links: MANY_LINKS_WARNING + 1 });
	});

	it('marcar huérfanos sale como aviso', async () => {
		const { store, logger } = loggedStore(memoryStorage());
		await store.link('Cocina.md', task(), TARGET);

		await store.markDeleted('Cocina.md');

		expect(
			logger.recent().find((event) => event.message === 'Vínculos huérfanos: su nota ha desaparecido'),
		).toMatchObject({ level: 'warn', data: { path: 'Cocina.md', marked: 1 } });
	});
});
