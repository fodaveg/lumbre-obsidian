import { describe, expect, it, vi } from 'vitest';

import { LumbreClient, type LumbreRequestInit, type LumbreRequestFn } from './client';

const ORIGIN = 'https://app.lumbre.pro';

function clientWith(request: LumbreRequestFn, token: string | null = 'tok-123'): LumbreClient {
	return new LumbreClient({ apiOrigin: ORIGIN, getToken: async () => token, request });
}

function respondWith(status: number): LumbreRequestFn {
	return async () => ({ status });
}

describe('LumbreClient.ping', () => {
	it('devuelve no_token cuando no hay token guardado', async () => {
		const request = vi.fn(respondWith(200));

		const result = await clientWith(request, null).ping();

		expect(result).toEqual({ ok: false, reason: 'no_token' });
		expect(request).not.toHaveBeenCalled();
	});

	it('devuelve ok con un 200', async () => {
		expect(await clientWith(respondWith(200)).ping()).toEqual({ ok: true });
	});

	it.each([401, 403])('devuelve unauthorized con un %i', async (status) => {
		expect(await clientWith(respondWith(status)).ping()).toEqual({
			ok: false,
			reason: 'unauthorized',
			status,
		});
	});

	it('devuelve server con un 500', async () => {
		expect(await clientWith(respondWith(500)).ping()).toEqual({
			ok: false,
			reason: 'server',
			status: 500,
		});
	});

	it('devuelve network cuando la petición lanza', async () => {
		const request: LumbreRequestFn = async () => {
			throw new Error('getaddrinfo ENOTFOUND');
		};

		expect(await clientWith(request).ping()).toEqual({ ok: false, reason: 'network' });
	});

	it('pide la URL exacta con la cabecera Authorization exacta', async () => {
		const calls: LumbreRequestInit[] = [];
		const request: LumbreRequestFn = async (init) => {
			calls.push(init);
			return { status: 200 };
		};

		await clientWith(request, 'tok-123').ping();

		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe('https://app.lumbre.pro/api/tasks?limit=1&notes=none');
		expect(calls[0]?.headers['Authorization']).toBe('Bearer tok-123');
		expect(calls[0]?.method).toBe('GET');
	});
});
