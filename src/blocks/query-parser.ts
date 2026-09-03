/**
 * La consulta de un bloque ```lumbre```: parseo, resolución y filtro en cliente.
 *
 * El cuerpo del bloque son líneas `clave: valor`. El parser es propio y
 * tolerante (mayúsculas, espacios, comillas, claves con guion o guion bajo),
 * pero NO adivina: una clave que no conoce o un valor que no vale se devuelven
 * como error en una línea, y el bloque lo pinta tal cual.
 *
 * Módulo puro: no importa `obsidian` y no hace red. Aquí vive todo lo que decide
 * QUÉ se pide, para que el bloque y la API pública compartan exactamente la
 * misma consulta y, por tanto, la misma entrada de caché.
 */

import { MAX_TASKS_LIMIT, type ListTasksParams } from '../lumbre/client';
import type { LumbreTask } from '../lumbre/types';
import { normalizeForSearch } from '../ui/search-filter';

/**
 * Cuánto cuerpo de las tareas se pide. `none` por defecto: el bloque pinta
 * títulos y traer las notas de 500 tareas es peso que nadie mira. `full` existe
 * para quien lee la consulta desde un script (`api.listTasks`), que sí puede
 * necesitar `task.notes`.
 */
export type QueryNotes = 'none' | 'full';

const QUERY_NOTES: readonly QueryNotes[] = ['none', 'full'];

/** Los `scope` que acepta `GET /api/tasks`. */
export type LumbreScope = 'today' | 'week' | 'upcoming' | 'inbox' | 'someday' | 'overdue' | 'all';

export const QUERY_SCOPES: readonly LumbreScope[] = [
	'today',
	'week',
	'upcoming',
	'inbox',
	'someday',
	'overdue',
	'all',
];

/** La consulta tal y como está escrita, antes de mirar la nota ni las listas. */
export interface ParsedQuery {
	scope: LumbreScope;
	/**
	 * `true` si el bloque escribió `scope`. Distingue "quiero hoy" de "no he
	 * dicho nada", que es lo que deja entrar al `lumbre-list` de la nota.
	 */
	scopeExplicit: boolean;
	/** Nombre O id de lista, tal y como se escribió. */
	list: string | null;
	section: string | null;
	/** Días de la ventana de `upcoming`. Solo vale con ese scope. */
	days: number | null;
	/** Etiqueta a buscar dentro del título, sin la almohadilla. */
	tag: string | null;
	includeDone: boolean;
	limit: number | null;
	/** Cuánto cuerpo de la tarea se pide. Entra en la clave de caché. */
	notes: QueryNotes;
	/** Texto de la cabecera. Sin él se describe la consulta. */
	title: string | null;
}

export type QueryParseResult = { ok: true; query: ParsedQuery } | { ok: false; error: string };

/** Lo que hace falta saber del entorno para resolver una consulta. */
export interface QueryContext {
	/** El `lumbre-list` de la nota donde vive el bloque, o `null`. */
	noteListId: string | null;
	/**
	 * El NOMBRE de una lista a partir de su id o de su nombre, o `null` si no
	 * está en el catálogo. La API filtra listas por nombre, y `lumbre-list`
	 * guarda un id: sin esta traducción una nota de proyecto no encontraría nada.
	 */
	resolveList(raw: string): string | null;
}

/** La consulta ya resuelta contra la nota y el catálogo de listas. */
export interface ResolvedQuery {
	scope: LumbreScope;
	/** Nombre de lista listo para `?list=`, o `null`. */
	list: string | null;
	section: string | null;
	days: number | null;
	tag: string | null;
	includeDone: boolean;
	limit: number | null;
	notes: QueryNotes;
	title: string | null;
}

/** Consulta vacía: lo de hoy. */
export function emptyQuery(): ParsedQuery {
	return {
		scope: 'today',
		scopeExplicit: false,
		list: null,
		section: null,
		days: null,
		tag: null,
		includeDone: false,
		limit: null,
		notes: 'none',
		title: null,
	};
}

/**
 * El cuerpo del bloque a una consulta, o el error en una línea. Nunca lanza: el
 * bloque tiene que poder pintar el problema, no reventar el render de la nota.
 */
