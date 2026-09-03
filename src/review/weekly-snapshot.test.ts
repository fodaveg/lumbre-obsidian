import { describe, expect, it } from 'vitest';

import type { ListTasksParams, LumbreResult } from '../lumbre/client';
import type { LumbreList, LumbreTask } from '../lumbre/types';
import {
	buildWeeklySnapshot,
	collectWeeklySnapshot,
	LIST_REQUEST_INTERVAL_MS,
	type WeeklySnapshotDeps,
} from './weekly-snapshot';

const NOW = new Date(2026, 8, 3, 12, 30);

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
		list: { id: 'list-1', name: 'Casa' },
		section: null,
		parentId: null,
		...overrides,
	};
}

function list(id: string, name: string): LumbreList {
	return { id, name, icon: null, color: null, parentListId: null, pinned: false, taskCount: 0 };
}

/** Lo que devuelve el cliente falso, un array por cada consulta que se le hace. */
interface FakeApi {
	overdue?: LumbreTask[];
	all?: LumbreTask[];
	someday?: LumbreTask[];
	lists?: LumbreList[];
	/** Tareas por NOMBRE de lista, para el apartado de listas sin próxima acción. */
	byList?: Record<string, LumbreTask[]>;
	/** Consultas que tienen que fallar, por el scope o por el nombre de la lista. */
	fails?: Record<string, 'network' | 'unauthorized'>;
}

function harness(api: FakeApi = {}): {
	deps: WeeklySnapshotDeps;
	calls: ListTasksParams[];
	waits: number[];
} {
	const calls: ListTasksParams[] = [];
	const waits: number[] = [];

	const deps: WeeklySnapshotDeps = {
		client: {
			listTasks: async (params: ListTasksParams = {}): Promise<LumbreResult<LumbreTask[]>> => {
				calls.push(params);
				const key = params.list ?? params.scope ?? 'today';
				const failure = api.fails?.[key];
				if (failure !== undefined) return { ok: false, reason: failure };
				if (params.list !== undefined) return { ok: true, value: api.byList?.[params.list] ?? [] };
				if (params.scope === 'overdue') return { ok: true, value: api.overdue ?? [] };
				if (params.scope === 'someday') return { ok: true, value: api.someday ?? [] };
				return { ok: true, value: api.all ?? [] };
			},
			listLists: async (): Promise<LumbreResult<LumbreList[]>> => {
				const failure = api.fails?.['lists'];
				if (failure !== undefined) return { ok: false, reason: failure };
				return { ok: true, value: api.lists ?? [] };
			},
		},
		wait: async (ms: number): Promise<void> => {
			waits.push(ms);
		},
	};

	return { deps, calls, waits };
}

/** El cuerpo de un apartado, por su encabezado. */
function section(markdown: string, title: string): string[] {
	const lines = markdown.split('\n');
	const start = lines.indexOf(`### ${title}`);
	expect(start).toBeGreaterThan(-1);
	const body: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (line.startsWith('### ')) break;
		if (line.length > 0) body.push(line);
	}
	return body;
}

describe('buildWeeklySnapshot: la cabecera', () => {
	it('fecha y hora de la foto, y dice que es texto de solo lectura', async () => {
		const { deps } = harness();

		const markdown = await buildWeeklySnapshot(deps, { now: NOW });

		expect(markdown.split('\n')[0]).toBe('## Foto del 2026-09-03 a las 12:30');
		expect(markdown).toContain('Las tareas viven en Lumbre.');
	});
});

