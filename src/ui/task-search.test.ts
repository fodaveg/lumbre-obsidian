import { describe, expect, it, vi } from 'vitest';

import {
	MAX_TASKS_LIMIT,
	type ListTasksParams,
	type LumbreResult,
} from '../lumbre/client';
import type { LumbreTask } from '../lumbre/types';
import { searchTasks } from './task-search';

function task(id: string, content: string): LumbreTask {
	return {
		id,
		content,
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
	};
}

/** Cliente que devuelve N tareas y guarda con qué parámetros se le llamó. */
function clientWith(tasks: LumbreTask[]) {
	return {
		listTasks: vi.fn(
			async (_params?: ListTasksParams): Promise<LumbreResult<LumbreTask[]>> => ({
				ok: true,
				value: tasks,
			}),
		),
	};
}

describe('searchTasks', () => {
	it('pide el TOPE del servidor: el filtro por texto es de cliente', async () => {
		const client = clientWith([task('1', 'Comprar pan')]);

		await searchTasks(client, 'pan', 50);

		expect(client.listTasks).toHaveBeenCalledWith(
			expect.objectContaining({ limit: MAX_TASKS_LIMIT, scope: 'all', notes: 'none' }),
		);
	});

	it('dice que la lectura es PARCIAL cuando llega al tope', async () => {
		const many = Array.from({ length: MAX_TASKS_LIMIT }, (_unused, index) =>
			task(String(index), `Comprar pan ${index}`),
		);
		const read = await searchTasks(clientWith(many), 'pan', 50);

		expect(read.ok).toBe(true);
		if (!read.ok) return;
		expect(read.value.scanned).toBe(MAX_TASKS_LIMIT);
		expect(read.value.partial).toBe(true);
		expect(read.value.tasks).toHaveLength(50);
	});

	it('una lectura que no llega al tope no es parcial', async () => {
		const read = await searchTasks(clientWith([task('1', 'Comprar pan')]), 'pan', 50);

		expect(read.ok).toBe(true);
		if (!read.ok) return;
		expect(read.value.partial).toBe(false);
		expect(read.value.tasks).toHaveLength(1);
	});

	it('el fallo de la lectura sale tal cual, para que el panel lo cuente', async () => {
		const client = {
			listTasks: vi.fn(
				async (): Promise<LumbreResult<LumbreTask[]>> => ({ ok: false, reason: 'unauthorized', status: 401 }),
			),
		};

		const read = await searchTasks(client, 'pan', 50);

		expect(read).toEqual({ ok: false, reason: 'unauthorized', status: 401 });
	});
});
