import { describe, expect, it } from 'vitest';

import { MAX_TASKS_LIMIT } from '../lumbre/client';
import type { LumbreTask } from '../lumbre/types';
import {
	applyClientFilters,
	describeQuery,
	parseQuery,
	queryKey,
	queryParams,
	resolveQuery,
	type ParsedQuery,
	type QueryContext,
} from './query-parser';

/** La consulta parseada, o el fallo del test si no parsea. */
function parsed(source: string): ParsedQuery {
	const result = parseQuery(source);
	if (!result.ok) throw new Error(`No debía fallar: ${result.error}`);
	return result.query;
}

/** El error de una consulta que NO debe parsear. */
function errorOf(source: string): string {
	const result = parseQuery(source);
	if (result.ok) throw new Error('Debía fallar y no ha fallado.');
	return result.error;
}

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

/** Contexto sin nota vinculada y sin catálogo de listas. */
const BARE: QueryContext = { noteListId: null, resolveList: () => null };

describe('parseQuery', () => {
	it('una consulta vacía es lo de hoy, y sin scope explícito', () => {
		const query = parsed('');
		expect(query.scope).toBe('today');
		expect(query.scopeExplicit).toBe(false);
		expect(query.list).toBeNull();
		expect(query.priority).toBeNull();
		expect(query.deadline).toBeNull();
		expect(query.sort).toBeNull();
		expect(query.group).toBe('auto');
	});

	it('las líneas en blanco y los espacios de sobra no cuentan', () => {
		expect(parsed('\n   \n  scope:   week   \n\n').scope).toBe('week');
	});

	it('lee todas las claves', () => {
		const query = parsed(
			[
				'scope: upcoming',
				'days: 7',
				'list: Casa',
				'section: Cocina',
				'tag: #compras',
				'priority: p1,p2',
				'deadline: 7d',
				'includeDone: true',
				'limit: 20',
				'notes: full',
				'context: full',
				'sort: deadline-desc',
				'group: list',
				'title: Lo que viene',
			].join('\n'),
		);

		expect(query).toEqual({
			scope: 'upcoming',
			scopeExplicit: true,
			days: 7,
			list: 'Casa',
			section: 'Cocina',
			tag: 'compras',
			priority: ['p1', 'p2'],
			deadline: { kind: 'window', days: 7 },
			includeDone: true,
			limit: 20,
			notes: 'full',
			notesExplicit: true,
			context: 'full',
			sort: { field: 'deadline', direction: 'desc' },
			group: 'list',
			title: 'Lo que viene',
		});
	});

	it('context acepta none y full', () => {
		expect(parsed('context: none').context).toBe('none');
		expect(parsed('context: full').context).toBe('full');
	});

	it('rechaza un context que no existe', () => {
		expect(errorOf('context: parcial')).toContain('context');
	});

	it('notesExplicit distingue "no dije nada" de "dije notes: none"', () => {
		expect(parsed('').notesExplicit).toBe(false);
		expect(parsed('notes: none').notesExplicit).toBe(true);
	});

	it('acepta los siete scopes', () => {
		for (const scope of ['today', 'week', 'upcoming', 'inbox', 'someday', 'overdue', 'all']) {
			expect(parsed(`scope: ${scope}`).scope).toBe(scope);
		}
	});

	it('la clave es tolerante con mayúsculas, guiones y guiones bajos', () => {
		expect(parsed('Include-Done: true').includeDone).toBe(true);
		expect(parsed('include_done: yes').includeDone).toBe(true);
		expect(parsed('INCLUDEDONE: sí').includeDone).toBe(true);
		expect(parsed('includeDone: no').includeDone).toBe(false);
		expect(parsed('includeDone: 0').includeDone).toBe(false);
	});

	it('quita las comillas de alrededor del valor', () => {
		expect(parsed('title: "Lo de hoy"').title).toBe('Lo de hoy');
		expect(parsed("list: 'Casa y jardín'").list).toBe('Casa y jardín');
	});

	it('el valor puede llevar dos puntos dentro', () => {
		expect(parsed('title: Hoy: lo urgente').title).toBe('Hoy: lo urgente');
	});

	it('la última repetición de una clave gana', () => {
		expect(parsed('scope: week\nscope: inbox').scope).toBe('inbox');
	});

	it('la etiqueta vale con almohadilla y sin ella', () => {
		expect(parsed('tag: casa').tag).toBe('casa');
		expect(parsed('tag: #casa').tag).toBe('casa');
	});

	it('rechaza una línea que no tiene la forma clave: valor', () => {
		expect(errorOf('scope today')).toContain('clave: valor');
	});

	it('rechaza una clave que no existe', () => {
		expect(errorOf('scopes: today')).toContain('scopes');
	});

	it('rechaza una clave sin valor', () => {
		expect(errorOf('list:')).toContain('sin valor');
	});

	it('rechaza un scope que no existe y dice cuáles hay', () => {
		const error = errorOf('scope: mañana');
		expect(error).toContain('mañana');
		expect(error).toContain('today');
	});

	it('rechaza days, limit y includeDone con valores que no valen', () => {
		expect(errorOf('scope: upcoming\ndays: siete')).toContain('days');
		expect(errorOf('scope: upcoming\ndays: 0')).toContain('days');
		expect(errorOf('limit: -3')).toContain('limit');
		expect(errorOf('includeDone: quizá')).toContain('includeDone');
	});

	it('rechaza days si el scope no es upcoming, escriba en el orden que escriba', () => {
		expect(errorOf('days: 7')).toContain('upcoming');
		expect(errorOf('days: 7\nscope: week')).toContain('upcoming');
		expect(parsed('days: 7\nscope: upcoming').days).toBe(7);
	});
});

