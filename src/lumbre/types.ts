/**
 * Formas de datos de Lumbre tal y como las usa el plugin.
 *
 * Este módulo NO importa `obsidian` ni hace red: solo tipos y las funciones
 * puras que traducen entre la respuesta de la API y lo que el plugin maneja.
 *
 * La API se ha leído del repo de Lumbre (`src/routes/api/tasks/+server.ts`,
 * `serializeTask`) el 3 de septiembre de 2026, no de memoria. Donde el plugin
 * necesita un campo que ese endpoint todavía no manda, el JSDoc lo dice.
 */

/** Prioridad de cara al plugin. La API la mueve como nivel numérico `1|2|3|null`. */
export type LumbrePriority = 'p1' | 'p2' | 'p3' | 'p4';

/** Un ítem de checklist. El orden del array ES el orden de la checklist. */
export interface LumbreSubtask {
	id: string;
	content: string;
	done: boolean;
}

/** Referencia a una lista o a una sección: la API manda el id y el nombre por separado. */
export interface LumbreRef {
	id: string;
	name: string;
}

/**
 * Una tarea de Lumbre, normalizada.
 *
 * Tres campos NO vienen hoy de `GET /api/tasks` (`serializeTask` no los
 * serializa, comprobado el 3 sep 2026) y se quedan en su valor por defecto:
 * `someday` (`false`), `time` (`null`) y `rolloverCount` (`0`). Se declaran
 * igualmente porque el plugin los necesita para pintar una tarea y porque
 * `taskFromApi` ya los lee si el servidor empieza a mandarlos: el día que los
 * exponga, esto funciona sin tocar nada. NUNCA se deben leer como "la tarea no
 * es de algún día" o "no tiene hora": significan "el servidor no lo dice".
 */
export interface LumbreTask {
	id: string;
	content: string;
	/** Notas largas, `null` si no tiene o si se pidió `notes=none`. */
	notes: string | null;
	/** Día programado `YYYY-MM-DD`, o `null`. */
	date: string | null;
	/** Ver el JSDoc de la interfaz: hoy la API no lo manda. */
	someday: boolean;
	deadline: string | null;
	/** Hora `HH:MM` dentro de `date`. Ver el JSDoc de la interfaz. */
	time: string | null;
	priority: LumbrePriority;
	done: boolean;
	/**
	 * ISO 8601 de la cancelación, o `null`. Una cancelada viaja con `done: true`,
	 * así que este campo es lo único que distingue "cancelada" de "completada".
	 */
	cancelledAt: string | null;
	/** ISO 8601 del archivado, o `null` si sigue viva. */
	archivedAt: string | null;
	list: LumbreRef | null;
	section: LumbreRef | null;
	/** Ver el JSDoc de la interfaz: hoy la API no lo manda. */
	rolloverCount: number;
	/** Solo viene en el lookup por `id` y solo para tareas de primer nivel. */
	subtasks?: LumbreSubtask[];
	/** Id de la tarea padre si esta ES una subtarea; `null` si es de primer nivel. */
	parentId: string | null;
}

/**
 * Una lista de "Algún día".
 *
 * `GET /api/tasks?includeLists=1` manda hoy `{ id, name, taskCount }` y nada
 * más (comprobado el 3 sep 2026), así que `icon`, `color` y `parentListId`
 * salen `null` mientras el endpoint no los exponga. Mismo criterio que los
 * campos ausentes de `LumbreTask`: `null` es "el servidor no lo dice".
 */
export interface LumbreList {
	id: string;
	name: string;
	icon: string | null;
	color: string | null;
	parentListId: string | null;
	/** Tareas de primer nivel vivas en la lista. `0` es un valor legítimo. */
	taskCount: number;
}

