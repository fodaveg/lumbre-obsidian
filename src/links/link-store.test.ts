import { describe, expect, it, vi } from 'vitest';

import type { LumbreResult } from '../lumbre/client';
import type { LumbreTask } from '../lumbre/types';
import { LinkStore, type LinkStorage, type LumbreTaskLink } from './link-store';

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
});
