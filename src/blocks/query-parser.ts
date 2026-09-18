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
import type { LumbrePriority, LumbreTask } from '../lumbre/types';
import { normalizeForSearch } from '../ui/search-filter';

/**
 * Cuánto cuerpo de las tareas se pide. `none` por defecto: el bloque pinta
 * títulos y traer las notas de 500 tareas es peso que nadie mira. `full` existe
 * para quien lee la consulta desde un script (`api.listTasks`), que sí puede
 * necesitar `task.notes`.
 */
export type QueryNotes = 'none' | 'full';

const QUERY_NOTES: readonly QueryNotes[] = ['none', 'full'];

/**
 * Cuánto CONTEXTO de cada tarea se pinta bajo su título: `none` (por defecto,
 * el bloque queda como siempre) o `full` (chip de estado, extracto de notas y
 * subtareas). Se llama distinto de `notes` porque implica más que el cuerpo de
 * la nota, y de `QueryContext` (la interfaz de abajo) porque esa ya nombra otra
 * cosa: el entorno contra el que se resuelve la consulta.
 */
export type TaskContextMode = 'none' | 'full';

const TASK_CONTEXT_MODES: readonly TaskContextMode[] = ['none', 'full'];

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

const PRIORITY_LEVELS: readonly LumbrePriority[] = ['p1', 'p2', 'p3', 'p4'];

/**
 * Filtro de `deadline`, ya interpretado.
 *
 * Gramática elegida (la más corta que cubre lo que se pregunta de verdad de una
 * fecha límite; ver `parseDeadlineFilter`):
 *
 * - `hoy`: la fecha límite es HOY.
 * - `vencido`: la fecha límite es anterior a hoy. No mira `done`: una vencida y
 *   completada sigue siendo `vencido` para este filtro, que solo habla de la
 *   fecha; combínalo con `includeDone: false` (el valor por defecto) si lo que
 *   se quiere es "lo que queda atrasado".
 * - `ninguno`: la tarea NO tiene fecha límite. Útil para encontrar qué falta
 *   por fechar.
 * - `Nd` (un entero seguido de `d`, p. ej. `7d`): fecha límite entre HOY y
 *   HOY+N días, ambos incluidos.
 *
 * Descartado a propósito: un rango de fechas sueltas (`2026-09-01..2026-09-10`).
 * Las cuatro formas de arriba cubren los usos reales (¿qué vence hoy?, ¿qué está
 * vencido?, ¿qué vence esta semana?, ¿a qué le falta fecha?); un rango arbitrario
 * es la quinta pregunta que nadie ha hecho todavía, y añadirlo ahora es
 * gramática sin caso de uso detrás.
 */
export type DeadlineFilter =
	| { kind: 'today' }
	| { kind: 'overdue' }
	| { kind: 'none' }
	| { kind: 'window'; days: number };

/** Campo por el que ordena `sort`. */
export type SortField = 'date' | 'deadline' | 'priority';

/**
 * `sort`, ya interpretado. `null` es "sin ordenar": se conserva el orden que
 * trae `GET /api/tasks` (ver `parseSort`), que es lo que hacía el bloque antes
 * de que existiera esta clave y lo que se sigue haciendo si no se escribe nada.
 */
export interface SortSpec {
	field: SortField;
	direction: 'asc' | 'desc';
}

const SORT_FIELDS: readonly SortField[] = ['date', 'deadline', 'priority'];
const SORT_DESC_SUFFIX = '-desc';

/**
 * Los valores que acepta `sort` en texto, para tipar `LumbreQueryInput`
 * (`src/api/lumbre-api.ts`) sin duplicar la lista de campos.
 */
export type SortInput = SortField | `${SortField}-desc` | 'server';

/**
 * Cómo se agrupan las tareas pintadas. `auto` es el valor por defecto (no
 * escrito): reproduce EXACTAMENTE el comportamiento de antes de que existiera
 * esta clave, que es fijo y no depende de lo que escriba el bloque, así que un
 * bloque ya guardado en una nota no cambia de aspecto. Ver `groupTasksForQuery`
 * (`src/ui/task-sections.ts`) para cómo se resuelve `auto`.
 */
