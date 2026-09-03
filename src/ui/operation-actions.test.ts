import { describe, expect, it, vi } from 'vitest';

import { MAX_ATTEMPTS, type OperationState, type StatusOperation } from '../lumbre/queue';
import { operationActions } from './operation-actions';

function operation(state: OperationState, attempts = 0): StatusOperation {
	return {
		id: 'op-1',
		deviceId: 'device-1',
		state,
		attempts,
		error: state === 'rejected' ? 'Lumbre rechazó la operación por su contenido (400).' : null,
		createdAt: '2026-09-03T10:00:00.000Z',
		updatedAt: '2026-09-03T10:00:00.000Z',
		sentAt: null,
		kind: 'status',
		taskId: 'task-1',
		done: true,
		target: { notePath: 'Casa.md', label: 'Casa', excerpt: null },
	};
}

function handlers(): { retry: ReturnType<typeof vi.fn>; discard: ReturnType<typeof vi.fn> } {
	return { retry: vi.fn(), discard: vi.fn() };
}

describe('operationActions', () => {
	it('una rechazada ofrece reintentar y DESCARTAR', () => {
		const actions = operationActions(operation('rejected'), handlers());
		expect(actions.map((action) => action.id)).toEqual(['retry', 'discard']);
	});

	it('el botón de descartar llama a discard con el id de la operación', () => {
		const spies = handlers();

		const actions = operationActions(operation('rejected'), spies);
		actions.find((action) => action.id === 'discard')?.run();

		expect(spies.discard).toHaveBeenCalledWith('op-1');
		expect(spies.retry).not.toHaveBeenCalled();
	});

	it('un error recuperable con intentos de sobra solo ofrece reintentar', () => {
		const actions = operationActions(operation('recoverable_error', 1), handlers());
		expect(actions.map((action) => action.id)).toEqual(['retry']);
	});

	it('un error recuperable AGOTADO también se puede descartar', () => {
		const actions = operationActions(operation('recoverable_error', MAX_ATTEMPTS), handlers());
		expect(actions.map((action) => action.id)).toEqual(['retry', 'discard']);
	});

	it('lo que sigue su camino no ofrece nada', () => {
		expect(operationActions(operation('pending_local'), handlers())).toEqual([]);
		expect(operationActions(operation('sent'), handlers())).toEqual([]);
		expect(operationActions(operation('materialized'), handlers())).toEqual([]);
	});
});
