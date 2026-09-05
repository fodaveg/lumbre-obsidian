import { describe, expect, it, vi } from 'vitest';

import { Logger } from '../diagnostics/logger';
import type { LumbreTaskLink } from '../links/link-store';
import type { NoteListLinkEntry } from '../links/note-list-link-store';
import type { CreateOperation, QueuedOperation } from '../lumbre/queue';
import { DEFAULT_SETTINGS } from '../settings';
import { PluginDataTokenStore } from '../token-store';
import { PLUGIN_DATA_VERSION, PluginStore, type PluginDataHost } from './plugin-store';

/** `data.json` en memoria, con la cuenta de escrituras para ver el coalescido. */
function memoryHost(initial: unknown = null): PluginDataHost & { saved: unknown; writes: number } {
	return {
		saved: initial,
		writes: 0,
		async loadData(): Promise<unknown> {
			return Promise.resolve(this.saved);
		},
		async saveData(data: unknown): Promise<void> {
			this.saved = data;
			this.writes += 1;
			await Promise.resolve();
		},
	};
}

describe('PluginStore: migración desde el data.json viejo', () => {
	it('conserva el token y el apiOrigin de una instalación existente', async () => {
		// Formato de hoy: los ajustes y el token, sueltos en la raíz y sin `version`.
		const host = memoryHost({ apiOrigin: 'https://lumbre.casa', token: 'tok-viejo' });
		const store = new PluginStore(host);

		const data = await store.load();

		expect(data.version).toBe(PLUGIN_DATA_VERSION);
		expect(data.settings.apiOrigin).toBe('https://lumbre.casa');
		expect(data.token).toBe('tok-viejo');
		expect(data.queue).toEqual([]);
		expect(data.links).toEqual([]);
	});

	it('un data.json vacío arranca con los ajustes por defecto y sin token', async () => {
		const store = new PluginStore(memoryHost(null));

		const data = await store.load();

		expect(data.settings).toEqual(DEFAULT_SETTINGS);
		expect(data.token).toBeNull();
	});

	it('un data.json ya versionado se lee tal cual', async () => {
		const host = memoryHost({
			version: 1,
			settings: { apiOrigin: 'https://lumbre.casa' },
			token: 'tok-1',
			queue: [],
			links: [],
			deviceId: 'device-guardado',
		});
		const store = new PluginStore(host);

		const data = await store.load();

		expect(data.settings.apiOrigin).toBe('https://lumbre.casa');
		expect(data.token).toBe('tok-1');
		expect(store.deviceId).toBe('device-guardado');
	});

	it('un ajuste que esta versión no conoce SOBREVIVE a la migración', async () => {
		// El caso real: un dispositivo con el plugin nuevo guarda un ajuste que este
		// otro todavía no conoce. Reconstruir los ajustes campo a campo lo borraba en
		// cada carga, y el `save()` siguiente lo tiraba también del `data.json`.
		const host = memoryHost({
			version: PLUGIN_DATA_VERSION,
			settings: { apiOrigin: 'https://lumbre.casa', ajusteDelFuturo: 'sí' },
			token: null,
			queue: [],
			links: [],
			deviceId: null,
		});
		const store = new PluginStore(host);

		const data = await store.load();

		expect((data.settings as unknown as Record<string, unknown>)['ajusteDelFuturo']).toBe('sí');
		expect(data.settings.apiOrigin).toBe('https://lumbre.casa');
	});

	it('un apiOrigin que no es una URL cae al de fábrica, no se guarda tal cual', async () => {
		const host = memoryHost({
			version: PLUGIN_DATA_VERSION,
			settings: { apiOrigin: 'no es una url' },
		});
		const store = new PluginStore(host);

		const data = await store.load();

		expect(data.settings.apiOrigin).toBe(DEFAULT_SETTINGS.apiOrigin);
	});

	it('un apiOrigin con ruta se guarda NORMALIZADO a su origen', async () => {
		const host = memoryHost({
			version: PLUGIN_DATA_VERSION,
			settings: { apiOrigin: 'https://lumbre.casa/app/tareas?x=1' },
		});
		const store = new PluginStore(host);

		expect((await store.load()).settings.apiOrigin).toBe('https://lumbre.casa');
	});

	it('un nivel de registro que no existe cae al de fábrica', async () => {
		const host = memoryHost({
			version: PLUGIN_DATA_VERSION,
			settings: { logLevel: 'gritando' },
		});
		const store = new PluginStore(host);

		expect((await store.load()).settings.logLevel).toBe(DEFAULT_SETTINGS.logLevel);
	});

	it('un data.json de la versión 4 (sin exportFolder) migra con el valor de fábrica', async () => {
		const host = memoryHost({ version: 4, settings: {}, token: null, queue: [], links: [] });
		const store = new PluginStore(host);

		const data = await store.load();

		expect(data.version).toBe(PLUGIN_DATA_VERSION);
		expect(data.settings.exportFolder).toBe(DEFAULT_SETTINGS.exportFolder);
	});

	it('una carpeta de exportaciones vacía o solo de espacios cae al valor de fábrica', async () => {
		const host = memoryHost({
			version: PLUGIN_DATA_VERSION,
			settings: { exportFolder: '   ' },
		});
		const store = new PluginStore(host);

		expect((await store.load()).settings.exportFolder).toBe(DEFAULT_SETTINGS.exportFolder);
	});

	it('una carpeta de exportaciones escrita se conserva tal cual', async () => {
		const host = memoryHost({
			version: PLUGIN_DATA_VERSION,
			settings: { exportFolder: 'Respaldo/Lumbre' },
		});
		const store = new PluginStore(host);

		expect((await store.load()).settings.exportFolder).toBe('Respaldo/Lumbre');
	});

	it('un data.json de la versión 2 (sin noteListLinks) migra con el registro vacío', async () => {
		const host = memoryHost({ version: 2, settings: {}, token: null, queue: [], links: [] });
		const store = new PluginStore(host);

		const data = await store.load();

		expect(data.version).toBe(PLUGIN_DATA_VERSION);
		expect(data.noteListLinks).toEqual([]);
	});

	it('un data.json de la versión 3 (vínculos sin deepLink) migra sin tocarlos', async () => {
		const oldLink = {
			id: 'link-1',
			taskId: 'task-1',
			notePath: 'Cocina.md',
			label: 'Cocina',
			excerpt: null,
			task: { id: 'task-1' },
			syncState: 'materialized',
			error: null,
			updatedAt: '2026-09-01T10:00:00.000Z',
			orphanedAt: null,
		};
		const host = memoryHost({
			version: 3,
			settings: {},
			token: null,
			queue: [],
			links: [oldLink],
			noteListLinks: [],
		});
		const store = new PluginStore(host);

		const data = await store.load();

		expect(data.version).toBe(PLUGIN_DATA_VERSION);
		expect(data.links[0]?.deepLink).toBeUndefined();
	});

	it('el token que ya estaba sigue llegando al TokenStore tras migrar', async () => {
		const store = new PluginStore(memoryHost({ apiOrigin: 'https://lumbre.casa', token: 'tok-viejo' }));
		await store.load();
		const tokenStore = new PluginDataTokenStore(store);

		expect(await tokenStore.get()).toBe('tok-viejo');

		await tokenStore.set('tok-nuevo');
		expect(await tokenStore.get()).toBe('tok-nuevo');

		await tokenStore.set(null);
		expect(await tokenStore.get()).toBeNull();
	});
});

