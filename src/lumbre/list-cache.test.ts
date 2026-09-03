import { describe, expect, it, vi } from 'vitest';

import type { LumbreResult } from './client';
import { ListCache } from './list-cache';
import type { LumbreList } from './types';

function list(id: string, name: string): LumbreList {
	return { id, name, icon: null, color: null, parentListId: null, taskCount: 0 };
}

describe('ListCache', () => {
	it('lee una vez y sirve de la caché mientras no caduque', async () => {
		const listLists = vi.fn(
			async (): Promise<LumbreResult<LumbreList[]>> => ({ ok: true, value: [list('l1', 'Casa')] }),
		);
		const cache = new ListCache({ client: { listLists }, now: () => 0 });

		expect(await cache.get()).toHaveLength(1);
		expect(await cache.get()).toHaveLength(1);
		expect(listLists).toHaveBeenCalledTimes(1);
	});

	it('vuelve a pedir cuando pasa el TTL', async () => {
		const listLists = vi.fn(
			async (): Promise<LumbreResult<LumbreList[]>> => ({ ok: true, value: [list('l1', 'Casa')] }),
		);
		let clock = 0;
		const cache = new ListCache({ client: { listLists }, ttlMs: 100, now: () => clock });

		await cache.get();
		clock = 500;
		await cache.get();
		expect(listLists).toHaveBeenCalledTimes(2);
	});

	it('si la lectura falla, conserva lo cacheado en vez de vaciarlo', async () => {
		let response: LumbreResult<LumbreList[]> = { ok: true, value: [list('l1', 'Casa')] };
		const cache = new ListCache({
			client: { listLists: async (): Promise<LumbreResult<LumbreList[]>> => response },
			ttlMs: 0,
			now: () => 0,
		});

		await cache.get();
		response = { ok: false, reason: 'network' };
		expect(await cache.get()).toEqual([list('l1', 'Casa')]);
	});

	it('resuelve el nombre de una lista por su id', async () => {
		const cache = new ListCache({
			client: {
				listLists: async (): Promise<LumbreResult<LumbreList[]>> => ({
					ok: true,
					value: [list('l1', 'Casa')],
				}),
			},
		});
		await cache.get();
		expect(cache.refFor('l1')).toEqual({ id: 'l1', name: 'Casa' });
		expect(cache.refFor('otra')).toBeNull();
		expect(cache.refFor(null)).toBeNull();
	});

	it('resuelve el nombre de una lista por su id o por su propio nombre', async () => {
		const cache = new ListCache({
			client: {
				listLists: async (): Promise<LumbreResult<LumbreList[]>> => ({
					ok: true,
					value: [list('l1', 'Casa y jardín')],
				}),
			},
		});
		await cache.get();
		expect(cache.nameFor('l1')).toBe('Casa y jardín');
		expect(cache.nameFor('casa y jardin')).toBe('Casa y jardín');
		expect(cache.nameFor('Trabajo')).toBeNull();
	});
});
