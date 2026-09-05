import { describe, expect, it } from 'vitest';

import {
	applyRenameListLinks,
	movedNotePath,
	NoteListLinkStore,
	orphansPastGrace,
	ORPHAN_GRACE_MS,
	renameListLinkChanges,
	type ListLinkChange,
	type NoteListLinkEntry,
	type NoteListLinkStorage,
} from './note-list-link-store';

function memoryStorage(): NoteListLinkStorage & { entries: NoteListLinkEntry[] } {
	return {
		entries: [],
		readNoteListLinks(): NoteListLinkEntry[] {
			return this.entries;
		},
		async writeNoteListLinks(entries: NoteListLinkEntry[]): Promise<void> {
			this.entries = entries;
			await Promise.resolve();
		},
	};
}

describe('NoteListLinkStore: registrar y quitar', () => {
	it('set registra la url mandada y get la devuelve', async () => {
		const storage = memoryStorage();
		const store = new NoteListLinkStore(storage);

		await store.set('Proyectos/Cocina.md', 'list-1', 'obsidian://open?vault=v&file=Cocina', 'Cocina');

		expect(store.get('Proyectos/Cocina.md')).toMatchObject({
			listId: 'list-1',
			url: 'obsidian://open?vault=v&file=Cocina',
			label: 'Cocina',
		});
	});

	it('set sobre una nota ya registrada la sustituye, no la duplica', async () => {
		const storage = memoryStorage();
		const store = new NoteListLinkStore(storage);

		await store.set('Cocina.md', 'list-1', 'obsidian://open?vault=v&file=Cocina', 'Cocina');
		await store.set('Cocina.md', 'list-2', 'obsidian://open?vault=v&file=Cocina', 'Cocina');

		expect(storage.entries).toHaveLength(1);
		expect(store.get('Cocina.md')?.listId).toBe('list-2');
	});

	it('get sin entrada devuelve null', () => {
		const store = new NoteListLinkStore(memoryStorage());
		expect(store.get('Cocina.md')).toBeNull();
	});

	it('remove quita la entrada; sin efecto si no había ninguna', async () => {
		const storage = memoryStorage();
		const store = new NoteListLinkStore(storage);
		await store.set('Cocina.md', 'list-1', 'obsidian://open?vault=v&file=Cocina', 'Cocina');

		await store.remove('Cocina.md');
		expect(store.get('Cocina.md')).toBeNull();

		await store.remove('Cocina.md');
		expect(storage.entries).toHaveLength(0);
	});
});

describe('NoteListLinkStore: entriesUnder', () => {
	it('encuentra la entrada exacta de una nota', async () => {
		const storage = memoryStorage();
		const store = new NoteListLinkStore(storage);
		await store.set('Cocina.md', 'list-1', 'url-1', 'Cocina');

		expect(store.entriesUnder('Cocina.md')).toHaveLength(1);
		expect(store.entriesUnder('Otra.md')).toHaveLength(0);
	});

	it('encuentra todas las que cuelgan de una carpeta renombrada', async () => {
		const storage = memoryStorage();
		const store = new NoteListLinkStore(storage);
		await store.set('Proyectos/Cocina.md', 'list-1', 'url-1', 'Cocina');
		await store.set('Proyectos/Sub/Menú.md', 'list-2', 'url-2', 'Menú');
		await store.set('Otro/Nota.md', 'list-3', 'url-3', 'Nota');

		const under = store.entriesUnder('Proyectos');
		expect(under.map((entry) => entry.id).sort()).toEqual([
			'Proyectos/Cocina.md',
			'Proyectos/Sub/Menú.md',
		]);
	});
});

describe('NoteListLinkStore: move', () => {
	it('mueve la entrada a la ruta nueva con la url recalculada', async () => {
		const storage = memoryStorage();
		const store = new NoteListLinkStore(storage);
		await store.set('Cocina.md', 'list-1', 'obsidian://open?vault=v&file=Cocina', 'Cocina');

		await store.move('Cocina.md', 'Recetas/Cocina.md', 'obsidian://open?vault=v&file=Recetas%2FCocina');

		expect(store.get('Cocina.md')).toBeNull();
		expect(store.get('Recetas/Cocina.md')).toMatchObject({
			listId: 'list-1',
			url: 'obsidian://open?vault=v&file=Recetas%2FCocina',
		});
	});

	it('sin efecto si la ruta vieja no tenía entrada', async () => {
		const storage = memoryStorage();
		const store = new NoteListLinkStore(storage);

		await store.move('Cocina.md', 'Recetas/Cocina.md', 'url-nueva');

		expect(storage.entries).toHaveLength(0);
	});
});

describe('movedNotePath', () => {
	it('casa la ruta exacta', () => {
		expect(movedNotePath('Cocina.md', 'Cocina.md', 'Recetas/Cocina.md')).toBe('Recetas/Cocina.md');
	});

	it('casa el prefijo de una carpeta', () => {
		expect(movedNotePath('Proyectos/Sub/Cocina.md', 'Proyectos', 'Trabajo')).toBe('Trabajo/Sub/Cocina.md');
	});

	it('devuelve null si no le afecta', () => {
		expect(movedNotePath('Otro/Cocina.md', 'Proyectos', 'Trabajo')).toBeNull();
	});
});

