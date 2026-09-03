import { describe, expect, it, vi } from 'vitest';

import { drainQueueOnce, QUEUE_DRAIN_INTERVAL_MS, startQueueDrain } from './queue-drain';
import type { QueuedOperation } from './queue';

function deps(options: { online?: boolean; actionable?: number } = {}) {
	const registered: { handler: () => void; ms: number }[] = [];
	const flush = vi.fn(async (): Promise<void> => undefined);
	return {
		registered,
		flush,
		queue: {
			actionable: (): QueuedOperation[] =>
				Array.from({ length: options.actionable ?? 0 }, () => ({}) as QueuedOperation),
			flush,
		},
		isOnline: (): boolean => options.online ?? true,
		register: (handler: () => void, ms: number): void => {
			registered.push({ handler, ms });
		},
	};
}

describe('startQueueDrain', () => {
	it('registra UN temporizador de un minuto, y lo hace por el registro del plugin', () => {
		const harness = deps();

		startQueueDrain(harness);

		// `register` es `registerInterval(window.setInterval(...))` en `main.ts`:
		// un `setInterval` suelto seguiría corriendo tras desactivar el plugin.
		expect(harness.registered).toHaveLength(1);
		expect(harness.registered[0]?.ms).toBe(QUEUE_DRAIN_INTERVAL_MS);
	});
});

describe('drainQueueOnce', () => {
	it('drena cuando hay conexión y algo accionable', async () => {
		const harness = deps({ online: true, actionable: 2 });

		await drainQueueOnce(harness);

		expect(harness.flush).toHaveBeenCalledTimes(1);
	});

	it('sin conexión no llama a la cola', async () => {
		const harness = deps({ online: false, actionable: 2 });

		await drainQueueOnce(harness);

		expect(harness.flush).not.toHaveBeenCalled();
	});

	it('sin nada accionable tampoco', async () => {
		const harness = deps({ online: true, actionable: 0 });

		await drainQueueOnce(harness);

		expect(harness.flush).not.toHaveBeenCalled();
	});
});
