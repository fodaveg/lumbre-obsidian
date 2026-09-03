import { describe, expect, it, vi } from 'vitest';

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