describe('parseQuery · priority', () => {
	it('acepta un valor y varios separados por coma', () => {
		expect(parsed('priority: p1').priority).toEqual(['p1']);
		expect(parsed('priority: p1,p2,p3').priority).toEqual(['p1', 'p2', 'p3']);
	});

	it('ignora mayúsculas y espacios alrededor de la coma', () => {
		expect(parsed('priority: P1, p2').priority).toEqual(['p1', 'p2']);
	});

	it('descarta repetidos', () => {
		expect(parsed('priority: p1,p1,p2').priority).toEqual(['p1', 'p2']);
	});

	it('rechaza un nivel que no existe', () => {
		expect(errorOf('priority: p5')).toContain('priority');
		expect(errorOf('priority: urgente')).toContain('priority');
	});

	it('rechaza una lista vacía o con huecos', () => {
		expect(errorOf('priority: p1,,p2')).toContain('priority');
	});
});

describe('parseQuery · deadline', () => {
	it('acepta hoy, vencido, ninguno y una ventana de días', () => {
		expect(parsed('deadline: hoy').deadline).toEqual({ kind: 'today' });
		expect(parsed('deadline: vencido').deadline).toEqual({ kind: 'overdue' });
		expect(parsed('deadline: ninguno').deadline).toEqual({ kind: 'none' });
		expect(parsed('deadline: 7d').deadline).toEqual({ kind: 'window', days: 7 });
	});

	it('es insensible a mayúsculas', () => {
		expect(parsed('deadline: HOY').deadline).toEqual({ kind: 'today' });
	});

	it('rechaza una ventana de cero o negativa, y basura', () => {
		expect(errorOf('deadline: 0d')).toContain('deadline');
		expect(errorOf('deadline: manana')).toContain('deadline');
		expect(errorOf('deadline: 7')).toContain('deadline');
	});
});

describe('parseQuery · sort', () => {
	it('acepta los tres campos, con y sin -desc, y server', () => {
		expect(parsed('sort: date').sort).toEqual({ field: 'date', direction: 'asc' });
		expect(parsed('sort: date-desc').sort).toEqual({ field: 'date', direction: 'desc' });
		expect(parsed('sort: deadline').sort).toEqual({ field: 'deadline', direction: 'asc' });
		expect(parsed('sort: deadline-desc').sort).toEqual({ field: 'deadline', direction: 'desc' });
		expect(parsed('sort: priority').sort).toEqual({ field: 'priority', direction: 'asc' });
		expect(parsed('sort: priority-desc').sort).toEqual({ field: 'priority', direction: 'desc' });
		expect(parsed('sort: server').sort).toBeNull();
	});

	it('sin escribir sort, el valor es null (orden del servidor)', () => {
		expect(parsed('').sort).toBeNull();
	});

	it('rechaza un campo que no existe', () => {
		expect(errorOf('sort: title')).toContain('sort');
		expect(errorOf('sort: date-asc')).toContain('sort');
	});
});

