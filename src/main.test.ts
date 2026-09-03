import type { App, PluginManifest } from 'obsidian';
import { describe, expect, it } from 'vitest';

import LumbrePlugin from './main';

/**
 * El plugin con lo mínimo para construirlo. `app` es un objeto pelado a
 * propósito: aquí se prueba justo lo que pasa cuando la carga se rompe ANTES de
 * llegar a usarlo.
 */
function plugin(): LumbrePlugin {
	const manifest = { id: 'lumbre', version: '0.0.0-test' } as PluginManifest;
	return new LumbrePlugin({} as App, manifest);
}

describe('LumbrePlugin: descarga tras una carga fallida', () => {
	it('si `data.json` no se puede leer, `onload` falla y `onunload` NO lanza', async () => {
		const failing = plugin();
		failing.loadData = (): Promise<unknown> =>
			Promise.reject(new Error('data.json ilegible'));

		await expect(failing.onload()).rejects.toThrow('data.json ilegible');
		// Obsidian llama a `onunload` igual, con el plugin a medio construir: sin
		// cola, y a veces sin registro.
		expect(() => {
			failing.onunload();
		}).not.toThrow();
	});

	it('un plugin que nunca llegó a cargar tampoco lanza al descargarse', () => {
		expect(() => {
			plugin().onunload();
		}).not.toThrow();
	});
});
