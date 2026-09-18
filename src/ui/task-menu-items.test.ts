import { describe, expect, it } from 'vitest';

import type { LumbreTask } from '../lumbre/types';
import {
	isRecurringTask,
	sectionNamesFor,
	taskMenuItems,
	type TaskMenuItemKind,
} from './task-menu-items';

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

/** Los `kind` del menú, que es lo que importa del orden y de la presencia. */
function kinds(candidate: LumbreTask): TaskMenuItemKind[] {
	return taskMenuItems(candidate).map((item) => item.kind);
}

describe('taskMenuItems', () => {
	it('una tarea normal suelta trae fechas, cancelar, lista y añadir subtarea', () => {
		// Sin fecha no sale «Quitar la fecha»; sin lista, ni sección ni «Quitar de
		// la lista»; sin subtareas leídas, no sale «Completar una subtarea».
		expect(kinds(task())).toEqual([
			'rescheduleToday',
			'rescheduleTomorrow',
			'reschedulePick',
			'cancel',
			'moveToList',
			'addSubtask',
		]);
	});

	it('con fecha, lista, sección y subtareas salen TODAS las entradas', () => {
		const full = task({
			date: '2026-09-18',
			list: { id: 'list-1', name: 'Casa' },
			section: { id: 'sec-1', name: 'Cocina' },
			subtasks: [{ id: 'sub-1', content: 'Harina', done: false }],
		});
		expect(kinds(full)).toEqual([
			'rescheduleToday',
			'rescheduleTomorrow',
			'reschedulePick',
			'rescheduleClear',
			'cancel',
			'moveToList',
			'clearList',
			'setSection',
			'clearSection',
			'addSubtask',
			'completeSubtask',
		]);
	});

	it('sin lista no se ofrece mover de sección: una sección vive dentro de una lista', () => {
		expect(kinds(task({ list: null }))).not.toContain('setSection');
	});

	it('una SUBTAREA no ofrece lista, sección ni subtareas propias', () => {
		// `addSubtask` y `moveToList` sobre una subtarea son no-op MUDOS, y una
		// subtarea no tiene lista propia dentro de la que haya secciones.
		const sub = task({
			parentId: 'task-1',
			id: 'sub-1',
			date: '2026-09-18',
			list: { id: 'list-1', name: 'Casa' },
			section: { id: 'sec-1', name: 'Cocina' },
		});
		expect(kinds(sub)).toEqual([
			'rescheduleToday',
			'rescheduleTomorrow',
			'reschedulePick',
			'rescheduleClear',
			'cancel',
		]);
	});

	it('una CANCELADA solo ofrece restaurar', () => {
		const items = taskMenuItems(task({ cancelledAt: '2026-09-17T10:00:00Z', done: true }));
		expect(items.map((item) => item.kind)).toEqual(['restore']);
		expect(items[0]?.title).toBe('Restaurar la tarea');
	});

	it('una ARCHIVADA no lleva menú: no hay ninguna acción medida sobre ella', () => {
		// `addSubtask` sobre un padre archivado vuelve con `not-found`, y del resto
		// no hay medida: una entrada que no se sabe si hace algo no se ofrece.
		expect(taskMenuItems(task({ archivedAt: '2026-09-01T09:00:00Z' }))).toEqual([]);
	});

	it('una archivada Y cancelada tampoco lleva menú: archivada manda', () => {
		const both = task({ archivedAt: '2026-09-01T09:00:00Z', cancelledAt: '2026-09-02T09:00:00Z' });
		expect(taskMenuItems(both)).toEqual([]);
	});

	it('una RECURRENTE no ofrece reprogramar, porque movería la serie entera', () => {
		const recurring = task({ date: '2026-09-18', recurrence: { freq: 'weekly' } });
		expect(kinds(recurring)).toEqual(['cancel', 'moveToList', 'addSubtask']);
	});

	it('y tampoco si la recurrencia solo se ve por seriesId', () => {
		const recurring = task({ date: '2026-09-18', recurrence: null, seriesId: 'serie-1' });
		expect(kinds(recurring)).not.toContain('rescheduleToday');
	});

	it('sin recurrence ni seriesId (un Lumbre anterior) SÍ se puede reprogramar', () => {
		// Retirar la entrada contra un servidor que no informa la dejaría sin
		// reprogramar para todo el mundo.
		expect(kinds(task())).toContain('rescheduleToday');
	});

	it('una recurrente con recurrence null y seriesId null no es recurrente', () => {
		expect(isRecurringTask(task({ recurrence: null, seriesId: null }))).toBe(false);
		expect(isRecurringTask(task({ recurrence: { freq: 'daily' } }))).toBe(true);
		expect(isRecurringTask(task({ seriesId: 'serie-1' }))).toBe(true);
	});

	it('sin subtareas leídas no se ofrece completar una: el bloque solo las trae con context full', () => {
		expect(kinds(task({ subtasks: [] }))).not.toContain('completeSubtask');
		expect(kinds(task())).not.toContain('completeSubtask');
	});

	it('cada entrada trae texto en castellano y un icono, y solo cancelar es destructiva', () => {
		const items = taskMenuItems(
			task({ date: '2026-09-18', list: { id: 'list-1', name: 'Casa' } }),
		);
		for (const item of items) {
			expect(item.title.length).toBeGreaterThan(0);
			expect(item.icon.length).toBeGreaterThan(0);
		}
		const warnings = items.filter((item) => item.warning === true).map((item) => item.kind);
		expect(warnings).toEqual(['cancel']);
	});

	it('las entradas que abren un diálogo se marcan con puntos suspensivos', () => {
		const items = taskMenuItems(
			task({
				list: { id: 'list-1', name: 'Casa' },
				subtasks: [{ id: 'sub-1', content: 'Harina', done: false }],
			}),
		);
		const asks = new Set<TaskMenuItemKind>([
			'reschedulePick',
			'moveToList',
			'setSection',
			'addSubtask',
			'completeSubtask',
		]);
		for (const item of items) {
			expect(item.title.endsWith('…')).toBe(asks.has(item.kind));
		}
	});
});

describe('sectionNamesFor', () => {
	const casa = { id: 'list-1', name: 'Casa' };
	const trabajo = { id: 'list-2', name: 'Trabajo' };

	it('devuelve las secciones de ESA lista, sin repetidos y en el orden pintado', () => {
		const tasks = [
			task({ id: 'a', list: casa, section: { id: 's2', name: 'Cocina' } }),
			task({ id: 'b', list: casa, section: { id: 's1', name: 'Baño' } }),
			task({ id: 'c', list: casa, section: { id: 's2', name: 'Cocina' } }),
		];
		expect(sectionNamesFor(tasks, 'list-1')).toEqual(['Cocina', 'Baño']);
	});

	it('no mezcla secciones de otra lista, que no son destinos válidos', () => {
		const tasks = [
			task({ id: 'a', list: casa, section: { id: 's1', name: 'Cocina' } }),
			task({ id: 'b', list: trabajo, section: { id: 's9', name: 'Reuniones' } }),
		];
		expect(sectionNamesFor(tasks, 'list-1')).toEqual(['Cocina']);
	});

	it('las tareas sin sección no aportan nada, y sin lista no hay candidatas', () => {
		const tasks = [task({ id: 'a', list: casa, section: null })];
		expect(sectionNamesFor(tasks, 'list-1')).toEqual([]);
		expect(sectionNamesFor(tasks, null)).toEqual([]);
	});
});
