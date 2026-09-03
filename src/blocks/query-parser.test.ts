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
				'includeDone: true',
				'limit: 20',
				'notes: full',
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
			includeDone: true,
			limit: 20,
			notes: 'full',
			title: 'Lo que viene',
		});
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

	it('sin limit escrito pide el tope, no el default de 200 del servidor', () => {
		expect(queryParams(resolveQuery(parsed(''), BARE)).limit).toBe(MAX_TASKS_LIMIT);
	});

	it('un limit por encima del tope se recorta al tope', () => {
		expect(queryParams(resolveQuery(parsed('limit: 9000'), BARE)).limit).toBe(MAX_TASKS_LIMIT);
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
});

describe('applyClientFilters', () => {
	const tasks = [
		task({ id: '1', content: 'Comprar pan #casa' }),
		task({ id: '2', content: 'Llamar al fontanero #casa/cocina' }),
		task({ id: '3', content: 'Escribir el informe #trabajo' }),
		task({ id: '4', content: 'Sin etiqueta' }),
	];

	it('sin filtros devuelve todo', () => {
		expect(applyClientFilters(tasks, resolveQuery(parsed(''), BARE))).toHaveLength(4);
	});

	it('la etiqueta filtra por el título, y la padre casa con la hija', () => {
		const filtered = applyClientFilters(tasks, resolveQuery(parsed('tag: casa'), BARE));
		expect(filtered.map((item) => item.id)).toEqual(['1', '2']);
	});

	it('la etiqueta no casa a medias', () => {
		const filtered = applyClientFilters(tasks, resolveQuery(parsed('tag: cas'), BARE));
		expect(filtered).toHaveLength(0);
	});

	it('el tope se aplica después de filtrar por etiqueta', () => {
		const filtered = applyClientFilters(tasks, resolveQuery(parsed('tag: casa\nlimit: 1'), BARE));
		expect(filtered.map((item) => item.id)).toEqual(['1']);
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
