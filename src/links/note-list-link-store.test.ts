import { describe, expect, it } from 'vitest';

import {
	movedNotePath,
	NoteListLinkStore,
	renameListLinkChanges,
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
			{ id: 'Cocina.md', listId: 'list-1', url: 'url-vieja', label: 'Cocina', updatedAt: 't' },
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
			{ id: 'Proyectos/Cocina.md', listId: 'list-1', url: 'url-cocina', label: 'Cocina', updatedAt: 't' },
			{ id: 'Proyectos/Menú.md', listId: 'list-2', url: 'url-menu', label: 'Menú', updatedAt: 't' },
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
			{ id: 'Otro/Nota.md', listId: 'list-1', url: 'url-1', label: 'Nota', updatedAt: 't' },
		];

		expect(renameListLinkChanges(entries, 'Proyectos', 'Trabajo', buildUrl)).toEqual([]);
	});
});
