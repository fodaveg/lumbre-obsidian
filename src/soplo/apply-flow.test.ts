import { describe, expect, it } from 'vitest';

import { runApply } from './apply-flow';

describe('runApply', () => {
	it('con todo bien, aplicado y sin nada que reintentar', async () => {
		expect(await runApply(async () => undefined)).toEqual({
			state: 'applied',
			error: null,
			retry: null,
		});
	});

	it('si aplicar LANZA, el modal se queda en error y con «Aplicar» reintentable', async () => {
		// Sin esto el modal se quedaba en «Aplicando…» y con los botones muertos.
		const outcome = await runApply(async () => {
			await Promise.resolve();
			throw new Error('no se pudo escribir data.json');
		});

		expect(outcome).toEqual({
			state: 'error',
			error: 'no se pudo escribir data.json',
			retry: 'apply',
		});
	});

	it('lo que se lanza sin ser un Error también sale descrito', async () => {
		const outcome = await runApply(async () => {
			await Promise.resolve();
			// eslint-disable-next-line @typescript-eslint/only-throw-error -- lo que llega a un `catch` de un plugin no siempre es un Error, y eso es justo lo que se prueba
			throw 'se cayó la red';
		});

		expect(outcome.state).toBe('error');
		expect(outcome.error).toContain('se cayó la red');
	});
});
