import { describe, expect, it } from 'vitest';

import { MAX_BATCH_OPS, type AgentPlanOp } from '../lumbre/client';
import { planToBatches, planToOps } from './plan-to-ops';

const ADD: AgentPlanOp = {
	op: 'add',
	id: 'nueva-1',
	content: 'Comprar pan',
	list: 'Casa',
	notes: null,
	extra: { date: '2026-09-04', priority: 2, deadline: null, subtasks: ['Integral'] },
	time: '18:30',
};

const MUTATION: AgentPlanOp = {
	op: 'mutation',
	taskId: 'task-9',
	kind: 'reschedule',
	payload: { date: '2026-09-10' },
};

describe('planToOps: qué se aplica', () => {
	it('solo traduce lo MARCADO', () => {
		const result = planToOps([ADD, MUTATION], [false, true]);

		expect(result.ops).toEqual([
			{ type: 'mutateRaw', taskId: 'task-9', kind: 'reschedule', payload: { date: '2026-09-10' } },
		]);
		expect(result.createdTaskIds).toEqual([]);
	});

	it('un índice sin casilla se trata como desmarcado', () => {
		expect(planToOps([ADD, MUTATION], [true]).ops).toHaveLength(1);
		expect(planToOps([ADD, MUTATION], []).ops).toHaveLength(0);
	});

	it('con todas marcadas conserva el ORDEN del plan', () => {
		const result = planToOps([ADD, MUTATION], [true, true]);

		expect(result.ops.map((op) => op.type)).toEqual(['create', 'mutateRaw']);
	});
});

describe('planToOps: un alta', () => {
	it('el id del plan es el clientTaskId, y sale también en createdTaskIds', () => {
		const result = planToOps([ADD], [true]);

		expect(result.ops[0]).toEqual({
			type: 'create',
			clientTaskId: 'nueva-1',
			draft: {
				title: 'Comprar pan',
				list: 'Casa',
				date: '2026-09-04',
				time: '18:30',
				priority: 'p2',
				subtasks: ['Integral'],
			},
		});
		expect(result.createdTaskIds).toEqual(['nueva-1']);
	});

	it('traduce el nivel de prioridad y deja p4 fuera del borrador', () => {
		const sinPrioridad = planToOps([{ ...ADD, extra: { priority: null } }], [true]);

		expect(sinPrioridad.ops[0]).toEqual({
			type: 'create',
			clientTaskId: 'nueva-1',
			draft: { title: 'Comprar pan', list: 'Casa', time: '18:30' },
		});
	});

	it('«Algún día» viaja como someday, sin fecha', () => {
		const algunDia = planToOps(
			[{ op: 'add', id: 'n', content: 'Aprender ruso', extra: { someday: true } }],
			[true],
		);

		expect(algunDia.ops[0]).toEqual({
			type: 'create',
			clientTaskId: 'n',
			draft: { title: 'Aprender ruso', someday: true },
		});
	});

	it('un alta sin id o sin contenido no se aplica, se cuenta como saltada', () => {
		const result = planToOps(
			[
				{ op: 'add', content: 'Sin id' },
				{ op: 'add', id: 'n', content: '' },
			],
			[true, true],
		);

		expect(result.ops).toHaveLength(0);
		expect(result.skipped).toBe(2);
	});
});

describe('planToOps: una mutación', () => {
	it('el kind y el payload viajan VERBATIM, sin traducirlos', () => {
		// El payload lo escribió Lumbre y es lo que describía la línea aprobada:
		// recortarlo aplicaría algo distinto de lo que el usuario vio.
		const raro: AgentPlanOp = {
			op: 'mutation',
			taskId: 'task-9',
			kind: 'update',
			payload: { content: 'Otro título', recurrence: { every: 'week' }, deadline: '2026-10-01' },
		};

		const result = planToOps([raro], [true]);

		expect(result.ops[0]).toEqual({
			type: 'mutateRaw',
			taskId: 'task-9',
			kind: 'update',
			payload: { content: 'Otro título', recurrence: { every: 'week' }, deadline: '2026-10-01' },
		});
	});

	it('una mutación sin taskId o sin kind no se aplica', () => {
		const result = planToOps(
			[
				{ op: 'mutation', kind: 'complete', payload: {} },
				{ op: 'mutation', taskId: 'task-9', payload: {} },
			],
			[true, true],
		);

		expect(result.ops).toHaveLength(0);
		expect(result.skipped).toBe(2);
	});
});

describe('planToOps: lo que no es una tarea', () => {
	it('las entradas del BRL y los hábitos se cuentan como saltadas', () => {
		const result = planToOps(
			[
				{ op: 'brl', id: 'e-1', kind: 'note', content: 'Una nota', date: '2026-09-03' },
				{ op: 'habit', habitId: 'h-1', name: 'Correr', date: '2026-09-03' },
				ADD,
			],
			[true, true, true],
		);

		expect(result.ops).toHaveLength(1);
		expect(result.skipped).toBe(2);
	});

	it('un plan vacío no produce nada', () => {
		expect(planToOps([], [])).toEqual({ ops: [], createdTaskIds: [], skipped: 0 });
	});
});

describe('planToBatches: el tope de POST /api/batch', () => {
	/** Un plan de N altas, todas marcadas. */
	function bigPlan(count: number): { plan: AgentPlanOp[]; checked: boolean[] } {
		const plan = Array.from({ length: count }, (_unused, index) => ({
			...ADD,
			id: `nueva-${index}`,
		}));
		return { plan, checked: plan.map(() => true) };
	}

	it('un plan de 250 acciones sale en DOS lotes, ninguno por encima del tope', () => {
		const { plan, checked } = bigPlan(250);

		const result = planToBatches(plan, checked);

		expect(result.batches).toHaveLength(2);
		expect(result.batches.map((batch) => batch.ops.length)).toEqual([MAX_BATCH_OPS, 50]);
		expect(result.total).toBe(250);
		expect(result.skipped).toBe(0);
	});

	it('cada lote lleva los ids de LAS SUYAS, no los del plan entero', () => {
		const { plan, checked } = bigPlan(250);

		const [first, second] = planToBatches(plan, checked).batches;

		expect(first?.createdTaskIds).toHaveLength(MAX_BATCH_OPS);
		expect(second?.createdTaskIds).toEqual(['nueva-200', ...Array.from({ length: 49 }, (_u, i) => `nueva-${201 + i}`)]);
	});

	it('un plan que cabe entero sigue siendo UN lote', () => {
		const { plan, checked } = bigPlan(MAX_BATCH_OPS);

		expect(planToBatches(plan, checked).batches).toHaveLength(1);
	});

	it('sin nada marcado no hay ningún lote', () => {
		const { plan } = bigPlan(10);

		expect(planToBatches(plan, plan.map(() => false)).batches).toEqual([]);
	});
});