describe('renameListLinkChanges', () => {
	const buildUrl = (notePath: string): string => `obsidian://open?vault=v&file=${notePath}`;

	it('para una nota, el orden es unlink de la vieja seguido de link con la nueva', () => {
		const entries: NoteListLinkEntry[] = [
			{ id: 'Cocina.md', listId: 'list-1', url: 'url-vieja', label: 'Cocina', updatedAt: 't', orphanedAt: null },
		];

		const changes = renameListLinkChanges(entries, 'Cocina.md', 'Recetas/Cocina.md', buildUrl);

		expect(changes).toEqual([
			{ type: 'unlink', listId: 'list-1', url: 'url-vieja', label: 'Cocina', notePath: 'Cocina.md' },
			{
				type: 'link',
				listId: 'list-1',
				url: 'obsidian://open?vault=v&file=Recetas/Cocina.md',
				label: 'Cocina',
				notePath: 'Recetas/Cocina.md',
			},
		]);
	});

	it('para una carpeta con varias notas, cada una lleva su propio par unlink→link', () => {
		const entries: NoteListLinkEntry[] = [
			{ id: 'Proyectos/Cocina.md', listId: 'list-1', url: 'url-cocina', label: 'Cocina', updatedAt: 't', orphanedAt: null },
			{ id: 'Proyectos/Menú.md', listId: 'list-2', url: 'url-menu', label: 'Menú', updatedAt: 't', orphanedAt: null },
		];

		const changes = renameListLinkChanges(entries, 'Proyectos', 'Trabajo', buildUrl);

		expect(changes.map((change) => change.type)).toEqual(['unlink', 'link', 'unlink', 'link']);
		expect(changes[0]).toMatchObject({ notePath: 'Proyectos/Cocina.md', url: 'url-cocina' });
		expect(changes[1]).toMatchObject({ notePath: 'Trabajo/Cocina.md' });
		expect(changes[2]).toMatchObject({ notePath: 'Proyectos/Menú.md', url: 'url-menu' });
		expect(changes[3]).toMatchObject({ notePath: 'Trabajo/Menú.md' });
	});

	it('ignora las entradas que no caen bajo el renombrado', () => {
		const entries: NoteListLinkEntry[] = [
			{ id: 'Otro/Nota.md', listId: 'list-1', url: 'url-1', label: 'Nota', updatedAt: 't', orphanedAt: null },
		];

		expect(renameListLinkChanges(entries, 'Proyectos', 'Trabajo', buildUrl)).toEqual([]);
	});
});

describe('NoteListLinkStore: markDeleted y markCreated', () => {
	it('markDeleted marca huérfana la entrada, sin borrarla', async () => {
		const storage = memoryStorage();
		const store = new NoteListLinkStore(storage);
		await store.set('Cocina.md', 'list-1', 'url-1', 'Cocina');

		const marked = await store.markDeleted('Cocina.md');

		expect(marked).toBe(1);
		expect(typeof store.get('Cocina.md')?.orphanedAt).toBe('string');
	});

	it('markDeleted es idempotente: no reescribe la marca si ya estaba huérfana', async () => {
		const storage = memoryStorage();
		const store = new NoteListLinkStore(storage);
		await store.set('Cocina.md', 'list-1', 'url-1', 'Cocina');
		await store.markDeleted('Cocina.md');
		const first = store.get('Cocina.md')?.orphanedAt;

		const marked = await store.markDeleted('Cocina.md');

		expect(marked).toBe(0);
		expect(store.get('Cocina.md')?.orphanedAt).toBe(first);
	});

	it('markDeleted vale para una carpeta entera', async () => {
		const storage = memoryStorage();
		const store = new NoteListLinkStore(storage);
		await store.set('Proyectos/Cocina.md', 'list-1', 'url-1', 'Cocina');
		await store.set('Proyectos/Menú.md', 'list-2', 'url-2', 'Menú');

		expect(await store.markDeleted('Proyectos')).toBe(2);
	});

	it('markCreated limpia la marca de la misma ruta', async () => {
		const storage = memoryStorage();
		const store = new NoteListLinkStore(storage);
		await store.set('Cocina.md', 'list-1', 'url-1', 'Cocina');
		await store.markDeleted('Cocina.md');

		const cleared = await store.markCreated('Cocina.md');

		expect(cleared).toBe(1);
		expect(store.get('Cocina.md')?.orphanedAt).toBeNull();
	});

	it('markCreated sin marca previa no hace nada', async () => {
		const storage = memoryStorage();
		const store = new NoteListLinkStore(storage);
		await store.set('Cocina.md', 'list-1', 'url-1', 'Cocina');

		expect(await store.markCreated('Cocina.md')).toBe(0);
	});
});