export type GroupMode = 'auto' | 'section' | 'list' | 'date' | 'none';

const GROUP_MODES: readonly Exclude<GroupMode, 'auto'>[] = ['section', 'list', 'date', 'none'];

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
	/** Etiqueta a buscar en `effectiveTags`, sin la almohadilla. Filtro de cliente. */
	tag: string | null;
	/** Prioridades a las que se limita, o `null` sin filtrar. Filtro de cliente. */
	priority: LumbrePriority[] | null;
	/** Filtro de fecha límite, o `null` sin filtrar. Filtro de cliente. */
	deadline: DeadlineFilter | null;
	includeDone: boolean;
	limit: number | null;
	/** Cuánto cuerpo de la tarea se pide. Entra en la clave de caché. */
	notes: QueryNotes;
	/**
	 * `true` si el bloque escribió `notes`. Distingue "quiero notes: none a
	 * propósito" de "no he dicho nada", que es lo que decide si `context: full`
	 * pisa el valor en silencio o avisa en `debug` de que lo está pisando.
	 */
	notesExplicit: boolean;
	/** Cuánto contexto se pinta bajo el título. Entra en la clave de caché. */
	context: TaskContextMode;
	/** Orden de cliente, o `null` para el orden del servidor. Filtro de cliente. */
	sort: SortSpec | null;
	/** Cómo se agrupa el pintado. `auto` reproduce el comportamiento de siempre. */
	group: GroupMode;
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
	priority: LumbrePriority[] | null;
	deadline: DeadlineFilter | null;
	includeDone: boolean;
	limit: number | null;
	notes: QueryNotes;
	notesExplicit: boolean;
	context: TaskContextMode;
	sort: SortSpec | null;
	group: GroupMode;
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
		priority: null,
		deadline: null,
		includeDone: false,
		limit: null,
		notes: 'none',
		notesExplicit: false,
		context: 'none',
		sort: null,
		group: 'auto',
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
		case 'priority': {
			const priority = parsePriorityList(value);
			if (priority === null) {
				return `«priority» pide p1 a p4, o varias separadas por coma (p. ej. «p1,p2»), no «${value}».`;
			}
			query.priority = priority;
			return null;
		}
		case 'deadline': {
			const deadline = parseDeadlineFilter(value);
			if (deadline === null) {
				return `«deadline» pide hoy, vencido, ninguno o un número de días como «7d», no «${value}».`;
			}
			query.deadline = deadline;
			return null;
		}
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
			query.notesExplicit = true;
			return null;
		}
		case 'context': {
			const context = TASK_CONTEXT_MODES.find((candidate) => candidate === value.toLowerCase());
			if (context === undefined) return `«context» pide none o full, no «${value}».`;
			query.context = context;
			return null;
		}
		case 'sort': {
			const sort = parseSort(value);
			if (sort === undefined) {
				return `«sort» pide date, deadline, priority (con sufijo «-desc» para el sentido contrario) o server, no «${value}».`;
			}
			query.sort = sort;
			return null;
		}
		case 'group': {
			const group = GROUP_MODES.find((candidate) => candidate === value.toLowerCase());
			if (group === undefined) return `«group» pide section, list, date o none, no «${value}».`;
			query.group = group;
			return null;
		}
		case 'title':
			query.title = value;
			return null;
		default:
			return `No conozco la clave «${written}». Las que hay: scope, list, section, days, tag, priority, deadline, includeDone, limit, notes, context, sort, group, title.`;
	}
}

/**
 * `priority: p1`, `priority: p1,p2`... una lista separada por comas, sin
 * espacios significativos, sin repetidos (se ignoran los duplicados) y con
 * `null` si algún trozo no es `p1`..`p4` o si la lista queda vacía. Se
 * descartó un operador de comparación (`>=p2`) porque `p1` es la MÁS urgente y
 * `p4` es "sin prioridad": un `>=` sobre eso lee al revés de lo que la mayoría
 * espera la primera vez, y la lista explícita no tiene esa ambigüedad.
 */