describe('parseQuery · group', () => {
	it('acepta section, list, date y none', () => {
		expect(parsed('group: section').group).toBe('section');
		expect(parsed('group: list').group).toBe('list');
		expect(parsed('group: date').group).toBe('date');
		expect(parsed('group: none').group).toBe('none');
	});

	it('sin escribir group, el valor es auto', () => {
		expect(parsed('').group).toBe('auto');
	});

	it('rechaza un valor que no existe, incluido "auto" (no es escribible a mano)', () => {
		expect(errorOf('group: auto')).toContain('group');
		expect(errorOf('group: whatever')).toContain('group');
	});
});

describe('resolveQuery', () => {
	it('sin lista y sin nota vinculada, manda el scope escrito', () => {
		expect(resolveQuery(parsed('scope: week'), BARE).scope).toBe('week');
		expect(resolveQuery(parsed('scope: week'), BARE).list).toBeNull();
	});

	it('nombrar una lista sin scope significa la lista entera', () => {
		const query = resolveQuery(parsed('list: Casa'), BARE);
		expect(query.scope).toBe('all');
		expect(query.list).toBe('Casa');
	});

	it('con lista y scope escrito, el scope escrito manda', () => {
		expect(resolveQuery(parsed('list: Casa\nscope: today'), BARE).scope).toBe('today');
	});

	it('traduce el id de lista a su nombre, que es lo que filtra la API', () => {
		const context: QueryContext = {
			noteListId: null,
			resolveList: (raw) => (raw === 'lista-1' ? 'Casa' : null),
		};
		expect(resolveQuery(parsed('list: lista-1'), context).list).toBe('Casa');
	});

	it('sin lista y sin scope, la nota con lumbre-list manda toda su lista', () => {
		const context: QueryContext = {
			noteListId: 'lista-1',
			resolveList: (raw) => (raw === 'lista-1' ? 'Casa' : null),
		};
		const query = resolveQuery(parsed(''), context);
		expect(query.scope).toBe('all');
		expect(query.list).toBe('Casa');
	});

	it('un scope escrito gana sobre el lumbre-list de la nota', () => {
		const context: QueryContext = { noteListId: 'lista-1', resolveList: () => 'Casa' };
		const query = resolveQuery(parsed('scope: today'), context);
		expect(query.scope).toBe('today');
		expect(query.list).toBeNull();
	});

	it('si la lista no se puede traducir, se manda tal cual', () => {
		expect(resolveQuery(parsed('list: Lo que sea'), BARE).list).toBe('Lo que sea');
	});

	it('priority, deadline, sort y group llegan igual a la consulta resuelta', () => {
		const query = resolveQuery(
			parsed('priority: p1\ndeadline: hoy\nsort: date-desc\ngroup: list'),
			BARE,
		);
		expect(query.priority).toEqual(['p1']);
		expect(query.deadline).toEqual({ kind: 'today' });
		expect(query.sort).toEqual({ field: 'date', direction: 'desc' });
		expect(query.group).toBe('list');
	});
});

describe('queryParams', () => {
	it('no pide las notas de las tareas salvo que la consulta lo diga', () => {
		expect(queryParams(resolveQuery(parsed(''), BARE)).notes).toBe('none');
	});

	it('con «notes: full» sí las pide', () => {
		expect(queryParams(resolveQuery(parsed('notes: full'), BARE)).notes).toBe('full');
	});

	it('manda limit al servidor cuando no hay filtro por etiqueta', () => {
		expect(queryParams(resolveQuery(parsed('limit: 5'), BARE)).limit).toBe(5);
	});

	it('con etiqueta manda el TOPE del servidor: el filtro es en cliente', () => {
		expect(queryParams(resolveQuery(parsed('limit: 5\ntag: casa'), BARE)).limit).toBe(
			MAX_TASKS_LIMIT,
		);
	});

	it('con priority manda el TOPE, no el limit escrito', () => {
		expect(queryParams(resolveQuery(parsed('limit: 5\npriority: p1'), BARE)).limit).toBe(
			MAX_TASKS_LIMIT,
		);
	});

	it('con deadline manda el TOPE, no el limit escrito', () => {
		expect(queryParams(resolveQuery(parsed('limit: 5\ndeadline: hoy'), BARE)).limit).toBe(
			MAX_TASKS_LIMIT,
		);
	});

	it('con sort manda el TOPE, no el limit escrito', () => {
		expect(queryParams(resolveQuery(parsed('limit: 5\nsort: date'), BARE)).limit).toBe(
			MAX_TASKS_LIMIT,
		);
	});

	it('sort: server no fuerza el tope: no es un sort de cliente', () => {
		expect(queryParams(resolveQuery(parsed('limit: 5\nsort: server'), BARE)).limit).toBe(5);
	});

	it('group NO fuerza el tope: no cambia qué se pide, solo cómo se pinta', () => {
		expect(queryParams(resolveQuery(parsed('limit: 5\ngroup: list'), BARE)).limit).toBe(5);
	});

	it('sin limit escrito pide el tope, no el default de 200 del servidor', () => {
		expect(queryParams(resolveQuery(parsed(''), BARE)).limit).toBe(MAX_TASKS_LIMIT);
	});

	it('un limit por encima del tope se recorta al tope', () => {
		expect(queryParams(resolveQuery(parsed('limit: 9000'), BARE)).limit).toBe(MAX_TASKS_LIMIT);
	});

	it('context: full pide las notas enteras aunque no se escriba notes', () => {
		expect(queryParams(resolveQuery(parsed('context: full'), BARE)).notes).toBe('full');
	});

	it('context: full pisa un notes: none escrito a propósito', () => {
		expect(queryParams(resolveQuery(parsed('notes: none\ncontext: full'), BARE)).notes).toBe(
			'full',
		);
	});
});

