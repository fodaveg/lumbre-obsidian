import { describe, expect, it } from 'vitest';

import type { MutationQueuedOperation, QueuedOperation } from '../lumbre/queue';
import { brlEntryChipState, pendingOperationForEntry } from './brl-entry-state';

const TARGET = { notePath: 'nota.md', label: 'nota', excerpt: null };

function editOp(overrides: Partial<MutationQueuedOperation> = {}): MutationQueuedOperation {
	return {
		id: 'op-1',
		deviceId: 'device-1',
		state: 'sent',
		attempts: 0,
		error: null,
		createdAt: '2026-09-03T10:00:00.000Z',
		updatedAt: '2026-09-03T10:00:00.000Z',
		sentAt: '2026-09-03T10:00:00.000Z',
		kind: 'mutation',
		op: { op: 'updateBrlEntry', entryId: 'entry-1', entry: '- editado' },
		check: { check: 'brlEntry', date: '2026-09-03', entryId: 'entry-1', entry: '- editado' },
		target: TARGET,
		...overrides,
	};
}

function removeOp(overrides: Partial<MutationQueuedOperation> = {}): MutationQueuedOperation {
	return editOp({
		id: 'op-2',
		op: { op: 'removeBrlEntry', entryId: 'entry-1' },
		check: { check: 'brlEntry', date: '2026-09-03', entryId: 'entry-1', entry: null },
		...overrides,
	});
}

describe('pendingOperationForEntry', () => {
	it('encuentra la mutación que apunta a esta entrada', () => {
		const operation = editOp();

		expect(pendingOperationForEntry([operation], 'entry-1')).toBe(operation);
	});

	it('ignora mutaciones de otra entrada y de otro check', () => {
		const otherEntry = editOp({ id: 'op-3', check: { check: 'brlEntry', date: '2026-09-03', entryId: 'entry-9', entry: '- otra' } });
		const otherCheck: QueuedOperation = {
			id: 'op-4',
			deviceId: 'device-1',
			state: 'sent',
			attempts: 0,
			error: null,
			createdAt: '2026-09-03T10:00:00.000Z',
			updatedAt: '2026-09-03T10:00:00.000Z',
			sentAt: '2026-09-03T10:00:00.000Z',
			kind: 'brl',
			entryId: 'entry-1',
			date: '2026-09-03',
			entry: '- nueva',
			target: TARGET,
		};

		expect(pendingOperationForEntry([otherEntry, otherCheck], 'entry-1')).toBeUndefined();
	});

	it('con varias sobre la misma entrada, gana la más reciente', () => {
		const older = editOp({ id: 'op-old', createdAt: '2026-09-03T09:00:00.000Z' });
		const newer = removeOp({ id: 'op-new', createdAt: '2026-09-03T11:00:00.000Z' });

		expect(pendingOperationForEntry([older, newer], 'entry-1')).toBe(newer);
	});
});

describe('brlEntryChipState', () => {
	it('sin operación, no hay chip', () => {
		expect(brlEntryChipState(undefined)).toEqual({ label: null, reason: null, tone: null, deleting: false });
	});

	it('materializada, no hay chip', () => {
		expect(brlEntryChipState(editOp({ state: 'materialized' }))).toEqual({
			label: null,
			reason: null,
			tone: null,
			deleting: false,
		});
	});

	it('una edición en vuelo dice «Guardando…»', () => {
		const chip = brlEntryChipState(editOp({ state: 'sent' }));

		expect(chip.label).toBe('Guardando…');
		expect(chip.tone).toBe('pending');
		expect(chip.deleting).toBe(false);
	});

	it('un borrado en vuelo dice «Eliminando…»', () => {
		const chip = brlEntryChipState(removeOp({ state: 'pending_local' }));

		expect(chip.label).toBe('Eliminando…');
		expect(chip.tone).toBe('pending');
		expect(chip.deleting).toBe(true);
	});

	it('sin confirmar tras agotar intentos', () => {
		const chip = brlEntryChipState(editOp({ state: 'recoverable_error', attempts: 5 }));

		expect(chip.label).toBe('Sin confirmar');
		expect(chip.tone).toBe('warning');
	});

	it('rechazada por el servidor', () => {
		const chip = brlEntryChipState(removeOp({ state: 'rejected', error: 'Lumbre rechazó la operación (400).' }));

		expect(chip.label).toBe('Rechazada');
		expect(chip.tone).toBe('error');
		expect(chip.reason).toBe('Lumbre rechazó la operación (400).');
		expect(chip.deleting).toBe(true);
	});
});