function parsePriorityList(value: string): LumbrePriority[] | null {
	const seen = new Set<LumbrePriority>();
	for (const rawItem of value.split(',')) {
		const item = rawItem.trim().toLowerCase();
		if (item.length === 0) return null;
		const match = PRIORITY_LEVELS.find((level) => level === item);
		if (match === undefined) return null;
		seen.add(match);
	}
	return seen.size === 0 ? null : [...seen];
}

/** Ver el JSDoc de `DeadlineFilter` para la gramática. */
function parseDeadlineFilter(value: string): DeadlineFilter | null {
	const word = value.trim().toLowerCase();
	if (word === 'hoy') return { kind: 'today' };
	if (word === 'vencido') return { kind: 'overdue' };
	if (word === 'ninguno') return { kind: 'none' };
	const window = /^(\d+)d$/.exec(word);
	if (window !== null) {
		const days = Number.parseInt(window[1] ?? '', 10);
		if (days > 0) return { kind: 'window', days };
	}
	return null;
}

/**
 * `sort: date`, `sort: date-desc`... `null` para «server» (equivalente a no
 * escribir la clave, ver el JSDoc de `SortSpec`) y `undefined` si el valor no
 * se entiende, para poder distinguir los dos casos en `applyKey`.
 */
function parseSort(value: string): SortSpec | null | undefined {
	const word = value.trim().toLowerCase();
	if (word === 'server') return null;
	const descending = word.endsWith(SORT_DESC_SUFFIX);
	const field = descending ? word.slice(0, -SORT_DESC_SUFFIX.length) : word;
	const match = SORT_FIELDS.find((candidate) => candidate === field);
	if (match === undefined) return undefined;
	return { field: match, direction: descending ? 'desc' : 'asc' };
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
		priority: parsed.priority,
		deadline: parsed.deadline,
		includeDone: parsed.includeDone,
		limit: parsed.limit,
		notes: parsed.notes,
		notesExplicit: parsed.notesExplicit,
		context: parsed.context,
		sort: parsed.sort,
		group: parsed.group,
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
 * `true` si algún filtro o el orden se resuelven EN CLIENTE y por tanto el
 * `limit` escrito no puede viajar al servidor (recortaría antes de que el
 * filtro o el orden vean las tareas que se quedaron fuera). Mismo trato para
 * los cuatro: `tag`, `priority`, `deadline` y `sort` (`group` no cuenta: no
 * cambia QUÉ tareas se piden, solo cómo se pintan).
 */
function needsServerMaxLimit(
	query: Pick<ResolvedQuery, 'tag' | 'priority' | 'deadline' | 'sort'>,
): boolean {
	return (
		query.tag !== null || query.priority !== null || query.deadline !== null || query.sort !== null
	);
}

/**
 * Los parámetros que se mandan a `GET /api/tasks`.
 *
 * `limit` viaja SIEMPRE, y por defecto es el tope del servidor. El default de
 * `GET /api/tasks` es 200: sin mandar nada, una consulta de 400 tareas devolvía
 * la mitad y nadie lo decía. Con un filtro o un orden de CLIENTE activo
 * (`tag`, `priority`, `deadline`, `sort`; ver `needsServerMaxLimit`), además, el
 * `limit` escrito NO puede viajar (el servidor recortaría ANTES de que el
 * filtro o el orden vean las tareas descartadas): se pide el tope y se recorta
 * en `applyClientFilters`. `GET /api/tasks` no conoce `priority` ni `deadline`
 * como filtro (confirmado contra el servidor): por eso los dos son SIEMPRE de
 * cliente y nunca entran en `params`.
 *
 * `notes` sale de la consulta y por defecto es `none`: el bloque pinta títulos,
 * y traer el cuerpo de 500 tareas es peso que nadie mira. Con `context: full`
 * las notas SIEMPRE viajan enteras: el extracto que se pinta bajo el título
 * sale de `task.notes`, así que `notes: none` junto a `context: full` se pisa
 * (`context` gana; ver `resolveQuery` y `QueryCache` para el aviso en `debug`).
 */
export function queryParams(query: ResolvedQuery): ListTasksParams {
	const asked = needsServerMaxLimit(query) ? MAX_TASKS_LIMIT : (query.limit ?? MAX_TASKS_LIMIT);
	const params: ListTasksParams = {
		scope: query.scope,
		notes: query.context === 'full' ? 'full' : query.notes,
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
 * petición aunque tengan títulos distintos o filtren/ordenen/agrupen distinto
 * EN CLIENTE.
 *
 * `tag`, `priority`, `deadline`, `sort` y `group` NO entran aquí: ninguno de
 * los cinco cambia `queryParams` (lo que se le pide al servidor), así que dos
 * bloques que solo difieran en uno de ellos comparten lectura y cada uno aplica
 * su propio filtro/orden/agrupación sobre el mismo resultado cacheado.
 *
 * `context` entra APARTE de `queryParams`: no es un parámetro que viaje al
 * servidor (`GET /api/tasks` no lo conoce), es una decisión del PLUGIN sobre
 * si además de listar hay que pedir subtareas (ver `QueryCache`). Dos
 * consultas que piden lo mismo al servidor pero difieren en `context` no son
 * la misma consulta: una dispara peticiones extra y la otra no.
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
		query.context,
	]);
}

