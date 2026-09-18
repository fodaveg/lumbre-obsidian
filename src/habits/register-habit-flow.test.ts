import { describe, expect, it } from 'vitest';

import type { MutationOp } from '../lumbre/client';
import type { LinkTarget, MutationCheck, MutationQueuedOperation } from '../lumbre/queue';
import { registerHabit, todayDate, type RegisterHabitDeps } from './register-habit-flow';

const TARGET: LinkTarget = { notePath: '', label: 'Sin nota', excerpt: null };

function fakeDeps(): { deps: RegisterHabitDeps; calls: { op: MutationOp; check: MutationCheck }[] } {
	const calls: { op: MutationOp; check: MutationCheck }[] = [];
	const deps: RegisterHabitDeps = {
		queue: {
			enqueueMutation: async (op, check, target): Promise<MutationQueuedOperation> => {
				calls.push({ op, check });
				return {
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
			},
		},
	};
	return { deps, calls };
}

describe('registerHabit', () => {
	it('nombre vacío no encola nada', async () => {
		const { deps, calls } = fakeDeps();
		const outcome = await registerHabit(deps, '   ', '2026-09-18', TARGET);
		expect(outcome).toEqual({ ok: false, reason: 'empty-name' });
		expect(calls).toHaveLength(0);
	});

	it('recorta espacios y manda el nombre como habitId, con el check none', async () => {
		const { deps, calls } = fakeDeps();
		const outcome = await registerHabit(deps, '  Correr  ', '2026-09-18', TARGET);

		expect(outcome.ok).toBe(true);
		expect(calls).toEqual([
			{
				op: { op: 'registerHabit', habitId: 'Correr', date: '2026-09-18' },
				check: { check: 'none' },
			},
		]);
	});
});

describe('todayDate', () => {
	it('formatea YYYY-MM-DD en local, con ceros a la izquierda', () => {
		expect(todayDate(new Date(2026, 8, 5))).toBe('2026-09-05');
	});

	it('un día y mes de dos dígitos no lleva ceros de más', () => {
		expect(todayDate(new Date(2026, 10, 23))).toBe('2026-11-23');
	});
});
