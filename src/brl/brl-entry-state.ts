/**
 * Qué chip le toca a una entrada del BRL con una edición o un borrado
 * pendientes.
 *
 * Módulo puro: no importa `obsidian`. Es el gemelo de
 * `src/ui/link-chip-state.ts` para el registro del día: en vez de una tarea,
 * aquí lo que se sigue es una entrada por su `entryId`, y la operación que la
 * afecta es siempre una `mutation` con `check.check === 'brlEntry'` (las dos
 * únicas ops del BRL que tocan una entrada YA existente son `updateBrlEntry` y
 * `removeBrlEntry`; crear una entrada nueva es el `kind` `brl`, que no
 * confirma nada de esto).
 *
 * La regla que da sentido a esto, igual que en `link-chip-state`: un 200 no es
 * un hecho. Mientras haya una operación sin materializar sobre esta entrada,
 * el chip lo dice, aunque la última lectura confirmada siga enseñando el texto
 * de antes.
 */

import type { MutationQueuedOperation, QueuedOperation } from '../lumbre/queue';

export interface BrlEntryChip {
	/** Texto del chip, o `null` cuando no hay nada que enseñar. */
	label: string | null;
	/** Motivo para el `title` del chip, o `null`. */
	reason: string | null;
	/** Familia de color. `null` cuando no se pinta chip. */
	tone: 'pending' | 'warning' | 'error' | null;
	/**
	 * `true` si la operación pendiente es un BORRADO (`check.entry === null`):
	 * quien pinta la fila la atenúa entera, no solo el chip.
	 */
	deleting: boolean;
}

/**
 * La operación de la cola que afecta a ESTA entrada, o `undefined`.
 *
 * Cuando hay VARIAS sobre la misma entrada gana la más reciente por
 * `createdAt`, igual que `pendingOperationFor`: con la primera, una rechazada
 * de hace días dejaría la entrada marcada «Rechazada» para siempre, tapando la
 * que se acaba de encolar encima (por ejemplo, reintentar un borrado tras un
 * 5xx).
 */
export function pendingOperationForEntry(
	operations: readonly QueuedOperation[],
	entryId: string,
): MutationQueuedOperation | undefined {
	let latest: MutationQueuedOperation | undefined;
	for (const operation of operations) {
		if (operation.kind !== 'mutation' || operation.check.check !== 'brlEntry') continue;
		if (operation.check.entryId !== entryId) continue;
		if (latest === undefined || operation.createdAt >= latest.createdAt) latest = operation;
	}
	return latest;
}

/** Etiqueta y motivo del chip. Sin operación pendiente (o ya materializada), no hay chip. */
export function brlEntryChipState(operation?: MutationQueuedOperation): BrlEntryChip {
	if (operation === undefined || operation.state === 'materialized') {
		return { label: null, reason: null, tone: null, deleting: false };
	}

	// El `check` de una operación que devuelve `pendingOperationForEntry`
	// siempre es `brlEntry`: `entry: null` es un borrado, con texto es una
	// edición (ver `updateBrlEntryMutation`/`removeBrlEntryMutation`).
	const deleting = operation.check.check === 'brlEntry' && operation.check.entry === null;
	const verb = deleting ? 'el borrado' : 'la edición';

	switch (operation.state) {
		case 'pending_local':
		case 'sent':
			return {
				label: deleting ? 'Eliminando…' : 'Guardando…',
				reason: operation.error ?? 'Enviada a Lumbre; falta que la confirme al releer.',
				tone: 'pending',
				deleting,
			};
		case 'recoverable_error':
			return {
				label: 'Sin confirmar',
				reason: operation.error ?? `Lumbre todavía no ha confirmado ${verb}.`,
				tone: 'warning',
				deleting,
			};
		case 'rejected':
			return {
				label: 'Rechazada',
				reason: operation.error ?? `Lumbre rechazó ${verb}.`,
				tone: 'error',
				deleting,
			};
	}
}
