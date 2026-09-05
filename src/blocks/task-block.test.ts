import { beforeAll, describe, expect, it } from 'vitest';

import { Logger } from '../diagnostics/logger';
import type { LumbreResult } from '../lumbre/client';
import { ListCache } from '../lumbre/list-cache';
import type { LumbreTask } from '../lumbre/types';
import { FakeElement, installFakeGlobalDom } from '../test/fake-dom';
import { QueryCache } from './query-cache';
import { LumbreTaskBlock, type TaskBlockHost } from './task-block';

/**
 * Test de FORMA sobre el DOM del bloque, no de mecánica visual: se comprueba
 * que `context: full` no pinta ninguna casilla nueva (la de completar/reabrir
 * ya existía y sigue siendo la única) y que nada de esto toca el Markdown de
 * la nota (el bloque no importa nada de `vault`, ver el JSDoc del fichero).
 */

beforeAll(() => {
	installFakeGlobalDom();
});

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

/** Un `TaskBlockHost` mínimo: caché real con un cliente fijo, sin red. */
function host(tasks: LumbreTask[]): TaskBlockHost {
	const cache = new QueryCache({
		client: {
			listTasks: async (): Promise<LumbreResult<LumbreTask[]>> => ({ ok: true, value: tasks }),
		},
		now: () => 0,
	});
	const lists = new ListCache({
		client: { listLists: async () => ({ ok: true, value: [] }) },
	});
	return {
		cache,
		lists,
		queue: { pending: () => [] },
		setTaskDone: async () => undefined,
		noteListId: () => null,
		onDataChange: () => (): void => undefined,
		logger: Logger.create({ console: null }).child('block'),
	};
}

/** Monta el bloque, lo deja resolver su primera lectura y devuelve su raíz. */
async function mountBlock(source: string, tasks: LumbreTask[]): Promise<FakeElement> {
	const containerEl = new FakeElement('div');
	const block = new LumbreTaskBlock(
		containerEl as unknown as HTMLElement,
		source,
		'',
		host(tasks),
	);
	block.onload();
	// `onload` dispara `start()` sin esperarlo (la lectura de listas y de tareas
	// es async, encadenada varias veces): un `setTimeout` real drena TODA la cola
	// de microtareas antes de mirar el DOM, a diferencia de un `await
	// Promise.resolve()` suelto, que solo avanza un paso de la cadena.
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	return containerEl;
}

describe('LumbreTaskBlock, context: full', () => {
	it('sin context, no pinta ningún bloque de contexto bajo el título', async () => {
		const root = await mountBlock(
			'',
			[task({ notes: 'Una nota', subtasks: [{ id: 's1', content: 'Paso 1', done: false }] })],
		);
		expect(root.findAll((el) => el.hasClass('lumbre-task__context'))).toHaveLength(0);
	});

	it('una pendiente sin notas ni subtareas no pinta nada de contexto', async () => {
		const root = await mountBlock('context: full', [task()]);
		expect(root.findAll((el) => el.hasClass('lumbre-task__context'))).toHaveLength(0);
	});

	it('pinta el chip de estado de una completada, y NO lo pinta en una pendiente', async () => {
		const root = await mountBlock('context: full', [
			task({ id: 'a', done: true }),
			task({ id: 'b', done: false }),
		]);
		const chips = root.findAll((el) => el.hasClass('lumbre-task__state-chip'));
		expect(chips).toHaveLength(1);
		expect(chips[0]?.textContent).toBe('Completada');
	});

	it('el extracto de notas se pinta en texto plano, con textContent y no HTML', async () => {
		const root = await mountBlock('context: full', [task({ notes: 'Llamar antes de las 10' })]);
		const excerpts = root.findAll((el) => el.hasClass('lumbre-task__notes-excerpt'));
		expect(excerpts).toHaveLength(1);
		expect(excerpts[0]?.textContent).toBe('Llamar antes de las 10');
	});

	it('las subtareas se pintan SIN ninguna casilla: solo un carácter', async () => {
		const root = await mountBlock('context: full', [
			task({
				subtasks: [
					{ id: 's1', content: 'Comprar harina', done: true },
					{ id: 's2', content: 'Comprar levadura', done: false },
				],
			}),
		]);

		const subtaskRows = root.findAll((el) => el.hasClass('lumbre-task__subtask'));
		expect(subtaskRows).toHaveLength(2);

		const glyphs = root.findAll((el) => el.hasClass('lumbre-task__subtask-glyph'));
		expect(glyphs.map((el) => el.textContent)).toEqual(['✓', '○']);

		// Ninguna línea del bloque, con o sin contexto, es una casilla de Markdown:
		// la única casilla interactiva es la de completar/reabrir la tarea misma,
		// y esta tarea no está cancelada, así que hay exactamente una. Que además
		// no se toque el fichero de la nota lo garantiza la ESTRUCTURA del módulo
		// (`task-block.ts` no importa nada de `vault`, ver su JSDoc de cabecera),
		// no algo que dependa de la tarea concreta que se pinte aquí.
		const checkboxes = root.findAll((el) => el.tagName === 'INPUT' && el.type === 'checkbox');
		expect(checkboxes).toHaveLength(1);
	});
});
