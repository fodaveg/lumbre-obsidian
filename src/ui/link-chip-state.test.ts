import { describe, expect, it } from 'vitest';

import type { CreateOperation, OperationState, QueuedOperation, StatusOperation } from '../lumbre/queue';
import { linkChipState, pendingOperationFor } from './link-chip-state';

function base(state: OperationState, error: string | null = null): Omit<CreateOperation, 'kind'> {
	return {
		id: 'op-1',
		deviceId: 'device-1',
		state,
		attempts: 0,
		error,
		createdAt: '2026-09-03T10:00:00.000Z',
		updatedAt: '2026-09-03T10:00:00.000Z',
		sentAt: null,
		clientTaskId: 'task-1',
		draft: { title: 'Comprar pan' },
		target: { notePath: 'Casa.md', label: 'Casa', excerpt: null },
	};
}

function createOp(state: OperationState, error: string | null = null): CreateOperation {
	return { ...base(state, error), kind: 'create' };
}

function statusOp(state: OperationState): StatusOperation {
	const { clientTaskId: _clientTaskId, ...rest } = base(state);
	return { ...rest, kind: 'status', taskId: 'task-2', done: true };
}

describe('pendingOperationFor', () => {
	it('un create se busca por su clientTaskId, que ES el id de la tarea', () => {
		const operations: QueuedOperation[] = [createOp('sent')];
		expect(pendingOperationFor(operations, 'task-1')?.id).toBe('op-1');
		expect(pendingOperationFor(operations, 'task-9')).toBeUndefined();
	});

	it('un status se busca por su taskId', () => {
		expect(pendingOperationFor([statusOp('sent')], 'task-2')?.kind).toBe('status');
	});

	it('con varias sobre la misma tarea gana la MÁS RECIENTE', () => {
		// Si ganara la primera, una rechazada de hace días marcaría la tarea como
		// «Rechazada» para siempre, tapando lo que se acaba de encolar encima.
		const vieja: CreateOperation = { ...createOp('rejected'), id: 'op-vieja' };
		const nueva: CreateOperation = {
			...createOp('pending_local'),
			id: 'op-nueva',
			createdAt: '2026-09-03T12:00:00.000Z',
			updatedAt: '2026-09-03T12:00:00.000Z',
		};

		expect(pendingOperationFor([vieja, nueva], 'task-1')?.id).toBe('op-nueva');
		expect(pendingOperationFor([nueva, vieja], 'task-1')?.id).toBe('op-nueva');
	});
});

describe('linkChipState', () => {
	it('materializado no pinta chip', () => {
		expect(linkChipState({ syncState: 'materialized', error: null })).toEqual({
			label: null,
			reason: null,
			tone: null,
		});
	});

	it('pendiente y enviado dicen lo mismo: enviando', () => {
		expect(linkChipState({ syncState: 'pending_local', error: null }).label).toBe('Enviando…');
		expect(linkChipState({ syncState: 'sent', error: null }).label).toBe('Enviando…');
	});

	it('un error recuperable enseña el motivo guardado', () => {
		const chip = linkChipState({ syncState: 'recoverable_error', error: 'No hay red.' });
		expect(chip).toEqual({ label: 'Sin confirmar', reason: 'No hay red.', tone: 'warning' });
	});

	it('un rechazo enseña el motivo y nunca se queda sin él', () => {
		expect(linkChipState({ syncState: 'rejected', error: null })).toEqual({
			label: 'Rechazada',
			reason: 'Lumbre rechazó la operación.',
			tone: 'error',
		});
	});

	it('la operación en curso gana sobre una lectura antigua en verde', () => {
		const chip = linkChipState({ syncState: 'materialized', error: null }, createOp('sent'));
		expect(chip.label).toBe('Enviando…');
	});

	it('una operación ya materializada deja mandar al vínculo', () => {
		const chip = linkChipState(
			{ syncState: 'recoverable_error', error: 'Se cayó la red.' },
			createOp('materialized'),
		);
		expect(chip.label).toBe('Sin confirmar');
		expect(chip.reason).toBe('Se cayó la red.');
	});
});
