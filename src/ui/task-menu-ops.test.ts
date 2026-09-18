import { describe, expect, it } from 'vitest';

import type { LumbreTask } from '../lumbre/types';
import {
	addSubtasksOp,
	cancelOp,
	completeSubtaskOp,
	isoDatePlusDays,
	localIsoDate,
	MAX_SUBTASKS_PER_OP,
	MAX_SUBTASK_LENGTH,
	moveToListOp,
	rescheduleOp,
	restoreOp,
	setSectionOp,
	subtaskTitles,
} from './task-menu-ops';

function task(overrides: Partial<LumbreTask> = {}): LumbreTask {
	return {
		id: 'task-1',
		content: 'Comprar pan',
		notes: null,
		date: null,
		someday: false,
		deadline: null,
		time: null,
		priority: 'p4',
		done: false,
		cancelledAt: null,
		archivedAt: null,
		list: null,
		section: null,
		parentId: null,
		...overrides,
	};
}

describe('rescheduleOp', () => {
	it('a una fecha: manda date y lo confirma comparando el campo por valor', () => {
		expect(rescheduleOp(task(), '2026-09-20')).toEqual({
			action: 'reprogramar tarea',
			op: { op: 'reschedule', taskId: 'task-1', date: '2026-09-20' },
			check: { check: 'taskField', taskId: 'task-1', field: 'date', expected: '2026-09-20' },
		});
	});

	it('a null: `date` viaja igual (el endpoint lo exige) y se espera la tarea sin fecha', () => {
		// Sin fecha la tarea queda en "En cualquier momento", NO en "Algún día":
		// no hay ninguna op que ponga `someday`.
		expect(rescheduleOp(task({ date: '2026-09-18' }), null)).toEqual({
			action: 'quitar la fecha',
			op: { op: 'reschedule', taskId: 'task-1', date: null },
			check: { check: 'taskField', taskId: 'task-1', field: 'date', expected: null },
		});
	});
});

describe('cancelOp y restoreOp', () => {
	it('cancelar manda `cancelled: true` y se confirma por PRESENCIA de cancelledAt', () => {
		expect(cancelOp(task())).toEqual({
			action: 'cancelar tarea',
			op: { op: 'cancel', taskId: 'task-1', cancelled: true },
			check: { check: 'taskFieldSet', taskId: 'task-1', field: 'cancelledAt', set: true },
		});
	});

	it('restaurar no manda nada más que el objetivo y espera cancelledAt vacío', () => {
		expect(restoreOp(task({ cancelledAt: '2026-09-17T10:00:00Z' }))).toEqual({
			action: 'restaurar tarea',
			op: { op: 'restore', taskId: 'task-1' },
			check: { check: 'taskFieldSet', taskId: 'task-1', field: 'cancelledAt', set: false },
		});
	});

	it('el payload de cancelar lleva `cancelled` SIEMPRE: el endpoint no lo asume', () => {
		expect(Object.keys(cancelOp(task()).op)).toContain('cancelled');
	});
});

describe('moveToListOp', () => {
	it('por id: manda listId y compara la referencia por id', () => {
		expect(moveToListOp(task(), 'list-9')).toEqual({
			action: 'mover a otra lista',
			op: { op: 'moveToList', taskId: 'task-1', listId: 'list-9' },
			check: { check: 'taskRef', taskId: 'task-1', field: 'list', by: 'id', expected: 'list-9' },
		});
	});

	it('con null: desvincula, y se espera la tarea SIN lista', () => {
		expect(moveToListOp(task({ list: { id: 'list-9', name: 'Casa' } }), null)).toEqual({
			action: 'quitar de la lista',
			op: { op: 'moveToList', taskId: 'task-1', listId: null },
			check: { check: 'taskRef', taskId: 'task-1', field: 'list', by: 'id', expected: null },
		});
	});

	it('nunca manda `list` por nombre, que CREARÍA la lista si no existe', () => {
		expect(Object.keys(moveToListOp(task(), 'list-9').op)).not.toContain('list');
	});
});

describe('setSectionOp', () => {
	it('a una sección: va por NOMBRE, y la comprobación compara por nombre', () => {
		expect(setSectionOp(task(), 'Cocina')).toEqual({
			action: 'mover a otra sección',
			op: { op: 'setSection', taskId: 'task-1', section: 'Cocina' },
			check: {
				check: 'taskRef',
				taskId: 'task-1',
				field: 'section',
				by: 'name',
				expected: 'Cocina',
			},
		});
	});

	it('con null: la saca de la sección y se espera la tarea sin sección', () => {
		expect(setSectionOp(task({ section: { id: 's1', name: 'Cocina' } }), null)).toEqual({
			action: 'quitar de la sección',
			op: { op: 'setSection', taskId: 'task-1', section: null },
			check: { check: 'taskRef', taskId: 'task-1', field: 'section', by: 'name', expected: null },
		});
	});
});

