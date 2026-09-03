import { describe, expect, it } from 'vitest';

import type { LumbreTask } from '../lumbre/types';
import { taskStateLabels } from './task-state-labels';

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
		rolloverCount: 0,
		parentId: null,
		...overrides,
	};
}

describe('taskStateLabels', () => {
	it('una tarea viva no lleva ninguna etiqueta de estado', () => {
		expect(taskStateLabels(task())).toEqual([]);
	});

	it('una ARCHIVADA se dice, que no es un error ni una tarea perdida', () => {
		expect(taskStateLabels(task({ archivedAt: '2026-09-01T10:00:00.000Z' }))).toEqual([
			'Archivada',
		]);
	});

	it('una cancelada se dice, y una cancelada Y archivada dice las dos cosas', () => {
		expect(taskStateLabels(task({ cancelledAt: '2026-09-01T10:00:00.000Z' }))).toEqual([
			'Cancelada',
		]);
		expect(
			taskStateLabels(
				task({ cancelledAt: '2026-09-01T10:00:00.000Z', archivedAt: '2026-09-02T10:00:00.000Z' }),
			),
		).toEqual(['Cancelada', 'Archivada']);
	});
});
