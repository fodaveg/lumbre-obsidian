import { describe, expect, it, vi } from 'vitest';

import type { LumbreResult } from '../lumbre/client';
import { BrlCache } from './brl-cache';
import { IDLE_ENTRY_TTL_MS } from './query-cache';

/** Cliente que devuelve siempre el mismo Markdown y cuenta las llamadas. */
function okClient(markdown = '- Una nota') {
	return {
		brl: vi.fn(async (): Promise<LumbreResult<string>> => ({ ok: true, value: markdown })),
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
});
