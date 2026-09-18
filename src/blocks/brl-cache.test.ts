import { describe, expect, it, vi } from 'vitest';

import type { BrlDay, LumbreResult } from '../lumbre/client';
import { BrlCache } from './brl-cache';
import { IDLE_ENTRY_TTL_MS } from './query-cache';

const ENTRIES: BrlDay['entries'] = [{ id: 'entry-1', time: '11:20', entry: '- Una nota' }];

/** Cliente que devuelve siempre el mismo Markdown y las mismas entradas, y cuenta las llamadas. */
function okClient(markdown = '- Una nota', entries: BrlDay['entries'] = ENTRIES) {
	return {
		brl: vi.fn(async (): Promise<LumbreResult<string>> => ({ ok: true, value: markdown })),
		brlJson: vi.fn(
			async (date: string): Promise<LumbreResult<BrlDay>> => ({ ok: true, value: { date, entries } }),
		),
	};
}

describe('BrlCache', () => {
	it('peek de un día desconocido NO crea la entrada', () => {
		const client = okClient();
		const cache = new BrlCache({ client, now: () => 0 });

		expect(cache.peek('2026-09-03').fetchedAt).toBeNull();
		expect(cache.stats().entries).toBe(0);
		expect(client.brl).not.toHaveBeenCalled();
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

	it('trae las entradas CON id a la vez que el Markdown, por los dos caminos', async () => {
		const client = okClient('- Una nota', [{ id: 'entry-1', time: '11:20', entry: '- Una nota' }]);
		const cache = new BrlCache({ client, now: () => 0 });

		const snapshot = await cache.get('2026-09-03');

		expect(snapshot.markdown).toBe('- Una nota');
		expect(snapshot.entries).toEqual([{ id: 'entry-1', time: '11:20', entry: '- Una nota' }]);
		expect(client.brl).toHaveBeenCalledTimes(1);
		expect(client.brlJson).toHaveBeenCalledTimes(1);
	});

	it('si falla el Markdown pero las entradas van bien, no se pisa lo anterior de NINGUNO de los dos', async () => {
		let firstCall = true;
		const flaky = {
			brl: vi.fn(async (): Promise<LumbreResult<string>> => {
				if (firstCall) {
					firstCall = false;
					return { ok: false, reason: 'network' };
				}
				return { ok: true, value: '- Una nota' };
			}),
			brlJson: vi.fn(
				async (date: string): Promise<LumbreResult<BrlDay>> => ({ ok: true, value: { date, entries: ENTRIES } }),
			),
		};
		const cache = new BrlCache({ client: flaky, now: () => 0 });

		const failed = await cache.get('2026-09-03');
		expect(failed.fetchedAt).toBeNull();
		expect(failed.error).toBe('No se pudo conectar con Lumbre.');
		expect(failed.entries).toEqual([]);

		const ok = await cache.get('2026-09-03', true);
		expect(ok.fetchedAt).not.toBeNull();
		expect(ok.entries).toEqual(ENTRIES);
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

	it('invalidate() caduca el día: la siguiente get() vuelve a pedir', async () => {
		const client = okClient();
		const cache = new BrlCache({ client, now: () => 0 });

		await cache.get('2026-09-03');
		cache.invalidate('la cola ha materializado algo');
		await cache.get('2026-09-03');

		expect(client.brl).toHaveBeenCalledTimes(2);
		expect(client.brlJson).toHaveBeenCalledTimes(2);
	});
});
