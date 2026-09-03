/**
 * Qué se puede hacer con una operación parada de la cola.
 *
 * Está aquí, en un módulo puro, porque es la regla que decide si una escritura
 * se queda colgada del vínculo para siempre: una `rejected` no se reintenta
 * sola y, sin un «Descartar», el chip rojo se queda pegado a la tarea sin
 * ninguna forma de quitarlo. Descartar no deshace nada en Lumbre; saca la
 * operación de la cola, que es cosa distinta y así se dice.
 *
 * No importa `obsidian`: el panel pinta lo que salga de aquí.
 */

import { MAX_ATTEMPTS, type QueuedOperation } from '../lumbre/queue';

/** Un botón del panel, ya resuelto: qué dice, qué icono lleva y qué hace. */
export interface OperationAction {
	id: 'retry' | 'discard';
	text: string;
	icon: string;
	/** Clase extra del botón, para el que es destructivo. */
	cls?: string;
	run(): void;
}

/** Lo que el panel sabe hacer con una operación. */
export interface OperationActionHandlers {
	retry(id: string): void;
	discard(id: string): void;
}

/** `true` si la operación ya no se va a mover sola nunca más. */
export function isStuck(operation: QueuedOperation): boolean {
	if (operation.state === 'rejected') return true;
	return operation.state === 'recoverable_error' && operation.attempts >= MAX_ATTEMPTS;
}

/**
 * Los botones de una operación. «Reintentar» sale con cualquier error, también
 * con el rechazo (el token pudo cambiar desde entonces); «Descartar» solo con
 * las que ya no se van a mover solas, que son las que si no se quedan ahí.
 */
export function operationActions(
	operation: QueuedOperation,
	handlers: OperationActionHandlers,
): OperationAction[] {
	const failed = operation.state === 'rejected' || operation.state === 'recoverable_error';
	if (!failed) return [];

	const actions: OperationAction[] = [
		{
			id: 'retry',
			text: 'Reintentar',
			icon: 'rotate-ccw',
			run: () => handlers.retry(operation.id),
		},
	];
	if (isStuck(operation)) {
		actions.push({
			id: 'discard',
			text: 'Descartar',
			icon: 'trash-2',
			cls: 'lumbre-button--danger',
			run: () => handlers.discard(operation.id),
		});
	}
	return actions;
}
