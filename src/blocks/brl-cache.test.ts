import { describe, expect, it, vi } from 'vitest';

import type { BrlDay, LumbreResult } from '../lumbre/client';
import { BrlCache } from './brl-cache';
import { IDLE_ENTRY_TTL_MS } from './query-cache';

const ENTRIES: BrlDay['entries'] = [{ id: 'entry-1', time: '11:20', entry: '- Una nota' }];

/** Cliente que devuelve siempre el mismo Markdown y las mismas entradas, y cuenta las llamadas a cada camino. */
function okClient(markdown = '- Una nota', entries: BrlDay['entries'] = ENTRIES) {
	return {
		brl: vi.fn(async (): Promise<LumbreResult<string>> => ({ ok: true, value: markdown })),
		brlJson: vi.fn(
			async (date: string): Promise<LumbreResult<BrlDay>> => ({ ok: true, value: { date, entries } }),
		),
	};
}

describe('BrlCache: get/peek/subscribe/refreshAll (el camino del bloque en vivo)', () => {
	it('peek de un día desconocido NO crea la entrada ni pide nada', () => {
		const client = okClient();
		const cache = new BrlCache({ client, now: () => 0 });

		expect(cache.peek('2026-09-03').fetchedAt).toBeNull();
		expect(cache.stats().entries).toBe(0);
		expect(client.brl).not.toHaveBeenCalled();
		expect(client.brlJson).not.toHaveBeenCalled();
	});

	it('un día viejo y sin bloques montados se desaloja en el siguiente refresco', async () => {
		let clock = 0;
		const cache = new BrlCache({ client: okClient(), now: () => clock });

		await cache.get('2026-09-03');
		expect(cache.stats().entries).toBe(1);

		clock = IDLE_ENTRY_TTL_MS + 1;
		await cache.refreshAll();
		expect(cache.stats().entries).toBe(0);
	});

	it('un día CON bloque montado no se desaloja por viejo', async () => {
		let clock = 0;
		const cache = new BrlCache({ client: okClient(), now: () => clock });
		cache.subscribe('2026-09-03', () => undefined);

		await cache.get('2026-09-03');
		clock = IDLE_ENTRY_TTL_MS * 10;
		await cache.refreshAll();
		expect(cache.stats().entries).toBe(1);
	});

	it('MEDIDO 18 sep 2026: un refresco del bloque pide SOLO las entradas, nunca el Markdown', async () => {
		const client = okClient('- Una nota', [{ id: 'entry-1', time: '11:20', entry: '- Una nota' }]);
		const cache = new BrlCache({ client, now: () => 0 });

		const snapshot = await cache.get('2026-09-03');

		expect(snapshot.entries).toEqual([{ id: 'entry-1', time: '11:20', entry: '- Una nota' }]);
		expect(client.brlJson).toHaveBeenCalledTimes(1);
		// La regresión que esto impide: antes gastaba TAMBIÉN GET /api/brl/<date>
		// (el Markdown), el mismo cubo que `?format=json`, sin que nadie lo usara.
		expect(client.brl).not.toHaveBeenCalled();
	});

	it('si la lectura falla, no se pisan las entradas de la anterior', async () => {
		let firstCall = true;
		const flaky = {
			brl: vi.fn(async (): Promise<LumbreResult<string>> => ({ ok: true, value: '- Una nota' })),
			brlJson: vi.fn(async (): Promise<LumbreResult<BrlDay>> => {
				if (firstCall) {
					firstCall = false;
					return { ok: false, reason: 'network' };
				}
				return { ok: true, value: { date: '2026-09-03', entries: ENTRIES } };
			}),
		};
		const cache = new BrlCache({ client: flaky, now: () => 0 });

		const failed = await cache.get('2026-09-03');
		expect(failed.fetchedAt).toBeNull();
		expect(failed.error).toBe('No se pudo conectar con Lumbre.');
		expect(failed.entries).toEqual([]);

		const ok = await cache.get('2026-09-03', true);
		expect(ok.fetchedAt).not.toBeNull();
		expect(ok.entries).toEqual(ENTRIES);
		// Y el Markdown ni se ha pedido en ningún momento: `get()` no lo toca.
		expect(flaky.brl).not.toHaveBeenCalled();
	});

	it('con el add-on BRL apagado (403), el error lo dice', async () => {
		const client = {
			brl: vi.fn(async (): Promise<LumbreResult<string>> => ({ ok: false, reason: 'unauthorized', status: 403 })),
			brlJson: vi.fn(
				async (): Promise<LumbreResult<BrlDay>> => ({ ok: false, reason: 'unauthorized', status: 403 }),
			),
		};
		const cache = new BrlCache({ client, now: () => 0 });

		const snapshot = await cache.get('2026-09-03');

		expect(snapshot.error).toBe('El add-on BRL está desactivado en tu cuenta de Lumbre.');
	});

	it('invalidate() caduca el día: la siguiente get() vuelve a pedir SOLO las entradas', async () => {
		const client = okClient();
		const cache = new BrlCache({ client, now: () => 0 });

		await cache.get('2026-09-03');
		cache.invalidate('la cola ha materializado algo');
		await cache.get('2026-09-03');

		expect(client.brlJson).toHaveBeenCalledTimes(2);
		expect(client.brl).not.toHaveBeenCalled();
	});
});

describe('BrlCache.getMarkdown (el camino de «Insertar el BRL de hoy como texto»)', () => {
	it('MEDIDO 18 sep 2026: pide SOLO el Markdown, nunca las entradas', async () => {
		const client = okClient();

		const snapshot = await new BrlCache({ client, now: () => 0 }).getMarkdown('today');

		expect(snapshot).toEqual({ markdown: '- Una nota', fetchedAt: 0, error: null });
		expect(client.brl).toHaveBeenCalledTimes(1);
		expect(client.brlJson).not.toHaveBeenCalled();
	});

	it('SIN caché: cada llamada es una petición nueva, aunque se repita el día', async () => {
		const client = okClient();
		const cache = new BrlCache({ client, now: () => 0 });

		await cache.getMarkdown('today');
		await cache.getMarkdown('today');

		expect(client.brl).toHaveBeenCalledTimes(2);
	});

	it('si falla, no hay lectura anterior que rescatar: markdown vacío y fetchedAt null', async () => {
		const client = {
			brl: vi.fn(async (): Promise<LumbreResult<string>> => ({ ok: false, reason: 'network' })),
			brlJson: vi.fn(async (): Promise<LumbreResult<BrlDay>> => ({ ok: true, value: { date: 'today', entries: [] } })),
		};

		const snapshot = await new BrlCache({ client, now: () => 0 }).getMarkdown('today');

		expect(snapshot).toEqual({ markdown: '', fetchedAt: null, error: 'No se pudo conectar con Lumbre.' });
	});

	it('con el add-on BRL apagado (403), el mismo mensaje que en get()', async () => {
		const client = {
			brl: vi.fn(async (): Promise<LumbreResult<string>> => ({ ok: false, reason: 'unauthorized', status: 403 })),
			brlJson: vi.fn(async (): Promise<LumbreResult<BrlDay>> => ({ ok: true, value: { date: 'today', entries: [] } })),
		};

		const snapshot = await new BrlCache({ client, now: () => 0 }).getMarkdown('today');

		expect(snapshot.error).toBe('El add-on BRL está desactivado en tu cuenta de Lumbre.');
	});
});
