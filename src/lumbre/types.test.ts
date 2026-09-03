import { describe, expect, it } from 'vitest';

import { listFromApi, taskFromApi } from './types';

describe('listFromApi', () => {
	it('lee los cuatro campos que Lumbre sirve desde 861cfb4d', () => {
		expect(
			listFromApi({
				id: 'list-1',
				name: 'Casa',
				icon: 'home',
				color: '#ff0000',
				parentListId: 'list-0',
				pinned: true,
				taskCount: 4,
			}),
		).toEqual({
			id: 'list-1',
			name: 'Casa',
			icon: 'home',
			color: '#ff0000',
			parentListId: 'list-0',
			pinned: true,
			taskCount: 4,
		});
	});

	it('contra un servidor anterior a ese SHA, los valores por defecto', () => {
		expect(listFromApi({ id: 'list-1', name: 'Casa', taskCount: 0 })).toEqual({
			id: 'list-1',
			name: 'Casa',
			icon: null,
			color: null,
			parentListId: null,
			pinned: false,
			taskCount: 0,
		});
	});

	it('pinned solo es true con el booleano, nunca con otra cosa', () => {
		expect(listFromApi({ id: 'l', name: 'L', pinned: 'true' })?.pinned).toBe(false);
		expect(listFromApi({ id: 'l', name: 'L', pinned: 1 })?.pinned).toBe(false);
	});

	it('sin id no es una lista', () => {
		expect(listFromApi({ name: 'Casa' })).toBeNull();
		expect(listFromApi(null)).toBeNull();
	});
});

describe('taskFromApi y los adjuntos', () => {
	it('cuenta los adjuntos cuando la respuesta trae el array', () => {
		const task = taskFromApi({
			id: 'task-1',
			content: 'Comprar pan',
			attachments: [{ id: 'a-1' }, { id: 'a-2' }],
		});

		expect(task?.attachmentCount).toBe(2);
	});

	it('un array vacío es cero adjuntos, que es un dato', () => {
		expect(taskFromApi({ id: 'task-1', content: 'x', attachments: [] })?.attachmentCount).toBe(0);
	});

	it('sin el campo NO se inventa un cero: el servidor no lo ha dicho', () => {
		const task = taskFromApi({ id: 'task-1', content: 'x' });

		expect(task?.attachmentCount).toBeUndefined();
		expect(task === null ? false : 'attachmentCount' in task).toBe(false);
	});
});