describe('buildWeeklySnapshot: vencidas y arrastradas', () => {
	it('junta lo vencido con lo que lleva rodando, sin repetir', async () => {
		const { deps } = harness({
			overdue: [task({ id: 'a', content: 'Llamar al banco', date: '2026-08-30' })],
			all: [
				task({ id: 'a', content: 'Llamar al banco', date: '2026-08-30', rolloverCount: 7 }),
				task({ id: 'b', content: 'Pedir cita', date: '2026-09-04', rolloverCount: 4 }),
				task({ id: 'c', content: 'Regar', date: '2026-09-04', rolloverCount: 1 }),
			],
		});

		const body = section(await buildWeeklySnapshot(deps, { now: NOW }), 'Vencidas y arrastradas');

		expect(body).toEqual([
			'- Llamar al banco · Casa · 2026-08-30 · [Abrir](lumbre://tarea/a)',
			'- Pedir cita · Casa · 2026-09-04 · arrastrada 4 veces · [Abrir](lumbre://tarea/b)',
		]);
	});

	it('sin vencidas ni arrastradas, el apartado dice Nada', async () => {
		const { deps } = harness({ all: [task({ rolloverCount: 0 })] });

		const body = section(await buildWeeklySnapshot(deps, { now: NOW }), 'Vencidas y arrastradas');

		expect(body).toEqual(['Nada']);
	});

	it('si NINGUNA tarea trae rolloverCount, lo dice en vez de contar cero', async () => {
		// Un Lumbre anterior al SHA 861cfb4d no serializa el campo: la fila cruda no
		// lo trae y `taskFromApi` lo deja AUSENTE, que es lo que se mira aquí.
		const { deps } = harness({ all: [task({ id: 'a' }), task({ id: 'b' })] });

		const body = section(await buildWeeklySnapshot(deps, { now: NOW }), 'Vencidas y arrastradas');

		expect(body).toEqual(['Arrastradas: este Lumbre no lo informa.']);
	});

	it('un cero PRESENTE sí es un dato: no sale el aviso', async () => {
		const { deps } = harness({ all: [task({ id: 'a', rolloverCount: 0 })] });

		const body = section(await buildWeeklySnapshot(deps, { now: NOW }), 'Vencidas y arrastradas');

		expect(body).toEqual(['Nada']);
	});

	it('el apartado que no se puede leer lo dice y cuenta como fallo', async () => {
		const { deps } = harness({ fails: { overdue: 'network' } });

		const snapshot = await collectWeeklySnapshot(deps, { now: NOW });

		expect(section(snapshot.markdown, 'Vencidas y arrastradas')).toEqual([
			'No se han podido leer las vencidas: No se pudo conectar con Lumbre.',
		]);
		expect(snapshot.failures).toBe(1);
		expect(snapshot.sections).toBe(3);
	});
});

describe('buildWeeklySnapshot: listas sin próxima acción', () => {
	it('solo las listas con pendientes y NINGUNA con fecha', async () => {
		const { deps, calls } = harness({
			lists: [list('l1', 'Casa'), list('l2', 'Trabajo'), list('l3', 'Vacía')],
			byList: {
				Casa: [task({ id: 'a' }), task({ id: 'b' })],
				Trabajo: [task({ id: 'c' }), task({ id: 'd', date: '2026-09-10' })],
				Vacía: [],
			},
		});

		const body = section(await buildWeeklySnapshot(deps, { now: NOW }), 'Listas sin próxima acción');

		expect(body).toEqual(['- Casa · 2 pendientes']);
		expect(calls.filter((params) => params.list !== undefined)).toEqual([
			{ list: 'Casa', scope: 'all', notes: 'none', limit: 500 },
			{ list: 'Trabajo', scope: 'all', notes: 'none', limit: 500 },
			{ list: 'Vacía', scope: 'all', notes: 'none', limit: 500 },
		]);
	});

	it('las completadas y canceladas no cuentan como pendientes', async () => {
		const { deps } = harness({
			lists: [list('l1', 'Casa')],
			byList: {
				Casa: [
					task({ id: 'a', done: true }),
					task({ id: 'b', done: true, cancelledAt: '2026-09-01T10:00:00.000Z' }),
					task({ id: 'c' }),
				],
			},
		});

		const body = section(await buildWeeklySnapshot(deps, { now: NOW }), 'Listas sin próxima acción');

		expect(body).toEqual(['- Casa · 1 pendiente']);
	});

	it('una petición por lista, en serie y con intervalo entre medias', async () => {
		const { deps, waits } = harness({
			lists: [list('l1', 'Casa'), list('l2', 'Trabajo'), list('l3', 'Ocio')],
		});

		await buildWeeklySnapshot(deps, { now: NOW });

		// Tres listas, dos esperas: la primera petición no espera a nada.
		expect(waits).toEqual([LIST_REQUEST_INTERVAL_MS, LIST_REQUEST_INTERVAL_MS]);
	});

	it('una lista que no se puede leer se nombra, y las demás siguen', async () => {
		const { deps } = harness({
			lists: [list('l1', 'Casa'), list('l2', 'Trabajo')],
			byList: { Trabajo: [task({ id: 'c' })] },
			fails: { Casa: 'network' },
		});

		const body = section(await buildWeeklySnapshot(deps, { now: NOW }), 'Listas sin próxima acción');

		expect(body).toEqual(['- Trabajo · 1 pendiente', 'No se han podido leer: Casa.']);
	});

	it('sin listas, el apartado dice Nada', async () => {
		const { deps } = harness();

		const body = section(await buildWeeklySnapshot(deps, { now: NOW }), 'Listas sin próxima acción');

		expect(body).toEqual(['Nada']);
	});
});