describe('PluginStore: escrituras', () => {
	it('coalesce varias mutaciones seguidas en un solo saveData', async () => {
		const host = memoryHost(null);
		const store = new PluginStore(host);
		await store.load();

		await Promise.all([store.save(), store.save(), store.save()]);

		expect(host.writes).toBe(1);
	});

	it('escribe el objeto entero, con las cuatro secciones', async () => {
		const host = memoryHost({ apiOrigin: 'https://lumbre.casa', token: 'tok-1' });
		const store = new PluginStore(host);
		await store.load();

		await store.writeLinks([]);

		expect(host.saved).toMatchObject({
			version: PLUGIN_DATA_VERSION,
			settings: { apiOrigin: 'https://lumbre.casa' },
			token: 'tok-1',
			queue: [],
			links: [],
		});
	});
});

describe('PluginStore: fusión con lo que hay en disco', () => {
	/** Una operación de la cola, con lo justo para poder distinguirla. */
	function operation(id: string, updatedAt: string, deviceId = 'device-a'): CreateOperation {
		return {
			id,
			deviceId,
			state: 'pending_local',
			attempts: 0,
			error: null,
			createdAt: updatedAt,
			updatedAt,
			sentAt: null,
			kind: 'create',
			clientTaskId: `tarea-${id}`,
			draft: { title: 'Comprar pan' },
			target: { notePath: 'Nota.md', label: 'Comprar pan', excerpt: null },
		};
	}

	function link(id: string, updatedAt: string, label = 'Comprar pan'): LumbreTaskLink {
		return {
			id,
			taskId: `tarea-${id}`,
			notePath: 'Nota.md',
			label,
			excerpt: null,
			task: {
				id: `tarea-${id}`,
				content: label,
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
			},
			syncState: 'materialized',
			error: null,
			updatedAt,
			orphanedAt: null,
		};
	}

	function savedQueue(host: { saved: unknown }): QueuedOperation[] {
		return (host.saved as { queue: QueuedOperation[] }).queue;
	}

	it('no pisa la operación que otro dispositivo dejó en data.json mientras tanto', async () => {
		// El caso real: el iPad encola sin conexión, Sync sube su `data.json`, y el
		// Mac lleva horas abierto con una foto anterior en memoria.
		const host = memoryHost(null);
		const mac = new PluginStore(host);
		const ipad = new PluginStore(host);
		await mac.load();
		await ipad.load();

		await ipad.writeQueue([operation('del-ipad', '2026-09-03T10:00:00.000Z', 'device-b')]);
		await mac.writeQueue([operation('del-mac', '2026-09-03T11:00:00.000Z')]);

		expect(savedQueue(host).map((item) => item.id).sort()).toEqual(['del-ipad', 'del-mac']);
	});

	it('con el mismo id gana el updatedAt más reciente', async () => {
		const host = memoryHost(null);
		const store = new PluginStore(host);
		await store.load();
		await store.writeQueue([operation('uno', '2026-09-03T12:00:00.000Z')]);

		// Otro dispositivo escribió una versión ANTERIOR de la misma operación.
		host.saved = { ...(host.saved as object), queue: [operation('uno', '2026-09-03T09:00:00.000Z')] };
		await store.writeLinks([]);

		expect(savedQueue(host)[0]?.updatedAt).toBe('2026-09-03T12:00:00.000Z');
	});

	it('une los vínculos por id y deja ganar al más reciente', async () => {
		const host = memoryHost(null);
		const a = new PluginStore(host);
		const b = new PluginStore(host);
		await a.load();
		await b.load();

		await b.writeLinks([link('del-ipad', '2026-09-03T10:00:00.000Z')]);
		await a.writeLinks([link('del-mac', '2026-09-03T11:00:00.000Z')]);

		const saved = (host.saved as { links: LumbreTaskLink[] }).links;
		expect(saved.map((item) => item.id).sort()).toEqual(['del-ipad', 'del-mac']);
	});

	it('lo que se quita a propósito NO vuelve de disco', async () => {
		const host = memoryHost(null);
		const store = new PluginStore(host);
		await store.load();
		await store.writeQueue([operation('uno', '2026-09-03T10:00:00.000Z')]);

		// Descartar una operación es una decisión del usuario: la unión no puede
		// resucitarla porque siga en la foto de disco.
		await store.writeQueue([]);

		expect(savedQueue(host)).toEqual([]);
	});

	it('une el registro de vínculos nota↔lista por id y deja ganar al más reciente', async () => {
		const host = memoryHost(null);
		const a = new PluginStore(host);
		const b = new PluginStore(host);
		await a.load();
		await b.load();

		await b.writeNoteListLinks([
			{
				id: 'Cocina.md',
				listId: 'list-1',
				url: 'url-vieja',
				label: 'Cocina',
				updatedAt: '2026-09-03T10:00:00.000Z',
				orphanedAt: null,
			},
		]);
		await a.writeNoteListLinks([
			{
				id: 'Menú.md',
				listId: 'list-2',
				url: 'url-menu',
				label: 'Menú',
				updatedAt: '2026-09-03T11:00:00.000Z',
				orphanedAt: null,
			},
		]);

		const saved = (host.saved as { noteListLinks: NoteListLinkEntry[] }).noteListLinks;
		expect(saved.map((entry) => entry.id).sort()).toEqual(['Cocina.md', 'Menú.md']);
	});

	it('borrar el token gana sobre lo que siga en el fichero', async () => {
		const host = memoryHost({ version: 2, settings: {}, token: 'tok-1', queue: [], links: [] });
		const store = new PluginStore(host);
		await store.load();

		await store.writeToken(null);

		// Vaciarlo es una decisión del usuario: la unión no puede devolverle una
		// credencial que acaba de borrar.
		expect((host.saved as { token: string | null }).token).toBeNull();
	});

	it('con un data.json ilegible escribe la memoria y lo apunta como aviso', async () => {
		const host = memoryHost(null);
		const logger = Logger.create({ console: null, level: 'info' });
		const store = new PluginStore(host, undefined, logger.child('main'));
		await store.load();
		host.loadData = (): Promise<unknown> => Promise.reject(new Error('fichero corrupto'));

		await store.writeQueue([operation('uno', '2026-09-03T10:00:00.000Z')]);

		expect(savedQueue(host).map((item) => item.id)).toEqual(['uno']);
		const warning = logger
			.recent()
			.find((event) => event.message === 'No se ha podido releer data.json antes de guardar');
		expect(warning?.level).toBe('warn');
	});
});

