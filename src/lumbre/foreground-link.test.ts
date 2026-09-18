import { describe, expect, it, vi } from 'vitest';

import type { ForegroundLinkBody, LumbreResult } from './client';
import { ForegroundLinkPusher } from './foreground-link';

/** Cliente falso: `foregroundLink` espiado, resuelto en éxito por defecto. */
function fakeClient(result: LumbreResult<void> = { ok: true, value: undefined }) {
	return { foregroundLink: vi.fn(async (_target: ForegroundLinkBody) => result) };
}

/** Pusher con el debounce resuelto de inmediato, igual que `wait` en los tests de `QueryCache`. */
function pusher(options: {
	client?: ReturnType<typeof fakeClient>;
	enabled?: boolean;
	vaultName?: string;
} = {}) {
	const client = options.client ?? fakeClient();
	return {
		client,
		instance: new ForegroundLinkPusher({
			client,
			vaultName: () => options.vaultName ?? 'Mi vault',
			enabled: () => options.enabled ?? true,
			wait: async () => undefined,
		}),
	};
}

describe('ForegroundLinkPusher: composición de la url', () => {
	it('compone obsidian://open?vault=&file= con espacios y acentos codificados', async () => {
		const { client, instance } = pusher({ vaultName: 'Mi vault' });

		await instance.noteChanged({ notePath: 'Área/Nota con espacios.md', basename: 'Nota con espacios' });

		expect(client.foregroundLink).toHaveBeenCalledWith({
			url: 'obsidian://open?vault=Mi%20vault&file=%C3%81rea%2FNota%20con%20espacios',
			title: 'Nota con espacios',
		});
	});

	it('escapa la almohadilla de una ruta con #', async () => {
		const { client, instance } = pusher({ vaultName: 'vault' });

		await instance.noteChanged({ notePath: 'Notas/Reunión #1.md', basename: 'Reunión #1' });

		expect(client.foregroundLink).toHaveBeenCalledWith({
			url: 'obsidian://open?vault=vault&file=Notas%2FReuni%C3%B3n%20%231',
			title: 'Reunión #1',
		});
	});
});

describe('ForegroundLinkPusher: no repite la misma url', () => {
	it('si la nota no cambia, no vuelve a empujar', async () => {
		const { client, instance } = pusher();
		const note = { notePath: 'Cocina.md', basename: 'Cocina' };

		await instance.noteChanged(note);
		await instance.noteChanged({ ...note });

		expect(client.foregroundLink).toHaveBeenCalledTimes(1);
	});

	it('si la nota cambia a otra distinta, sí empuja de nuevo', async () => {
		const { client, instance } = pusher();

		await instance.noteChanged({ notePath: 'Cocina.md', basename: 'Cocina' });
		await instance.noteChanged({ notePath: 'Jardín.md', basename: 'Jardín' });

		expect(client.foregroundLink).toHaveBeenCalledTimes(2);
	});
});

describe('ForegroundLinkPusher: debounce', () => {
	it('varios cambios rápidos producen UNA sola petición, con la ÚLTIMA nota', async () => {
		const { client, instance } = pusher();

		const rounds = [
			instance.noteChanged({ notePath: 'Uno.md', basename: 'Uno' }),
			instance.noteChanged({ notePath: 'Dos.md', basename: 'Dos' }),
			instance.noteChanged({ notePath: 'Tres.md', basename: 'Tres' }),
		];
		await Promise.all(rounds);

		expect(client.foregroundLink).toHaveBeenCalledTimes(1);
		expect(client.foregroundLink.mock.calls[0]?.[0]?.url).toContain('Tres');
	});

	it('espera FOREGROUND_LINK_DEBOUNCE_MS antes de empujar', async () => {
		const waits: number[] = [];
		const client = fakeClient();
		const instance = new ForegroundLinkPusher({
			client,
			vaultName: () => 'v',
			enabled: () => true,
			wait: async (ms: number) => {
				waits.push(ms);
			},
		});

		await instance.noteChanged({ notePath: 'Cocina.md', basename: 'Cocina' });

		expect(waits).toEqual([800]);
	});
});

describe('ForegroundLinkPusher: sin nota activa', () => {
	it('con un PDF, un lienzo o ninguna hoja abierta, no empuja nada', async () => {
		const { client, instance } = pusher();

		await instance.noteChanged(null);

		expect(client.foregroundLink).not.toHaveBeenCalled();
	});

	it('un hueco sin nota no borra la url ya empujada: la siguiente nota nueva sí se compara contra ella', async () => {
		const { client, instance } = pusher();

		await instance.noteChanged({ notePath: 'Cocina.md', basename: 'Cocina' });
		await instance.noteChanged(null);
		await instance.noteChanged({ notePath: 'Cocina.md', basename: 'Cocina' });

		// La segunda vez que se ve «Cocina» sigue siendo la MISMA url que ya se
		// había empujado: un hueco en medio sin nota activa no cambia eso.
		expect(client.foregroundLink).toHaveBeenCalledTimes(1);
	});
});

describe('ForegroundLinkPusher: ajuste apagado', () => {
	it('con el ajuste apagado, no programa ni empuja nada', async () => {
		const { client, instance } = pusher({ enabled: false });

		await instance.noteChanged({ notePath: 'Cocina.md', basename: 'Cocina' });

		expect(client.foregroundLink).not.toHaveBeenCalled();
	});
});

describe('ForegroundLinkPusher: el POST falla', () => {
	it('se descarta en silencio, sin lanzar y sin guardar la url como empujada', async () => {
		const failing = fakeClient({ ok: false, reason: 'server', status: 500 });
		const { instance } = pusher({ client: failing });

		await expect(
			instance.noteChanged({ notePath: 'Cocina.md', basename: 'Cocina' }),
		).resolves.toBeUndefined();

		// Como no se guardó como empujada, la MISMA nota vuelve a intentarlo.
		await instance.noteChanged({ notePath: 'Cocina.md', basename: 'Cocina' });
		expect(failing.foregroundLink).toHaveBeenCalledTimes(2);
	});
});
