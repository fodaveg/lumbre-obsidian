import { describe, expect, it } from 'vitest';

import type { MutationOp } from '../lumbre/client';
import type { LinkTarget, MutationCheck, MutationQueuedOperation, OperationState } from '../lumbre/queue';
import { createListFromNote, listNameFromNote, type CreateListDeps } from './create-list-from-note';

const TARGET: LinkTarget = {
	notePath: 'Proyectos/21.11 Lumbre.md',
	label: '21.11 Lumbre',
	excerpt: null,
};

/** Un doble de la cola: `enqueueMutation` guarda la op, `flush` decide el estado final. */
function fakeDeps(finalState: OperationState, error: string | null = null): CreateListDeps {
	let stored: MutationQueuedOperation | null = null;
	return {
		queue: {
			enqueueMutation: async (
				op: MutationOp,
				check: MutationCheck,
				target: LinkTarget,
			): Promise<MutationQueuedOperation> => {
				stored = {
					id: 'op-1',
					deviceId: 'device-a',
					state: 'pending_local',
					attempts: 0,
					error: null,
					createdAt: '2026-09-18T10:00:00.000Z',
					updatedAt: '2026-09-18T10:00:00.000Z',
					sentAt: null,
					kind: 'mutation',
					op,
					check,
					target,
				};
				return stored;
			},
			flush: async (): Promise<void> => {
				if (stored !== null) stored = { ...stored, state: finalState, error };
			},
			snapshot: (): MutationQueuedOperation[] => (stored === null ? [] : [stored]),
		},
	};
}

describe('listNameFromNote', () => {
	it('devuelve el nombre literal, sin prefijo Johnny.Decimal', () => {
		expect(listNameFromNote('Recetas')).toBe('Recetas');
	});

	it('devuelve el nombre literal, CON su prefijo Johnny.Decimal', () => {
		expect(listNameFromNote('21.11 Lumbre')).toBe('21.11 Lumbre');
	});
});

describe('createListFromNote', () => {
	it('con la nota ya vinculada, no crea nada', async () => {
		const deps = fakeDeps('materialized');
		const outcome = await createListFromNote(deps, '21.11 Lumbre', 'list-anterior', TARGET);
		expect(outcome).toEqual({ ok: false, reason: 'already-linked' });
	});

	it('crea la lista con el nombre literal y confirma en el mismo flush', async () => {
		const deps = fakeDeps('materialized');
		const outcome = await createListFromNote(deps, '21.11 Lumbre', null, TARGET);
		expect(outcome).toMatchObject({ ok: true, name: '21.11 Lumbre' });
		if (outcome.ok) expect(outcome.listId.length).toBeGreaterThan(0);
	});

	it('manda la op createList con el listId que fija aquí y el check listExists', async () => {
		const calls: { op: MutationOp; check: MutationCheck }[] = [];
		const deps: CreateListDeps = {
			queue: {
				enqueueMutation: async (op, check, _target): Promise<MutationQueuedOperation> => {
					calls.push({ op, check });
					return {
						id: 'op-1',
						deviceId: 'device-a',
						state: 'materialized',
						attempts: 0,
						error: null,
						createdAt: 't',
						updatedAt: 't',
						sentAt: 't',
						kind: 'mutation',
						op,
						check,
						target: TARGET,
					};
				},
				flush: async (): Promise<void> => undefined,
				snapshot: (): MutationQueuedOperation[] => [],
			},
		};
		await createListFromNote(deps, 'Cocina', null, TARGET);

		expect(calls).toHaveLength(1);
		const call = calls[0];
		expect(call?.op).toMatchObject({ op: 'createList', name: 'Cocina' });
		expect(call?.check).toMatchObject({ check: 'listExists' });
		// El `listId` que lleva la op es el MISMO que releerá el check.
		const op = call?.op;
		const check = call?.check;
		const listId = op !== undefined && 'listId' in op ? op.listId : null;
		const checkListId = check !== undefined && 'listId' in check ? check.listId : null;
		expect(checkListId).toBe(listId);
		expect(listId).not.toBeNull();
	});

	it('rechazada: no confirma y devuelve el motivo del servidor', async () => {
		const deps = fakeDeps('rejected', 'Lumbre rechazó la operación por su contenido.');
		const outcome = await createListFromNote(deps, 'Cocina', null, TARGET);
		expect(outcome).toEqual({
			ok: false,
			reason: 'not-confirmed',
			error: 'Lumbre rechazó la operación por su contenido.',
		});
	});

	it('todavía sin confirmar (sent): no vincula, pero no es un rechazo', async () => {
		const deps = fakeDeps('sent');
		const outcome = await createListFromNote(deps, 'Cocina', null, TARGET);
		expect(outcome).toEqual({ ok: false, reason: 'not-confirmed', error: null });
	});
});
