import { describe, expect, it } from 'vitest';

import type { MutationOp } from '../lumbre/client';
import type { LinkTarget, MutationCheck, MutationQueuedOperation, OperationState } from '../lumbre/queue';
import { saveListNotesSnapshot, setListNotesOp, type ListNotesDeps } from './list-notes-flow';

const TARGET: LinkTarget = { notePath: 'Proyectos/Cocina.md', label: 'Cocina', excerpt: null };

describe('setListNotesOp', () => {
	it('con contenido, pide revive: true', () => {
		expect(setListNotesOp('list-1', 'texto de la foto')).toEqual({
			op: 'setListNotes',
			listId: 'list-1',
			notes: 'texto de la foto',
			revive: true,
		});
	});

	it('borrando con null, no pide revive', () => {
		expect(setListNotesOp('list-1', null)).toEqual({
			op: 'setListNotes',
			listId: 'list-1',
			notes: null,
		});
	});

	it('con una cadena de solo espacios, no pide revive: no hay contenido de verdad', () => {
		expect(setListNotesOp('list-1', '   ')).toEqual({
			op: 'setListNotes',
			listId: 'list-1',
			notes: '   ',
		});
	});
});

/** Un doble de la cola: `enqueueMutation` guarda la op, `flush` decide el estado final. */
function fakeDeps(finalState: OperationState, error: string | null = null): ListNotesDeps {
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
					createdAt: 't',
					updatedAt: 't',
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

describe('saveListNotesSnapshot', () => {
	it('encola setListNotes con el check listNotes y la cabecera de la foto', async () => {
		let sentOp: MutationOp | null = null;
		let sentCheck: MutationCheck | null = null;
		const deps: ListNotesDeps = {
			queue: {
				enqueueMutation: async (op, check, _target): Promise<MutationQueuedOperation> => {
					sentOp = op;
					sentCheck = check;
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

		await saveListNotesSnapshot(deps, 'list-1', 'foto entera', '=== Foto de la nota ===', TARGET);

		expect(sentOp).toEqual({ op: 'setListNotes', listId: 'list-1', notes: 'foto entera', revive: true });
		expect(sentCheck).toEqual({ check: 'listNotes', listId: 'list-1', header: '=== Foto de la nota ===' });
	});

	it('materializada: no rechazada, sin error', async () => {
		const deps = fakeDeps('materialized');
		const outcome = await saveListNotesSnapshot(deps, 'list-1', 'foto', 'cabecera', TARGET);
		expect(outcome).toEqual({ rejected: false, error: null });
	});

	it('rechazada: dice el motivo del servidor', async () => {
		const deps = fakeDeps('rejected', 'Eso ya no existe en Lumbre.');
		const outcome = await saveListNotesSnapshot(deps, 'list-1', 'foto', 'cabecera', TARGET);
		expect(outcome).toEqual({ rejected: true, error: 'Eso ya no existe en Lumbre.' });
	});
});