/**
 * Los filtros y el orden que NO hace el servidor: etiqueta, prioridad, fecha
 * límite, orden y tope de filas. Se aplica sobre lo que devolvió la consulta
 * cacheada, en este orden: primero los tres filtros (etiqueta, prioridad,
 * fecha límite; el orden entre ellos no importa, son independientes), luego el
 * orden (`sort`, si lo hay) y al final el tope (`limit`), para que "las 5
 * primeras" se lea sobre la lista ya ordenada y filtrada, no al revés.
 *
 * `now` es la fecha contra la que se resuelve `deadline: hoy` / `vencido` /
 * `Nd`. Por defecto es el reloj real; los tests la fijan para no depender del
 * día en que corren.
 */
export function applyClientFilters(
	tasks: readonly LumbreTask[],
	query: ResolvedQuery,
	now: Date = new Date(),
): LumbreTask[] {
	const tag = query.tag;
	let filtered = tag === null ? [...tasks] : tasks.filter((task) => taskHasTag(task, tag));

	if (query.priority !== null) {
		const priorities = query.priority;
		filtered = filtered.filter((task) => priorities.includes(task.priority));
	}

	if (query.deadline !== null) {
		const deadline = query.deadline;
		const todayIso = localIsoDate(now);
		filtered = filtered.filter((task) => matchesDeadline(task, deadline, todayIso));
	}

	if (query.sort !== null) filtered = sortTasks(filtered, query.sort);

	return query.limit === null ? filtered : filtered.slice(0, query.limit);
}

/**
 * `true` si la tarea lleva esa etiqueta, mirando `task.effectiveTags` (propias
 * más heredadas de lista o sección), sin tildes y sin mayúsculas, como el
 * buscador del panel. Una etiqueta padre casa con sus hijas: `tag: casa`
 * encuentra `casa/cocina`.
 *
 * Antes buscaba `#tag` en el TÍTULO (`hasTag(task.content, tag)`), así que no
 * veía ni las etiquetas propias que no estuvieran escritas en el título ni las
 * heredadas: arreglado el 18 sep 2026.
 *
 * DECISIÓN sobre `effectiveTags` AUSENTE (un Lumbre anterior a `106d124f3`, 13
 * sep 2026, que todavía no sirve el campo): la tarea NO CASA con ningún `tag`,
 * igual que si no tuviera ninguna etiqueta. Es fail-closed a propósito, no un
 * array vacío inventado (el array vacío significaría "sabemos que no tiene
 * etiquetas"; aquí no se sabe nada): la alternativa de repliegue, seguir
 * mirando el título, resucitaría el mismo bug a medias que se está arreglando
 * (un bloque que a veces filtra por título y a veces por etiquetas reales,
 * según qué tarea haya tocado la caché de subtareas). Contra un Lumbre así,
 * `tag` sencillamente no encuentra nada; es una limitación conocida de un
 * servidor viejo, no un fallo silencioso nuevo.
 */