/** Lo que hace falta para crear una tarea con `POST /api/ingest`. */
export interface TaskDraft {
	/** Texto de la tarea. Viaja como `text`. */
	title: string;
	/** Id estable de la lista destino. Gana sobre `list` si van los dos. */
	listId?: string | null;
	/** Nombre de la lista destino, se crea si no existe. */
	list?: string | null;
	/** Nombre de la sección dentro de `list`. Se ignora si no hay lista. */
	section?: string | null;
	date?: string | null;
	someday?: boolean | null;
	time?: string | null;
	priority?: LumbrePriority | null;
	deadline?: string | null;
	notes?: string | null;
	subtasks?: string[] | null;
}

/** Origen web por defecto de Lumbre, el mismo que trae la pestaña de ajustes. */
export const DEFAULT_WEB_ORIGIN = 'https://app.lumbre.pro';

/**
 * Las dos formas de abrir una tarea desde una nota: el esquema nativo del
 * escritorio y la URL de la web. Comprobadas en el repo de Lumbre
 * (`src/lib/desktop-deeplink.ts`, `targetForAction`, y `src/lib/entry-params.ts`,
 * que lee `?tarea=`).
 */
export function taskDeepLinks(
	task: Pick<LumbreTask, 'id'>,
	webOrigin: string = DEFAULT_WEB_ORIGIN,
): { native: string; web: string } {
	const id = encodeURIComponent(task.id);
	return {
		native: `lumbre://tarea/${id}`,
		web: `${webOrigin.replace(/\/+$/, '')}/?tarea=${id}`,
	};
}

/** Nivel numérico de la API (`1|2|3|null`) a la prioridad del plugin. */
export function priorityFromLevel(level: unknown): LumbrePriority {
	if (level === 1) return 'p1';
	if (level === 2) return 'p2';
	if (level === 3) return 'p3';
	return 'p4';
}