describe('buildWeeklySnapshot: muestra de Algún día', () => {
	const someday = Array.from({ length: 20 }, (_, index) =>
		task({ id: `s-${index}`, content: `Idea ${index}`, someday: true, list: null }),
	);

	it('coge cinco y las enseña con su enlace', async () => {
		const { deps } = harness({ someday });

		const body = section(await buildWeeklySnapshot(deps, { now: NOW }), 'Muestra de Algún día');

		expect(body).toHaveLength(5);
		for (const line of body) {
			expect(line).toMatch(/^- Idea \d+ · sin lista · Algún día · \[Abrir]\(lumbre:\/\/tarea\/s-\d+\)$/);
		}
	});

	it('la misma semilla da la MISMA muestra, y otra semilla da otra', async () => {
		const { deps } = harness({ someday });
		const title = 'Muestra de Algún día';

		const hoy = section(await buildWeeklySnapshot(deps, { now: NOW }), title);
		const otraVez = section(await buildWeeklySnapshot(deps, { now: NOW }), title);
		const manana = section(
			await buildWeeklySnapshot(deps, { now: new Date(2026, 8, 4, 9, 0) }),
			title,
		);

		expect(otraVez).toEqual(hoy);
		expect(manana).not.toEqual(hoy);
	});

	it('la hora NO entra en la semilla: dos fotos del mismo día coinciden', async () => {
		const { deps } = harness({ someday });
		const title = 'Muestra de Algún día';

		const manana = section(await buildWeeklySnapshot(deps, { now: new Date(2026, 8, 3, 8, 5) }), title);
		const tarde = section(await buildWeeklySnapshot(deps, { now: new Date(2026, 8, 3, 20, 45) }), title);

		expect(tarde).toEqual(manana);
	});

	it('con menos de cinco las enseña todas; sin ninguna dice Nada', async () => {
		const pocas = harness({ someday: someday.slice(0, 2) });
		const ninguna = harness();
		const title = 'Muestra de Algún día';

		expect(section(await buildWeeklySnapshot(pocas.deps, { now: NOW }), title)).toHaveLength(2);
		expect(section(await buildWeeklySnapshot(ninguna.deps, { now: NOW }), title)).toEqual(['Nada']);
	});
});

describe('buildWeeklySnapshot: la forma de la salida', () => {
	it('NINGUNA línea es una casilla de Markdown', async () => {
		const { deps } = harness({
			overdue: [
				task({ id: 'a', content: '[ ] Comprar pan', date: '2026-08-30' }),
				task({ id: 'b', content: '- [x] Ya está', date: '2026-08-30' }),
			],
			all: [task({ id: 'a', rolloverCount: 5 })],
			lists: [list('l1', 'Casa')],
			byList: { Casa: [task({ id: 'c' })] },
			someday: [task({ id: 's', content: '[X] Aprender ruso', someday: true })],
		});

		const markdown = await buildWeeklySnapshot(deps, { now: NOW });

		for (const line of markdown.split('\n')) {
			expect(line).not.toMatch(/^- \[[ xX]]/);
		}
		expect(markdown).toContain('- Comprar pan · Casa · 2026-08-30');
		expect(markdown).toContain('- Ya está · Casa · 2026-08-30');
		expect(markdown).toContain('- Aprender ruso · Casa · Algún día');
	});

	it('un título de varias líneas se aplana en una', async () => {
		const { deps } = harness({
			overdue: [task({ id: 'a', content: 'Llamar\nal banco', date: '2026-08-30' })],
		});

		const body = section(await buildWeeklySnapshot(deps, { now: NOW }), 'Vencidas y arrastradas');

		expect(body).toEqual(['- Llamar al banco · Casa · 2026-08-30 · [Abrir](lumbre://tarea/a)']);
	});

	it('con todo en rojo lo dice y no se inventa nada', async () => {
		const { deps } = harness({
			fails: { overdue: 'unauthorized', lists: 'unauthorized', someday: 'unauthorized' },
		});

		const snapshot = await collectWeeklySnapshot(deps, { now: NOW });

		expect(snapshot.failures).toBe(snapshot.sections);
		expect(snapshot.markdown).not.toContain('[Abrir]');
	});
});
