import { describe, expect, it, vi } from 'vitest';

import type { LumbreResult } from '../lumbre/client';
import type { LumbreTask } from '../lumbre/types';
import { RefTaskCache } from './ref-chip-cache';

function task(id: string, overrides: Partial<LumbreTask> = {}): LumbreTask {
	return {
		id,
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

/** `fetchMany` que responde OK con una tarea por cada id que se le pida. */
function okFetch() {
	return vi.fn(
		async (ids: string[]): Promise<LumbreResult<LumbreTask[]>> => ({
			ok: true,
			value: ids.map((id) => task(id)),
		}),
	);
}

describe('RefTaskCache', () => {
	it('agrupa varios ids del mismo render en UNA sola llamada, dedupados', async () => {
		const fetchMany = okFetch();
		const cache = new RefTaskCache({ now: () => 0 });

		const result = await cache.resolve(['a', 'b', 'a', 'c'], fetchMany);

		expect(fetchMany).toHaveBeenCalledTimes(1);
		expect(fetchMany).toHaveBeenCalledWith(['a', 'b', 'c']);
		expect(result.get('a')?.id).toBe('a');
		expect(result.get('c')?.id).toBe('c');
	});

	it('con más de 200 ids únicos, los pide TODOS en la misma llamada', async () => {
		// El tope de 200 por petición lo respeta `getTasksByIds` en el cliente
		// (trocea), no esta caché: aquí una lectura en lote es UNA llamada a
		// `fetchMany`, sin importar cuántos ids lleve.
		const ids = Array.from({ length: 250 }, (_, i) => `id-${i}`);
		const fetchMany = okFetch();
		const cache = new RefTaskCache({ now: () => 0 });

		await cache.resolve(ids, fetchMany);

		expect(fetchMany).toHaveBeenCalledTimes(1);
		expect(fetchMany).toHaveBeenCalledWith(ids);
	});

	it('no pide nada si todos los ids ya están frescos', async () => {
		const fetchMany = okFetch();
		const cache = new RefTaskCache({ now: () => 0 });

		await cache.resolve(['a'], fetchMany);
		await cache.resolve(['a'], fetchMany);

		expect(fetchMany).toHaveBeenCalledTimes(1);
	});

	it('no vuelve a pedir un id fresco cuando llegan más ids nuevos: solo pide los que faltan', async () => {
		let now = 0;
		const fetchMany = okFetch();
		const cache = new RefTaskCache({ now: () => now, ttlMs: 30_000 });

		await cache.resolve(['a'], fetchMany);
		now = 1_000;
		await cache.resolve(['a', 'b'], fetchMany);

		expect(fetchMany).toHaveBeenCalledTimes(2);
		expect(fetchMany).toHaveBeenNthCalledWith(2, ['b']);
	});

	it('vuelve a pedir cuando pasa el TTL', async () => {
		let now = 0;
		const fetchMany = okFetch();
		const cache = new RefTaskCache({ now: () => now, ttlMs: 1_000 });

		await cache.resolve(['a'], fetchMany);
		now = 2_000;
		await cache.resolve(['a'], fetchMany);

		expect(fetchMany).toHaveBeenCalledTimes(2);
	});

	it('un id sin coincidencia en la respuesta se guarda como "no existe" (null), no undefined', async () => {
		const fetchMany = vi.fn(
			async (): Promise<LumbreResult<LumbreTask[]>> => ({ ok: true, value: [] }),
		);
		const cache = new RefTaskCache({ now: () => 0 });

		const result = await cache.resolve(['borrada'], fetchMany);

		expect(result.get('borrada')).toBeNull();
	});

	it('si la lectura falla, el id sin dato previo queda undefined: la ficha cae al texto', async () => {
		const fetchMany = vi.fn(
			async (): Promise<LumbreResult<LumbreTask[]>> => ({ ok: false, reason: 'network' }),
		);
		const cache = new RefTaskCache({ now: () => 0 });

		const result = await cache.resolve(['a'], fetchMany);

		expect(result.get('a')).toBeUndefined();
	});

	it('un fallo no se cachea: el siguiente `resolve` reintenta', async () => {
		const fetchMany = vi.fn(
			async (): Promise<LumbreResult<LumbreTask[]>> => ({ ok: false, reason: 'network' }),
		);
		const cache = new RefTaskCache({ now: () => 0 });

		await cache.resolve(['a'], fetchMany);
		await cache.resolve(['a'], fetchMany);

		expect(fetchMany).toHaveBeenCalledTimes(2);
	});

	it('si la lectura falla tras haber tenido éxito antes, conserva la última lectura buena', async () => {
		let now = 0;
		const responses: LumbreResult<LumbreTask[]>[] = [
			{ ok: true, value: [task('a')] },
			{ ok: false, reason: 'network' },
		];
		const fetchMany = vi.fn(async () => {
			const next = responses.shift();
			if (next === undefined) throw new Error('sin más respuestas preparadas');
			return next;
		});
		const cache = new RefTaskCache({ now: () => now, ttlMs: 1_000 });

		await cache.resolve(['a'], fetchMany);
		now = 2_000; // caduca, la próxima resolve intenta pedirla de nuevo
		const result = await cache.resolve(['a'], fetchMany);

		expect(result.get('a')?.id).toBe('a');
	});

	it('peek devuelve lo guardado sin pedir nada', async () => {
		const fetchMany = okFetch();
		const cache = new RefTaskCache({ now: () => 0 });

		expect(cache.peek('a')).toBeUndefined();
		await cache.resolve(['a'], fetchMany);
		expect(cache.peek('a')?.id).toBe('a');
	});
});