/** Prioridad del plugin al nivel numérico de la API. `p4` es "sin prioridad". */
export function priorityToLevel(priority: LumbrePriority): 1 | 2 | 3 | null {
	switch (priority) {
		case 'p1':
			return 1;
		case 'p2':
			return 2;
		case 'p3':
			return 3;
		case 'p4':
			return null;
	}
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function asString(value: unknown): string | null {
	return typeof value === 'string' ? value : null;
}

function refFrom(id: unknown, name: unknown): LumbreRef | null {
	const idText = asString(id);
	if (idText === null || idText.length === 0) return null;
	return { id: idText, name: asString(name) ?? idText };
}

function subtasksFrom(raw: unknown): LumbreSubtask[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const out: LumbreSubtask[] = [];
	for (const item of raw) {
		const row = asRecord(item);
		const id = asString(row?.['id']);
		if (row === null || id === null) continue;
		out.push({ id, content: asString(row['content']) ?? '', done: row['done'] === true });
	}
	return out;
}

/**
 * Una tarea del JSON de la API a `LumbreTask`. Devuelve `null` si no es una
 * tarea reconocible (sin `id` o sin `content`), para que el llamador la
 * descarte en vez de propagar un objeto a medias.
 */
export function taskFromApi(raw: unknown): LumbreTask | null {
	const row = asRecord(raw);
	if (row === null) return null;
	const id = asString(row['id']);
	if (id === null || id.length === 0) return null;

	const subtasks = subtasksFrom(row['subtasks']);
	return {
		id,
		content: asString(row['content']) ?? '',
		notes: asString(row['notes']),
		date: asString(row['date']),
		someday: row['someday'] === true,
		deadline: asString(row['deadline']),
		time: asString(row['time']),
		priority: priorityFromLevel(row['priority']),
		done: row['done'] === true,
		cancelledAt: asString(row['cancelledAt']),
		archivedAt: asString(row['archivedAt']),
		list: refFrom(row['somedayListId'], row['list']),
		section: refFrom(row['sectionId'], row['section']),
		rolloverCount: typeof row['rolloverCount'] === 'number' ? row['rolloverCount'] : 0,
		...(subtasks !== undefined ? { subtasks } : {}),
		parentId: asString(row['parentId']),
	};
}

/** Un array de tareas del JSON de la API, descartando lo que no lo sea. */
export function tasksFromApi(raw: unknown): LumbreTask[] {
	if (!Array.isArray(raw)) return [];
	const out: LumbreTask[] = [];
	for (const item of raw) {
		const task = taskFromApi(item);
		if (task !== null) out.push(task);
	}
	return out;
}

/** Una lista del JSON de `?includeLists=1`. */
export function listFromApi(raw: unknown): LumbreList | null {
	const row = asRecord(raw);
	const id = asString(row?.['id']);
	if (row === null || id === null || id.length === 0) return null;
	return {
		id,
		name: asString(row['name']) ?? id,
		icon: asString(row['icon']),
		color: asString(row['color']),
		parentListId: asString(row['parentListId']) ?? asString(row['parentId']),
		taskCount: typeof row['taskCount'] === 'number' ? row['taskCount'] : 0,
	};
}

/** El array `lists` de `?includeLists=1`, descartando lo que no sea una lista. */
export function listsFromApi(raw: unknown): LumbreList[] {
	const row = asRecord(raw);
	const lists = row?.['lists'];
	if (!Array.isArray(lists)) return [];
	const out: LumbreList[] = [];
	for (const item of lists) {
		const list = listFromApi(item);
		if (list !== null) out.push(list);
	}
	return out;
}

/**
 * La tarea PROVISIONAL de un borrador recién encolado, para poder pintar el
 * vínculo antes de que Lumbre la materialice. El id es el `clientTaskId`, que es
 * justo el que tendrá la tarea de verdad.
 *
 * Esto NO es una tarea de Lumbre: es lo que el usuario acaba de escribir. Vive
 * siempre con el vínculo en un estado distinto de `materialized`, y la primera
 * relectura buena la sustituye por la de verdad.
 */
export function taskFromDraft(
	draft: TaskDraft,
	clientTaskId: string,
	list: LumbreRef | null = null,
): LumbreTask {
	return {
		id: clientTaskId,
		content: draft.title,
		notes: draft.notes ?? null,
		date: draft.date ?? null,
		someday: draft.someday === true,
		deadline: draft.deadline ?? null,
		time: draft.time ?? null,
		priority: draft.priority ?? 'p4',
		done: false,
		cancelledAt: null,
		archivedAt: null,
		list,
		section: null,
		rolloverCount: 0,
		parentId: null,
	};
}

/**
 * Un `TaskDraft` al cuerpo de `POST /api/ingest`. Solo se mandan las claves
 * informadas: el endpoint distingue "no dijo nada" de "dijo null" en `someday`
 * y en la lista destino, así que mandar `null` por rellenar cambia lo que hace.
 */
export function draftToIngestBody(draft: TaskDraft, clientTaskId: string): Record<string, unknown> {
	const body: Record<string, unknown> = { text: draft.title, clientTaskId };
	if (draft.listId !== undefined && draft.listId !== null) body['listId'] = draft.listId;
	if (draft.list !== undefined && draft.list !== null) body['list'] = draft.list;
	if (draft.section !== undefined && draft.section !== null) body['section'] = draft.section;
	if (draft.date !== undefined && draft.date !== null) body['date'] = draft.date;
	if (draft.someday !== undefined && draft.someday !== null) body['someday'] = draft.someday;
	if (draft.time !== undefined && draft.time !== null) body['time'] = draft.time;
	if (draft.priority !== undefined && draft.priority !== null) body['priority'] = draft.priority;
	if (draft.deadline !== undefined && draft.deadline !== null) body['deadline'] = draft.deadline;
	if (draft.notes !== undefined && draft.notes !== null) body['notes'] = draft.notes;
	if (draft.subtasks !== undefined && draft.subtasks !== null && draft.subtasks.length > 0) {
		body['subtasks'] = draft.subtasks;
	}
	return body;
}