export function parseQuery(source: string): QueryParseResult {
	const query = emptyQuery();

	for (const rawLine of source.split('\n')) {
		const line = rawLine.trim();
		if (line.length === 0) continue;

		const separator = line.indexOf(':');
		if (separator < 0) {
			return { ok: false, error: `No entiendo «${line}»: cada línea es «clave: valor».` };
		}

		const written = line.slice(0, separator).trim();
		const key = normalizeKey(written);
		const value = unquote(line.slice(separator + 1).trim());
		if (value.length === 0) return { ok: false, error: `La clave «${written}» está sin valor.` };

		const failure = applyKey(query, key, written, value);
		if (failure !== null) return { ok: false, error: failure };
	}

	// Se comprueba al final y no al leer la clave: así `days` antes de `scope`
	// también vale, que es lo que uno espera de un bloque de texto.
	if (query.days !== null && query.scope !== 'upcoming') {
		return { ok: false, error: '«days» solo vale con «scope: upcoming».' };
	}

	return { ok: true, query };
}

/** Escribe una clave en la consulta, o devuelve el error. `null` si fue bien. */
function applyKey(query: ParsedQuery, key: string, written: string, value: string): string | null {
	switch (key) {
		case 'scope': {
			const scope = QUERY_SCOPES.find((candidate) => candidate === value.toLowerCase());
			if (scope === undefined) {
				return `«${value}» no es un scope. Los que hay: ${QUERY_SCOPES.join(', ')}.`;
			}
			query.scope = scope;
			query.scopeExplicit = true;
			return null;
		}
		case 'list':
			query.list = value;
			return null;
		case 'section':
			query.section = value;
			return null;
		case 'days': {
			const days = positiveInteger(value);
			if (days === null) return `«days» pide un número entero de días, no «${value}».`;
			query.days = days;
			return null;
		}
		case 'tag':
			query.tag = value.replace(/^#/, '');
			return null;
		case 'includedone': {
			const flag = booleanValue(value);
			if (flag === null) return `«includeDone» pide true o false, no «${value}».`;
			query.includeDone = flag;
			return null;
		}
		case 'limit': {
			const limit = positiveInteger(value);
			if (limit === null) return `«limit» pide un número entero mayor que cero, no «${value}».`;
			query.limit = limit;
			return null;
		}
		case 'notes': {
			const notes = QUERY_NOTES.find((candidate) => candidate === value.toLowerCase());
			if (notes === undefined) return `«notes» pide none o full, no «${value}».`;
			query.notes = notes;
			return null;
		}
		case 'title':
			query.title = value;
			return null;
		default:
			return `No conozco la clave «${written}». Las que hay: scope, list, section, days, tag, includeDone, limit, notes, title.`;
	}
}

/**
 * La consulta contra la nota y el catálogo de listas.
 *
 * Dos reglas de defecto, las dos con la misma idea (nombrar una lista significa
 * "toda la lista", no "lo de hoy de esa lista"):
 *
 * - Con `list` escrito y sin `scope` escrito, el scope es `all`.
 * - Sin `list` y sin `scope` escritos, si la nota tiene `lumbre-list` se usa esa
 *   lista, también con `all`.
 */
export function resolveQuery(parsed: ParsedQuery, context: QueryContext): ResolvedQuery {
	const base = {
		section: parsed.section,
		days: parsed.days,
		tag: parsed.tag,
		includeDone: parsed.includeDone,
		limit: parsed.limit,
		notes: parsed.notes,
		title: parsed.title,
	};

	if (parsed.list !== null) {
		return {
			...base,
			scope: parsed.scopeExplicit ? parsed.scope : 'all',
			list: context.resolveList(parsed.list) ?? parsed.list,
		};
	}

	if (!parsed.scopeExplicit && context.noteListId !== null) {
		return {
			...base,
			scope: 'all',
			list: context.resolveList(context.noteListId) ?? context.noteListId,
		};
	}

	return { ...base, scope: parsed.scope, list: null };
}

/**
 * Los parámetros que se mandan a `GET /api/tasks`.
 *
 * `limit` viaja SIEMPRE, y por defecto es el tope del servidor. El default de
 * `GET /api/tasks` es 200: sin mandar nada, una consulta de 400 tareas devolvía
 * la mitad y nadie lo decía. Con `tag`, además, el `limit` escrito NO puede
 * viajar (el servidor recortaría ANTES del filtro por etiqueta, que es de
 * cliente): se pide el tope y se recorta en `applyClientFilters`.
 *
 * `notes` sale de la consulta y por defecto es `none`: el bloque pinta títulos,
 * y traer el cuerpo de 500 tareas es peso que nadie mira.
 */
export function queryParams(query: ResolvedQuery): ListTasksParams {
	const asked = query.tag !== null ? MAX_TASKS_LIMIT : (query.limit ?? MAX_TASKS_LIMIT);
	const params: ListTasksParams = {
		scope: query.scope,
		notes: query.notes,
		limit: Math.min(asked, MAX_TASKS_LIMIT),
	};
	if (query.list !== null) params.list = query.list;
	if (query.section !== null) params.section = query.section;
	if (query.days !== null) params.days = query.days;
	if (query.includeDone) params.includeDone = true;
	return params;
}

/**
 * Clave de caché de una consulta. Se calcula sobre lo que se PIDE al servidor,
 * no sobre lo escrito: dos bloques que piden lo mismo comparten una sola
 * petición aunque tengan títulos distintos o filtren por etiquetas distintas.
 */
export function queryKey(query: ResolvedQuery): string {
	const params = queryParams(query);
	return JSON.stringify([
		params.scope,
		params.list ?? null,
		params.section ?? null,
		params.days ?? null,
		params.includeDone === true,
		params.limit ?? null,
		params.notes ?? null,
	]);
}

/**
 * El filtro que NO hace el servidor: la etiqueta dentro del título y el tope de
 * filas. Se aplica sobre lo que devolvió la consulta cacheada.
 */
export function applyClientFilters(
	tasks: readonly LumbreTask[],
	query: ResolvedQuery,
): LumbreTask[] {
	const tag = query.tag;
	const tagged = tag === null ? [...tasks] : tasks.filter((task) => hasTag(task.content, tag));
	return query.limit === null ? tagged : tagged.slice(0, query.limit);
}

/**
 * `true` si el título lleva esa etiqueta. Sin tildes y sin mayúsculas, como el
 * buscador del panel, y una etiqueta padre casa con sus hijas: `tag: casa`
 * encuentra `#casa/cocina`.
 */
export function hasTag(content: string, tag: string): boolean {
	const needle = normalizeForSearch(tag);
	if (needle.length === 0) return false;
	const pattern = new RegExp(`#${escapeRegExp(needle)}(?![\\p{L}\\p{N}_-])`, 'u');
	return pattern.test(normalizeForSearch(content));
}

/** Cabecera del bloque cuando la consulta no trae `title`. */
export function describeQuery(query: ResolvedQuery): string {
	const parts: string[] = [];
	if (query.list !== null) {
		parts.push(`Lista ${query.list}`);
		if (query.section !== null) parts.push(query.section);
		// Con una lista, `all` no añade nada: "Lista Casa" ya es toda la lista.
		if (query.scope !== 'all') parts.push(scopeLabel(query));
	} else {
		parts.push(scopeLabel(query));
	}
	if (query.tag !== null) parts.push(`#${query.tag}`);
	if (query.includeDone) parts.push('con las hechas');
	return parts.join(' · ');
}

function scopeLabel(query: ResolvedQuery): string {
	switch (query.scope) {
		case 'today':
			return 'Hoy';
		case 'week':
			return 'Esta semana';
		case 'upcoming':
			return query.days === null ? 'Próximos días' : `Próximos ${query.days} días`;
		case 'inbox':
			return 'Bandeja de entrada';
		case 'someday':
			return 'Algún día';
		case 'overdue':
			return 'Atrasadas';
		case 'all':
			return 'Todas';
	}
}

/** `includeDone`, `include-done`, `Include Done` y `include_done` son la misma clave. */
function normalizeKey(raw: string): string {
	return raw.toLowerCase().replace(/[\s_-]/g, '');
}

/** Quita las comillas de alrededor si las hay. Dentro del valor no toca nada. */
function unquote(value: string): string {
	const quoted = /^(["'])(.*)\1$/.exec(value);
	return quoted?.[2] ?? value;
}

function positiveInteger(value: string): number | null {
	if (!/^\d+$/.test(value)) return null;
	const parsed = Number.parseInt(value, 10);
	return parsed > 0 ? parsed : null;
}

const TRUE_WORDS: ReadonlySet<string> = new Set(['true', 'yes', 'si', 'sí', '1']);
const FALSE_WORDS: ReadonlySet<string> = new Set(['false', 'no', '0']);

function booleanValue(value: string): boolean | null {
	const word = value.toLowerCase();
	if (TRUE_WORDS.has(word)) return true;
	if (FALSE_WORDS.has(word)) return false;
	return null;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