export function taskHasTag(task: LumbreTask, tag: string): boolean {
	const needle = normalizeForSearch(tag);
	if (needle.length === 0) return false;
	const tags = task.effectiveTags;
	if (tags === undefined) return false;
	return tags.some((candidate) => matchesTagOrDescendant(normalizeForSearch(candidate), needle));
}

function matchesTagOrDescendant(candidate: string, needle: string): boolean {
	return candidate === needle || candidate.startsWith(`${needle}/`);
}

/** Ver el JSDoc de `DeadlineFilter`. `todayIso` es `YYYY-MM-DD` en hora LOCAL. */
function matchesDeadline(task: LumbreTask, filter: DeadlineFilter, todayIso: string): boolean {
	switch (filter.kind) {
		case 'none':
			return task.deadline === null;
		case 'today':
			return task.deadline === todayIso;
		case 'overdue':
			return task.deadline !== null && task.deadline < todayIso;
		case 'window': {
			if (task.deadline === null) return false;
			const limit = addDaysToIso(todayIso, filter.days);
			return task.deadline >= todayIso && task.deadline <= limit;
		}
	}
}

/** `YYYY-MM-DD` de una fecha en hora LOCAL, no UTC: es el día que ve quien lee el bloque. */
function localIsoDate(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

/** Un `YYYY-MM-DD` más `days` días, en hora LOCAL (mismo criterio que `localIsoDate`). */
function addDaysToIso(iso: string, days: number): string {
	const [year, month, day] = iso.split('-').map(Number);
	return localIsoDate(new Date(year ?? 0, (month ?? 1) - 1, (day ?? 1) + days));
}

/**
 * Ordena por `sort`, con desempate por el orden de LLEGADA (el que traía el
 * servidor): un `Array.prototype.sort` explícitamente estable, para no confiar
 * en que el motor de turno lo sea.
 *
 * Las fechas ausentes (`date`/`deadline` a `null`) van SIEMPRE al final, gane
 * quien gane la dirección: en `sort: date-desc` lo más reciente sale primero,
 * pero lo sin fecha sigue sin ser "lo más reciente", así que se queda detrás
 * también ahí. `priority` no tiene este problema: toda tarea tiene una, `p4`
 * es "sin prioridad" pero es un valor, no una ausencia.
 */
function sortTasks(tasks: readonly LumbreTask[], sort: SortSpec): LumbreTask[] {
	return tasks
		.map((task, index) => ({ task, index }))
		.sort((a, b) => compareForSort(a.task, b.task, sort) || a.index - b.index)
		.map((entry) => entry.task);
}

function compareForSort(a: LumbreTask, b: LumbreTask, sort: SortSpec): number {
	const factor = sort.direction === 'desc' ? -1 : 1;
	switch (sort.field) {
		case 'priority':
			return factor * (priorityRank(a.priority) - priorityRank(b.priority));
		case 'date':
			return compareNullableDates(a.date, b.date, factor);
		case 'deadline':
			return compareNullableDates(a.deadline, b.deadline, factor);
	}
}

function priorityRank(priority: LumbrePriority): number {
	switch (priority) {
		case 'p1':
			return 1;
		case 'p2':
			return 2;
		case 'p3':
			return 3;
		case 'p4':
			return 4;
	}
}

/** Ver el JSDoc de `sortTasks`: las ausentes van al final pase lo que pase `factor`. */
function compareNullableDates(a: string | null, b: string | null, factor: number): number {
	if (a === null && b === null) return 0;
	if (a === null) return 1;
	if (b === null) return -1;
	return factor * (a < b ? -1 : a > b ? 1 : 0);
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