describe('subtaskTitles', () => {
	it('recorta, tira las líneas vacías y conserva el orden', () => {
		expect(subtaskTitles(['  Harina ', '', '   ', 'Levadura'])).toEqual(['Harina', 'Levadura']);
	});

	it('corta en el tope de 50 subtareas', () => {
		const many = Array.from({ length: 60 }, (_, index) => `Paso ${index + 1}`);
		const titles = subtaskTitles(many);
		expect(titles).toHaveLength(MAX_SUBTASKS_PER_OP);
		expect(titles[0]).toBe('Paso 1');
		expect(titles[MAX_SUBTASKS_PER_OP - 1]).toBe('Paso 50');
	});

	it('las líneas vacías no gastan hueco del tope', () => {
		const mixed = Array.from({ length: 60 }, (_, index) => (index % 2 === 0 ? '' : `Paso ${index}`));
		// 30 títulos de verdad entre 60 líneas: caben todos.
		expect(subtaskTitles(mixed)).toHaveLength(30);
	});

	it('trunca un título de más de 500 caracteres al tope', () => {
		const long = 'a'.repeat(MAX_SUBTASK_LENGTH + 120);
		const titles = subtaskTitles([long]);
		expect(titles[0]).toHaveLength(MAX_SUBTASK_LENGTH);
	});
});

describe('addSubtasksOp', () => {
	it('manda los títulos ya limpios y espera LEER esos mismos', () => {
		expect(addSubtasksOp(task(), [' Harina ', 'Levadura'])).toEqual({
			action: 'añadir subtareas',
			op: { op: 'addSubtask', taskId: 'task-1', subtasks: ['Harina', 'Levadura'] },
			check: { check: 'subtasksInclude', parentId: 'task-1', titles: ['Harina', 'Levadura'] },
		});
	});

	it('con el tope de 50 pasado, op y check llevan los MISMOS 50', () => {
		const plan = addSubtasksOp(
			task(),
			Array.from({ length: 51 }, (_, index) => `Paso ${index + 1}`),
		);
		expect(plan).not.toBeNull();
		if (plan === null || plan.op.op !== 'addSubtask') throw new Error('plan inesperado');
		expect(plan.op.subtasks).toHaveLength(MAX_SUBTASKS_PER_OP);
		expect(plan.check).toEqual({
			check: 'subtasksInclude',
			parentId: 'task-1',
			titles: plan.op.subtasks,
		});
	});

	it('con un título de más de 500, el check espera el texto TRUNCADO', () => {
		// El servidor trunca lo que recibe: un check con el título entero no se
		// confirmaría nunca.
		const long = 'b'.repeat(MAX_SUBTASK_LENGTH + 1);
		const plan = addSubtasksOp(task(), [long]);
		if (plan === null || plan.op.op !== 'addSubtask') throw new Error('plan inesperado');
		const cut = long.slice(0, MAX_SUBTASK_LENGTH);
		expect(plan.op.subtasks).toEqual([cut]);
		expect(plan.check).toEqual({ check: 'subtasksInclude', parentId: 'task-1', titles: [cut] });
	});

	it('sin ningún título válido no hay plan: un addSubtask vacío no se podría confirmar', () => {
		expect(addSubtasksOp(task(), ['', '  ', '\t'])).toBeNull();
		expect(addSubtasksOp(task(), [])).toBeNull();
	});
});

describe('completeSubtaskOp', () => {
	const parent = task({
		id: 'parent-1',
		subtasks: [{ id: 'sub-7', content: 'Harina', done: false }],
	});
	const subtask = { id: 'sub-7', content: 'Harina', done: false };

	it('la op va contra el id de la SUBTAREA, y la relectura contra el del PADRE', () => {
		expect(completeSubtaskOp(parent, subtask, true)).toEqual({
			action: 'completar subtarea',
			op: { op: 'completeSubtask', subtaskId: 'sub-7', done: true },
			check: { check: 'subtaskDone', parentId: 'parent-1', subtaskId: 'sub-7', done: true },
		});
	});

	it('reabrir una subtarea es la misma op con done false', () => {
		expect(completeSubtaskOp(parent, { ...subtask, done: true }, false)).toEqual({
			action: 'reabrir subtarea',
			op: { op: 'completeSubtask', subtaskId: 'sub-7', done: false },
			check: { check: 'subtaskDone', parentId: 'parent-1', subtaskId: 'sub-7', done: false },
		});
	});

	it('el id del padre NUNCA viaja en la op: sería completar la tarea entera', () => {
		const plan = completeSubtaskOp(parent, subtask, true);
		expect(JSON.stringify(plan.op)).not.toContain('parent-1');
	});
});

describe('fechas locales', () => {
	it('localIsoDate da el día LOCAL, no el de UTC', () => {
		// Un 20 de septiembre a las 23:30 locales sigue siendo el día 20, aunque en
		// UTC ya sea el 21 en media Europa.
		expect(localIsoDate(new Date(2026, 8, 20, 23, 30))).toBe('2026-09-20');
	});

	it('isoDatePlusDays resuelve hoy y mañana, y cruza el fin de mes y de año', () => {
		const now = new Date(2026, 8, 18, 9, 0);
		expect(isoDatePlusDays(now, 0)).toBe('2026-09-18');
		expect(isoDatePlusDays(now, 1)).toBe('2026-09-19');
		expect(isoDatePlusDays(new Date(2026, 8, 30, 9, 0), 1)).toBe('2026-10-01');
		expect(isoDatePlusDays(new Date(2026, 11, 31, 9, 0), 1)).toBe('2027-01-01');
	});
});
