import { describe, expect, it } from 'vitest';

import type { LumbreTask } from '../lumbre/types';
import {
	UNDATED_NAME,
	UNLISTED_NAME,
	UNSECTIONED_NAME,
	groupByDate,
	groupByList,
	groupBySection,
	groupTasksForQuery,
} from './task-sections';

function task(overrides: Partial<LumbreTask> = {}): LumbreTask {
	return {
		id: overrides.id ?? 'a',
		content: `Tarea ${overrides.id ?? 'a'}`,
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
		section: null,
		rolloverCount: 0,
		parentId: null,
		...overrides,
	};
}

describe('groupBySection', () => {
	it('agrupa por sección conservando el orden de llegada', () => {
		const groups = groupBySection([
			task({ id: 'a', section: { id: 's1', name: 'Cocina' } }),
			task({ id: 'b', section: { id: 's2', name: 'Baño' } }),
			task({ id: 'c', section: { id: 's1', name: 'Cocina' } }),
		]);
		expect(groups.map((group) => group.name)).toEqual(['Cocina', 'Baño']);
		expect(groups[0]?.tasks.map((item) => item.id)).toEqual(['a', 'c']);
	});

	it('las tareas sin sección van juntas y primero', () => {
		const groups = groupBySection([
			task({ id: 'a', section: { id: 's1', name: 'Cocina' } }),
			task({ id: 'b', section: null }),
		]);
		expect(groups[0]?.name).toBe(UNSECTIONED_NAME);
		expect(groups[0]?.id).toBeNull();
	});

	it('sin tareas no inventa grupos', () => {
		expect(groupBySection([])).toEqual([]);
	});
});

describe('groupByList', () => {
	it('agrupa por lista conservando el orden de llegada', () => {
		const groups = groupByList([
			task({ id: 'a', list: { id: 'l1', name: 'Casa' } }),
			task({ id: 'b', list: { id: 'l2', name: 'Trabajo' } }),
			task({ id: 'c', list: { id: 'l1', name: 'Casa' } }),
		]);
		expect(groups.map((group) => group.name)).toEqual(['Casa', 'Trabajo']);
		expect(groups[0]?.tasks.map((item) => item.id)).toEqual(['a', 'c']);
	});

	it('las tareas sin lista van juntas y primero', () => {
		const groups = groupByList([
			task({ id: 'a', list: { id: 'l1', name: 'Casa' } }),
			task({ id: 'b', list: null }),
		]);
		expect(groups[0]?.name).toBe(UNLISTED_NAME);
		expect(groups[0]?.id).toBeNull();
	});
});

describe('groupByDate', () => {
	it('agrupa por fecha en orden CRONOLÓGICO, no de llegada', () => {
		const groups = groupByDate([
			task({ id: 'c', date: '2026-09-20' }),
			task({ id: 'a', date: '2026-09-10' }),
			task({ id: 'b', date: '2026-09-15' }),
		]);
		expect(groups.map((group) => group.name)).toEqual(['2026-09-10', '2026-09-15', '2026-09-20']);
	});

	it('las tareas sin fecha van AL FINAL, al revés que sección y lista', () => {
		const groups = groupByDate([
			task({ id: 'none', date: null }),
			task({ id: 'a', date: '2026-09-10' }),
		]);
		expect(groups.map((group) => group.name)).toEqual(['2026-09-10', UNDATED_NAME]);
		expect(groups[1]?.id).toBeNull();
	});

	it('agrupa varias tareas del mismo día juntas', () => {
		const groups = groupByDate([
			task({ id: 'a', date: '2026-09-10' }),
			task({ id: 'b', date: '2026-09-10' }),
		]);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.tasks.map((item) => item.id)).toEqual(['a', 'b']);
	});
});

describe('groupTasksForQuery', () => {
	const tasks = [
		task({ id: 'a', section: { id: 's1', name: 'Cocina' }, list: { id: 'l1', name: 'Casa' } }),
		task({ id: 'b', section: null, list: null }),
	];

	it('auto agrupa por sección cuando la consulta tiene lista (comportamiento de siempre)', () => {
		const groups = groupTasksForQuery(tasks, 'auto', true);
		expect(groups).not.toBeNull();
		expect(groups?.map((group) => group.name)).toEqual([UNSECTIONED_NAME, 'Cocina']);
	});

	it('auto NO agrupa (lista plana) cuando la consulta no tiene lista', () => {
		expect(groupTasksForQuery(tasks, 'auto', false)).toBeNull();
	});

	it('section fuerza la agrupación por sección aunque no haya list en la consulta', () => {
		const groups = groupTasksForQuery(tasks, 'section', false);
		expect(groups?.map((group) => group.name)).toEqual([UNSECTIONED_NAME, 'Cocina']);
	});

	it('list agrupa por lista', () => {
		const groups = groupTasksForQuery(tasks, 'list', true);
		expect(groups?.map((group) => group.name)).toEqual([UNLISTED_NAME, 'Casa']);
	});

	it('date agrupa por fecha', () => {
		const groups = groupTasksForQuery(
			[task({ id: 'a', date: '2026-09-10' }), task({ id: 'b', date: null })],
			'date',
			true,
		);
		expect(groups?.map((group) => group.name)).toEqual(['2026-09-10', UNDATED_NAME]);
	});

	it('none fuerza la lista plana aunque la consulta tenga list', () => {
		expect(groupTasksForQuery(tasks, 'none', true)).toBeNull();
	});
});