describe('queryKey', () => {
	it('dos consultas que piden lo mismo comparten clave aunque cambie el título', () => {
		expect(queryKey(resolveQuery(parsed('title: Uno'), BARE))).toBe(
			queryKey(resolveQuery(parsed('title: Otro'), BARE)),
		);
	});

	it('consultas distintas tienen claves distintas', () => {
		expect(queryKey(resolveQuery(parsed('scope: week'), BARE))).not.toBe(
			queryKey(resolveQuery(parsed('scope: today'), BARE)),
		);
	});

	it('pedir las notas es OTRA consulta: no comparte entrada de caché', () => {
		expect(queryKey(resolveQuery(parsed('notes: full'), BARE))).not.toBe(
			queryKey(resolveQuery(parsed(''), BARE)),
		);
	});

	it('context: full es OTRA consulta aunque pida lo MISMO al servidor', () => {
		// `notes: full` a secas y `context: full` piden idéntico `queryParams`
		// (las dos fuerzan `notes: full`), pero una dispara peticiones de
		// subtareas y la otra no: no pueden compartir entrada.
		expect(queryKey(resolveQuery(parsed('context: full'), BARE))).not.toBe(
			queryKey(resolveQuery(parsed('notes: full'), BARE)),
		);
	});

	it('priority no cambia la clave: es un filtro de cliente', () => {
		expect(queryKey(resolveQuery(parsed('priority: p1'), BARE))).toBe(
			queryKey(resolveQuery(parsed(''), BARE)),
		);
	});

	it('deadline no cambia la clave: es un filtro de cliente', () => {
		expect(queryKey(resolveQuery(parsed('deadline: hoy'), BARE))).toBe(
			queryKey(resolveQuery(parsed(''), BARE)),
		);
	});

	it('sort no cambia la clave: es de cliente', () => {
		expect(queryKey(resolveQuery(parsed('sort: date-desc'), BARE))).toBe(
			queryKey(resolveQuery(parsed(''), BARE)),
		);
	});

	it('group no cambia la clave: solo decide cómo se pinta', () => {
		expect(queryKey(resolveQuery(parsed('group: list'), BARE))).toBe(
			queryKey(resolveQuery(parsed(''), BARE)),
		);
	});
});

