/**
 * Qué chip de estado le toca a un vínculo nota ↔ tarea.
 *
 * Módulo puro: no importa `obsidian`. Junta las dos fuentes que hay sobre el
 * mismo vínculo, la operación que sigue en la cola y el estado guardado del
 * vínculo, y devuelve la etiqueta y el motivo.
 *
 * La regla que da sentido a esto: un 200 no es un hecho. Mientras haya una
 * operación sin materializar apuntando a esa tarea, el chip dice "Enviando…"
 * aunque el vínculo tenga guardada una lectura antigua en verde.
 */

import type { OperationState, QueuedOperation } from '../lumbre/queue';

/** Lo que hace falta del vínculo. Lo cumple `LumbreTaskLink`. */
export interface ChipInput {
	syncState: OperationState;
	error: string | null;
}

export interface ChipState {
	/** Texto del chip, o `null` cuando no hay nada que enseñar. */
	label: string | null;
	/** Motivo para el `title` del chip, o `null`. */
	reason: string | null;
	/** Familia de color. `null` cuando no se pinta chip. */
	tone: 'pending' | 'warning' | 'error' | null;
}

/**
 * La operación de la cola que afecta a esta tarea, o `undefined`. Para un
 * `create` el id de la tarea ES el `clientTaskId`: lo fija el plugin antes de
 * enviar, así que el vínculo ya puede apuntar a él. Un `batch` afecta a las
 * tareas que crea, cuyos ids también fija el plugin.
 *
 * Cuando hay VARIAS sobre la misma tarea gana la más reciente por `createdAt`:
 * con la primera, una rechazada de hace días dejaría la tarea marcada
 * «Rechazada» para siempre, tapando la que se acaba de encolar encima.
 *
 * Una operación de BRL no afecta a ninguna tarea: una entrada del registro no
 * lo es. Tampoco un `listLink`: liga una nota con una LISTA, no con una tarea.
 * Una foto de nota (`notes`) SÍ afecta, igual que un `status`: muta una tarea
 * que ya existe, por su `taskId`.
 */
export function pendingOperationFor(
	operations: readonly QueuedOperation[],
	taskId: string,
): QueuedOperation | undefined {
	let latest: QueuedOperation | undefined;
	for (const operation of operations) {
		if (!affectsTask(operation, taskId)) continue;
		if (latest === undefined || operation.createdAt >= latest.createdAt) latest = operation;
	}
	return latest;
}

function affectsTask(operation: QueuedOperation, taskId: string): boolean {
	switch (operation.kind) {
		case 'create':
			return operation.clientTaskId === taskId;
		case 'status':
		case 'notes':
			return operation.taskId === taskId;
		case 'batch':
			return operation.createdTaskIds.includes(taskId);
		case 'brl':
		case 'listLink':
			return false;
	}
}

/** Etiqueta y motivo del chip. La operación en curso gana sobre el vínculo. */
export function linkChipState(link: ChipInput, operation?: QueuedOperation): ChipState {
	const live =
		operation !== undefined && operation.state !== 'materialized'
			? { state: operation.state, error: operation.error }
			: { state: link.syncState, error: link.error };

	switch (live.state) {
		case 'materialized':
			return { label: null, reason: null, tone: null };
		case 'pending_local':
		case 'sent':
			return {
				label: 'Enviando…',
				reason: live.error ?? 'Enviada a Lumbre; falta que la confirme al releer.',
				tone: 'pending',
			};
		case 'recoverable_error':
			return {
				label: 'Sin confirmar',
				reason: live.error ?? 'Lumbre todavía no lo ha confirmado.',
				tone: 'warning',
			};
		case 'rejected':
			return {
				label: 'Rechazada',
				reason: live.error ?? 'Lumbre rechazó la operación.',
				tone: 'error',
			};
	}
}
