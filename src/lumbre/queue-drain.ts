/**
 * Drenaje periódico de la cola.
 *
 * La cola solo se movía cuando algo la empujaba: al cargar el plugin, al volver
 * la red y con cada gesto del usuario. Entre medias, una operación que quedó
 * aceptada sin confirmar (o encolada sin conexión, con el evento `online`
 * perdido) se quedaba ahí sin que nadie la volviera a mirar hasta el siguiente
 * arranque de Obsidian.
 *
 * El temporizador se registra con `Plugin.registerInterval`, que es lo que hace
 * que Obsidian lo pare al descargar el plugin: un `setInterval` suelto sigue
 * corriendo tras un `disable` y deja el plugin viejo hablando con la API.
 *
 * Módulo puro: no importa `obsidian`. Quien lo arranca (`main.ts`) le pasa cómo
 * registrar el intervalo y cómo saber si hay conexión.
 */

import type { Logger } from '../diagnostics/logger';
import type { OperationQueue } from './queue';

/** Cada cuánto se mira la cola. Un minuto: no es urgente, es que no se olvide. */
export const QUEUE_DRAIN_INTERVAL_MS = 60_000;

export interface QueueDrainDeps {
	queue: Pick<OperationQueue, 'actionable' | 'flush'>;
	/** Si hay conexión. En el plugin es `navigator.onLine`. */
	isOnline(): boolean;
	/**
	 * Registra el temporizador. En el plugin es
	 * `registerInterval(window.setInterval(handler, ms))`.
	 */
	register(handler: () => void, ms: number): void;
	/** Registro de diagnóstico, ya etiquetado como `queue`. */
	logger?: Logger;
}

/** Arranca el drenaje periódico. */
export function startQueueDrain(deps: QueueDrainDeps, ms = QUEUE_DRAIN_INTERVAL_MS): void {
	deps.register(() => {
		void drainQueueOnce(deps);
	}, ms);
}

/**
 * Una pasada: drena SOLO si hay conexión y algo que hacer. Sin las dos
 * condiciones esto sería un `flush()` por minuto para siempre, también en un
 * vault sin nada pendiente.
 */
export async function drainQueueOnce(deps: QueueDrainDeps): Promise<void> {
	if (!deps.isOnline()) return;
	const pending = deps.queue.actionable();
	if (pending.length === 0) return;

	deps.logger?.debug('Drenaje periódico de la cola', { actionable: pending.length });
	await deps.queue.flush();
}