describe('applyClientFilters · tag (effectiveTags)', () => {
	const tasks = [
		task({ id: '1', effectiveTags: ['casa'] }),
		task({ id: '2', effectiveTags: ['casa/cocina'] }),
		task({ id: '3', effectiveTags: ['trabajo'] }),
		task({ id: '4', effectiveTags: [] }),
		// effectiveTags AUSENTE a propósito: simula un Lumbre anterior a `106d124f3`.
		task({ id: '5' }),
	];

	it('sin filtros devuelve todo', () => {
		expect(applyClientFilters(tasks, resolveQuery(parsed(''), BARE))).toHaveLength(5);
	});

	it('filtra por effectiveTags, y la etiqueta padre casa con la hija', () => {
		const filtered = applyClientFilters(tasks, resolveQuery(parsed('tag: casa'), BARE));
		expect(filtered.map((item) => item.id)).toEqual(['1', '2']);
	});

	it('la etiqueta no casa a medias', () => {
		const filtered = applyClientFilters(tasks, resolveQuery(parsed('tag: cas'), BARE));
		expect(filtered).toHaveLength(0);
	});

	it('effectiveTags vacío es un dato: no casa, pero es distinto de ausente', () => {
		const filtered = applyClientFilters(tasks, resolveQuery(parsed('tag: trabajo'), BARE));
		expect(filtered.map((item) => item.id)).toEqual(['3']);
	});

	it('una tarea sin effectiveTags (Lumbre viejo) no casa con ningún tag: fail-closed', () => {
		const filtered = applyClientFilters(tasks, resolveQuery(parsed('tag: casa'), BARE));
		expect(filtered.map((item) => item.id)).not.toContain('5');
	});

	it('el tope se aplica después de filtrar por etiqueta', () => {
		const filtered = applyClientFilters(tasks, resolveQuery(parsed('tag: casa\nlimit: 1'), BARE));
		expect(filtered.map((item) => item.id)).toEqual(['1']);
	});
});

describe('applyClientFilters · priority', () => {
	const tasks = [
		task({ id: '1', priority: 'p1' }),
		task({ id: '2', priority: 'p2' }),
		task({ id: '3', priority: 'p3' }),
		task({ id: '4', priority: 'p4' }),
	];

	it('sin priority devuelve todo', () => {
		expect(applyClientFilters(tasks, resolveQuery(parsed(''), BARE))).toHaveLength(4);
	});

	it('filtra por una sola prioridad', () => {
		const filtered = applyClientFilters(tasks, resolveQuery(parsed('priority: p1'), BARE));
		expect(filtered.map((item) => item.id)).toEqual(['1']);
	});

	it('filtra por varias prioridades separadas por coma', () => {
		const filtered = applyClientFilters(tasks, resolveQuery(parsed('priority: p1,p3'), BARE));
		expect(filtered.map((item) => item.id)).toEqual(['1', '3']);
	});
});

describe('applyClientFilters · deadline', () => {
	// 18 sep 2026, en hora LOCAL: mismo criterio que `localIsoDate`.
	const now = new Date(2026, 8, 18);
	const tasks = [
		task({ id: 'today', deadline: '2026-09-18' }),
		task({ id: 'tomorrow', deadline: '2026-09-19' }),
		task({ id: 'edge-of-window', deadline: '2026-09-25' }),
		task({ id: 'past-window', deadline: '2026-09-26' }),
		task({ id: 'past', deadline: '2026-09-01' }),
		task({ id: 'none', deadline: null }),
	];

	it('hoy: solo la que vence exactamente hoy', () => {
		const filtered = applyClientFilters(tasks, resolveQuery(parsed('deadline: hoy'), BARE), now);
		expect(filtered.map((item) => item.id)).toEqual(['today']);
	});

	it('vencido: solo lo anterior a hoy', () => {
		const filtered = applyClientFilters(
			tasks,
			resolveQuery(parsed('deadline: vencido'), BARE),
			now,
		);
		expect(filtered.map((item) => item.id)).toEqual(['past']);
	});

	it('ninguno: solo lo que no tiene fecha límite', () => {
		const filtered = applyClientFilters(tasks, resolveQuery(parsed('deadline: ninguno'), BARE), now);
		expect(filtered.map((item) => item.id)).toEqual(['none']);
	});

	it('Nd: entre hoy y hoy+N, los dos bordes incluidos', () => {
		const filtered = applyClientFilters(tasks, resolveQuery(parsed('deadline: 7d'), BARE), now);
		expect(filtered.map((item) => item.id)).toEqual(['today', 'tomorrow', 'edge-of-window']);
	});

	it('priority y deadline juntos son un Y, no un O', () => {
		const combo = [
			task({ id: 'match', deadline: '2026-09-18', priority: 'p1' }),
			task({ id: 'wrong-priority', deadline: '2026-09-18', priority: 'p4' }),
			// Fuera de la ventana de 7 días (que llega hasta el 25): solo falla
			// «deadline», no «priority».
			task({ id: 'wrong-deadline', deadline: '2026-09-30', priority: 'p1' }),
		];
		const filtered = applyClientFilters(
			combo,
			resolveQuery(parsed('deadline: 7d\npriority: p1'), BARE),
			now,
		);
		expect(filtered.map((item) => item.id)).toEqual(['match']);
	});
});

