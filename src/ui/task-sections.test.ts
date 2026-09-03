import { describe, expect, it } from 'vitest';

import type { LumbreTask } from '../lumbre/types';
import { UNSECTIONED_NAME, groupBySection } from './task-sections';

function task(id: string, section: LumbreTask['section']): LumbreTask {
	return {
		id,
		content: `Tarea ${id}`,
		notes: null,
		date: null,
		someday: false,
		deadline: null,
		time: null,
		priority: 'p4',
		done: false,
		cancelledAt: null,
		archivedAt: null,
		list: { id: 'list-1', name: 'Obra' },
		section,
		rolloverCount: 0,
		parentId: null,
	};
}

describe('groupBySection', () => {
	it('agrupa por sección conservando el orden de llegada', () => {
		const groups = groupBySection([
			task('a', { id: 's1', name: 'Cocina' }),
			task('b', { id: 's2', name: 'Baño' }),
			task('c', { id: 's1', name: 'Cocina' }),
		]);
		expect(groups.map((group) => group.name)).toEqual(['Cocina', 'Baño']);
		expect(groups[0]?.tasks.map((item) => item.id)).toEqual(['a', 'c']);
	});

	it('las tareas sin sección van juntas y primero', () => {
		const groups = groupBySection([task('a', { id: 's1', name: 'Cocina' }), task('b', null)]);
		expect(groups[0]?.name).toBe(UNSECTIONED_NAME);
		expect(groups[0]?.id).toBeNull();
	});

	it('sin tareas no inventa grupos', () => {
		expect(groupBySection([])).toEqual([]);
	});
});