describe('PluginStore: id de dispositivo', () => {
	it('lo lee del almacén LOCAL y no lo baja a data.json', async () => {
		const local = { value: 'device-local' };
		const store = new PluginStore(memoryHost(null), {
			read: () => local.value,
			write: (id: string) => {
				local.value = id;
			},
		});
		await store.load();

		expect(store.deviceId).toBe('device-local');

		const host = memoryHost(null);
		const other = new PluginStore(host, {
			read: () => local.value,
			write: () => undefined,
		});
		await other.load();
		await other.save();
		// En data.json va `null`: si viajara por Sync, el otro equipo se creería
		// este mismo dispositivo y reenviaría sus operaciones.
		expect(host.saved).toMatchObject({ deviceId: null });
	});

	it('si el almacén local está vacío, genera uno y lo guarda ahí', async () => {
		const write = vi.fn();
		const store = new PluginStore(memoryHost(null), { read: () => null, write });
		await store.load();

		expect(store.deviceId).toHaveLength(36);
		expect(write).toHaveBeenCalledWith(store.deviceId);
	});

	it('sin almacén local cae a data.json, que es peor pero funciona', async () => {
		const host = memoryHost(null);
		const store = new PluginStore(host);
		await store.load();
		const generated = store.deviceId;

		await store.save();

		expect(generated).toHaveLength(36);
		expect(host.saved).toMatchObject({ deviceId: generated });
	});
});