describe('applyClientFilters · sort', () => {
	it('sort: date ordena ascendente, con las ausentes al final', () => {
		const tasks = [
			task({ id: 'c', date: '2026-09-20' }),
			task({ id: 'a', date: '2026-09-10' }),
			task({ id: 'none', date: null }),
			task({ id: 'b', date: '2026-09-15' }),
		];
		const sorted = applyClientFilters(tasks, resolveQuery(parsed('sort: date'), BARE));
		expect(sorted.map((item) => item.id)).toEqual(['a', 'b', 'c', 'none']);
	});

	it('sort: date-desc invierte el orden, pero las ausentes SIGUEN al final', () => {
		const tasks = [
			task({ id: 'c', date: '2026-09-20' }),
			task({ id: 'a', date: '2026-09-10' }),
			task({ id: 'none', date: null }),
			task({ id: 'b', date: '2026-09-15' }),
		];
		const sorted = applyClientFilters(tasks, resolveQuery(parsed('sort: date-desc'), BARE));
		expect(sorted.map((item) => item.id)).toEqual(['c', 'b', 'a', 'none']);
	});

	it('sort: deadline sigue la misma regla de ausentes que date', () => {
		const tasks = [
			task({ id: 'later', deadline: '2026-09-20' }),
			task({ id: 'none', deadline: null }),
			task({ id: 'sooner', deadline: '2026-09-10' }),
		];
		const sorted = applyClientFilters(tasks, resolveQuery(parsed('sort: deadline'), BARE));
		expect(sorted.map((item) => item.id)).toEqual(['sooner', 'later', 'none']);
	});

	it('sort: priority pone p1 primero', () => {
		const tasks = [
			task({ id: 'low', priority: 'p4' }),
			task({ id: 'high', priority: 'p1' }),
			task({ id: 'mid', priority: 'p2' }),
		];
		const sorted = applyClientFilters(tasks, resolveQuery(parsed('sort: priority'), BARE));
		expect(sorted.map((item) => item.id)).toEqual(['high', 'mid', 'low']);
	});

	it('sort: priority-desc pone p4 primero', () => {
		const tasks = [task({ id: 'low', priority: 'p4' }), task({ id: 'high', priority: 'p1' })];
		const sorted = applyClientFilters(tasks, resolveQuery(parsed('sort: priority-desc'), BARE));
		expect(sorted.map((item) => item.id)).toEqual(['low', 'high']);
	});

	it('sort: server es un no-op explícito, igual que no escribir sort', () => {
		const tasks = [task({ id: 'a' }), task({ id: 'b' })];
		expect(applyClientFilters(tasks, resolveQuery(parsed('sort: server'), BARE))).toEqual(
			applyClientFilters(tasks, resolveQuery(parsed(''), BARE)),
		);
	});

	it('sin sort, se conserva el orden de llegada (el del servidor)', () => {
		const tasks = [task({ id: 'z' }), task({ id: 'a' })];
		expect(
			applyClientFilters(tasks, resolveQuery(parsed(''), BARE)).map((item) => item.id),
		).toEqual(['z', 'a']);
	});

	it('el limit se aplica DESPUÉS de ordenar', () => {
		const tasks = [
			task({ id: 'c', priority: 'p3' }),
			task({ id: 'a', priority: 'p1' }),
			task({ id: 'b', priority: 'p2' }),
		];
		const sorted = applyClientFilters(tasks, resolveQuery(parsed('sort: priority\nlimit: 2'), BARE));
		expect(sorted.map((item) => item.id)).toEqual(['a', 'b']);
	});
});

describe('describeQuery', () => {
	it('describe el scope cuando no hay título', () => {
		expect(describeQuery(resolveQuery(parsed(''), BARE))).toBe('Hoy');
		expect(describeQuery(resolveQuery(parsed('scope: upcoming\ndays: 3'), BARE))).toBe(
			'Próximos 3 días',
		);
	});

	it('con una lista entera no repite «Todas»', () => {
		expect(describeQuery(resolveQuery(parsed('list: Casa'), BARE))).toBe('Lista Casa');
	});

	it('añade la etiqueta y las hechas', () => {
		expect(describeQuery(resolveQuery(parsed('tag: casa\nincludeDone: true'), BARE))).toBe(
			'Hoy · #casa · con las hechas',
		);
	});
});