describe('orphansPastGrace', () => {
	const NOW = new Date('2026-09-05T12:00:00.000Z');

	function entry(overrides: Partial<NoteListLinkEntry> = {}): NoteListLinkEntry {
		return {
			id: 'Cocina.md',
			listId: 'list-1',
			url: 'url-1',
			label: 'Cocina',
			updatedAt: NOW.toISOString(),
			orphanedAt: null,
			...overrides,
		};
	}

	it('una entrada sin huérfana no es candidata, exista o no la nota', () => {
		const entries = [entry({ orphanedAt: null })];
		expect(orphansPastGrace(entries, NOW, () => false)).toEqual([]);
	});

	it('huérfana pero DENTRO de la gracia no es candidata: puede ser un delete+create de Sync', () => {
		const justOrphaned = new Date(NOW.getTime() - (ORPHAN_GRACE_MS - 1000)).toISOString();
		const entries = [entry({ orphanedAt: justOrphaned })];

		expect(orphansPastGrace(entries, NOW, () => false)).toEqual([]);
	});

	it('huérfana y pasada la gracia, pero la nota YA EXISTE (volvió): no es candidata', () => {
		const longAgo = new Date(NOW.getTime() - (ORPHAN_GRACE_MS + 1000)).toISOString();
		const entries = [entry({ orphanedAt: longAgo })];

		expect(orphansPastGrace(entries, NOW, () => true)).toEqual([]);
	});

	it('huérfana, pasada la gracia y la nota sigue sin existir: SÍ es candidata', () => {
		const longAgo = new Date(NOW.getTime() - (ORPHAN_GRACE_MS + 1000)).toISOString();
		const entries = [entry({ orphanedAt: longAgo })];

		expect(orphansPastGrace(entries, NOW, () => false)).toEqual(entries);
	});
});

describe('applyRenameListLinks', () => {
	const buildUrl = (notePath: string): string => `obsidian://open?vault=v&file=${notePath}`;

	function fakeEnqueue(): {
		enqueue: (change: ListLinkChange) => Promise<{ id: string }>;
		calls: ListLinkChange[];
	} {
		const calls: ListLinkChange[] = [];
		let next = 0;
		return {
			calls,
			enqueue: async (change: ListLinkChange): Promise<{ id: string }> => {
				calls.push(change);
				next += 1;
				return { id: `op-${next}` };
			},
		};
	}

	it('actualiza el registro local y encola unlink→link, devolviendo los ids', async () => {
		const storage = memoryStorage();
		const store = new NoteListLinkStore(storage);
		await store.set('Cocina.md', 'list-1', 'obsidian://open?vault=v&file=Cocina', 'Cocina');
		const { enqueue, calls } = fakeEnqueue();

		const ids = await applyRenameListLinks(store, 'Cocina.md', 'Recetas/Cocina.md', buildUrl, enqueue);

		expect(ids).toEqual(['op-1', 'op-2']);
		expect(calls.map((change) => change.type)).toEqual(['unlink', 'link']);
		expect(store.get('Recetas/Cocina.md')).not.toBeNull();
		expect(store.get('Cocina.md')).toBeNull();
	});

	it('sin entradas bajo la ruta vieja, no encola nada', async () => {
		const store = new NoteListLinkStore(memoryStorage());
		const { enqueue, calls } = fakeEnqueue();

		expect(await applyRenameListLinks(store, 'Cocina.md', 'Recetas/Cocina.md', buildUrl, enqueue)).toEqual([]);
		expect(calls).toEqual([]);
	});

	// El caso que reprodujo el fallo: dos renombrados de la MISMA nota, uno
	// detrás de otro sin esperar al primero (como los listeners de
	// `vault.on('rename', ...)`, que van con `void`). Con el registro local
	// actualizado DESPUÉS de encolar, el segundo leía la ruta todavía vieja del
	// primero y no encontraba nada por la ruta intermedia: el vínculo de Lumbre
	// se quedaba apuntando a esa ruta intermedia sin vía de limpieza.
	it('dos renombrados seguidos SIN esperar al primero: el servidor acaba con un solo link (el final) y un unlink por cada ruta anterior', async () => {
		const storage = memoryStorage();
		const store = new NoteListLinkStore(storage);
		await store.set('Cocina.md', 'list-1', 'obsidian://open?vault=v&file=Cocina', 'Cocina');
		const { enqueue, calls } = fakeEnqueue();

		const first = applyRenameListLinks(store, 'Cocina.md', 'Recetas/Cocina.md', buildUrl, enqueue);
		const second = applyRenameListLinks(store, 'Recetas/Cocina.md', 'Trabajo/Cocina.md', buildUrl, enqueue);
		await Promise.all([first, second]);

		const links = calls.filter((change) => change.type === 'link');
		const unlinks = calls.filter((change) => change.type === 'unlink');
		expect(links).toHaveLength(1);
		expect(links[0]).toMatchObject({ notePath: 'Trabajo/Cocina.md' });
		expect(unlinks.map((change) => change.notePath).sort()).toEqual(['Cocina.md', 'Recetas/Cocina.md']);

		expect(store.get('Trabajo/Cocina.md')).not.toBeNull();
		expect(store.get('Cocina.md')).toBeNull();
		expect(store.get('Recetas/Cocina.md')).toBeNull();
		expect(storage.entries).toHaveLength(1);
	});
});
