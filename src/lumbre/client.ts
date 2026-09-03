/**
 * Cliente HTTP contra la API de Lumbre.
 *
 * Este módulo NO importa `obsidian` a propósito: recibe la función de red por
 * inyección (`request`), y es `main.ts` quien le pasa `requestUrl`. Así el
 * cliente se puede probar con Vitest sin cargar la API de Obsidian.
 *
 * Ninguna llamada lanza: todo sale como `{ ok: false, reason }`. Y el token
 * NUNCA entra en un mensaje de error, solo en la cabecera `Authorization`.
 *
 * Las escrituras (`createTask`, `mutate`, `batch`) se ENCOLAN en el servidor:
 * un 200 significa "aceptada", no "ya existe". Quien necesite certeza llama a
 * `flush()` y RELEE (eso es lo que hace `OperationQueue`, en `queue.ts`).
 *
 * Límite de la API: 120 llamadas por minuto (60/min en `/api/mutations` y en
 * `/api/sync/flush`), así que un 429 es esperable y sale como `rate_limited`.
 */

import {
	draftToIngestBody,
	listsFromApi,
	priorityToLevel,
	tasksFromApi,
	type LumbreList,
	type LumbrePriority,
	type LumbreTask,
	type TaskDraft,
} from './types';

/** Motivo por el que una llamada no ha salido bien, ya traducido a algo mostrable. */
export type FailureReason =
	| 'no_token'
	| 'unauthorized'
	| 'bad_request'
	| 'rate_limited'
	| 'network'
	| 'server';

export interface LumbreFailure {
	ok: false;
	reason: FailureReason;
	status?: number;
}

/** Resultado uniforme de cualquier método del cliente. */
export type LumbreResult<T> = { ok: true; value: T } | LumbreFailure;

/** `ping()` no devuelve nada útil: solo si el origen y el token valen. */
export type PingResult = LumbreResult<void>;

/** Subconjunto de las opciones de `requestUrl` que usa este cliente. */
export interface LumbreRequestInit {
	url: string;
	method: string;
	headers: Record<string, string>;
	/** Cuerpo ya serializado a JSON. Ausente en los GET. */
	body?: string;
	/** Con `false`, un status de error vuelve como respuesta en vez de como excepción. */
	throw: false;
}

/** Subconjunto de la respuesta de `requestUrl` que usa este cliente. */
export interface LumbreResponse {
	status: number;
	/**
	 * Cuerpo ya parseado. En `requestUrl` es un getter que LANZA si el cuerpo no
	 * es JSON (una página de error de un proxy, por ejemplo), así que siempre se
	 * lee dentro de un try (ver `readJson`).
	 */
	json?: unknown;
}

export type LumbreRequestFn = (init: LumbreRequestInit) => Promise<LumbreResponse>;

export interface LumbreClientOptions {
	/**
	 * Origen de la API, por ejemplo `https://app.lumbre.pro`. Sin ruta. Como
	 * función, se consulta en CADA llamada: así cambiar el origen en los ajustes
	 * no deja al cliente apuntando al servidor anterior.
	 */
	apiOrigin: string | (() => string);
	/** Devuelve el token personal, o `null` si todavía no hay ninguno guardado. */
	getToken: () => Promise<string | null>;
	request: LumbreRequestFn;
}

/** Parámetros de `GET /api/tasks`, mismos nombres que los del endpoint. */
export interface ListTasksParams {
	scope?: 'today' | 'week' | 'upcoming' | 'inbox' | 'someday' | 'overdue' | 'all';
	/** Días de la ventana de `scope: 'upcoming'`. Con otro scope el servidor da 400. */
	days?: number;
	/** Nombre de una lista de "Algún día". */
	list?: string;
	/** Nombre de una sección dentro de `list`. */
	section?: string;
	includeDone?: boolean;
	includeArchived?: boolean;
	limit?: number;
	/** `full` (default del servidor), `length` (solo la longitud) o `none`. */
	notes?: 'full' | 'length' | 'none';
	/** Día `YYYY-MM-DD` que el servidor debe tomar como "hoy". */
	today?: string;
}

/**
 * Una mutación sobre una tarea que YA existe. Es la superficie del plugin, no
 * la del servidor: `translateOp` la traduce al `{ taskId, kind, payload }` que
 * acepta `POST /api/mutations` (ver `MUTATION_KINDS` en el repo de Lumbre).
 */
export type MutationOp =
	| { op: 'complete'; taskId: string; done?: boolean }
	| {
			op: 'update';
			taskId: string;
			content?: string;
			notes?: string;
			priority?: LumbrePriority;
			time?: string | null;
	  }
	| { op: 'reschedule'; taskId: string; date: string | null }
	| { op: 'setSection'; taskId: string; section: string | null }
	| { op: 'moveToList'; taskId: string; listId?: string | null; list?: string }
	| { op: 'cancel'; taskId: string; cancelled?: boolean }
	| { op: 'restore'; taskId: string }
	| { op: 'addSubtask'; taskId: string; subtasks: string[] }
	/** Completar una SUBTAREA es un `complete` dirigido a su propio id. */
	| { op: 'completeSubtask'; subtaskId: string; done?: boolean };

/** Una operación de `POST /api/batch`: crear una tarea o mutar una existente. */
export type BatchOperation =
	| { type: 'create'; clientTaskId: string; draft: TaskDraft }
	| { type: 'mutate'; op: MutationOp };

/** Una entrada del informe de `POST /api/batch`. `index` es la posición en `ops`. */
export interface BatchResultItem {
	index: number;
	type: 'ingest' | 'mutate' | 'unknown';
	ok: boolean;
	error?: string;
	id?: string;
}

/**
 * Lo que acepta `POST /api/mutations` en el cuerpo. Va como `type` y no como
 * `interface` para que sea asignable a `Record<string, unknown>`, que es lo que
 * recibe `send`.
 */
type ServerMutation = {
	taskId: string;
	kind: string;
	payload: Record<string, unknown>;
};

/** Tope de ids por petición que impone `GET /api/tasks?ids=` en el servidor. */
const MAX_IDS_PER_REQUEST = 200;

/** Tope de operaciones por lote que impone `POST /api/batch`. */
export const MAX_BATCH_OPS = 200;

export class LumbreClient {
	/**
	 * El `flush()` en vuelo, si lo hay. Un solo flush a la vez: los demás
	 * llamadores esperan a ESE, en vez de gastar una petición cada uno contra un
	 * endpoint que hace exactamente lo mismo y que tiene su propio límite de
	 * 60 llamadas por minuto.
	 */
	private inFlightFlush: Promise<LumbreResult<void>> | null = null;

	constructor(private readonly options: LumbreClientOptions) {}

	/**
	 * Comprueba que el origen y el token valen: pide una tarea y descarta el cuerpo.
	 * Nunca lanza; todo fallo sale como `{ ok: false, reason }`.
	 */
	async ping(): Promise<PingResult> {
		const response = await this.send('GET', '/api/tasks?limit=1&notes=none');
		if (!response.ok) return response;
		return { ok: true, value: undefined };
	}

	/** `GET /api/tasks`: las tareas del usuario dueño del token. */
	async listTasks(params: ListTasksParams = {}): Promise<LumbreResult<LumbreTask[]>> {
		const query = new URLSearchParams();
		if (params.scope !== undefined) query.set('scope', params.scope);
		if (params.days !== undefined) query.set('days', String(params.days));
		if (params.list !== undefined) query.set('list', params.list);
		if (params.section !== undefined) query.set('section', params.section);
		if (params.includeDone === true) query.set('includeDone', 'true');
		if (params.includeArchived === true) query.set('includeArchived', 'true');
		if (params.limit !== undefined) query.set('limit', String(params.limit));
		if (params.notes !== undefined) query.set('notes', params.notes);
		if (params.today !== undefined) query.set('today', params.today);

		const suffix = query.toString();
		const response = await this.send('GET', `/api/tasks${suffix ? `?${suffix}` : ''}`);
		if (!response.ok) return response;
		return { ok: true, value: tasksFromApi(response.value) };
	}

	/**
	 * `GET /api/tasks?ids=`: varias tareas de golpe. Trocea por encima del tope
	 * del servidor. Un id sin coincidencia simplemente no sale en el resultado,
	 * igual que en `getTask`.
	 */
	async getTasksByIds(ids: string[]): Promise<LumbreResult<LumbreTask[]>> {
		if (ids.length === 0) return { ok: true, value: [] };
		const out: LumbreTask[] = [];
		for (let i = 0; i < ids.length; i += MAX_IDS_PER_REQUEST) {
			const chunk = ids.slice(i, i + MAX_IDS_PER_REQUEST);
			const query = new URLSearchParams({ ids: chunk.join(',') });
			const response = await this.send('GET', `/api/tasks?${query.toString()}`);
			if (!response.ok) return response;
			out.push(...tasksFromApi(response.value));
		}
		return { ok: true, value: out };
	}

	/**
	 * `GET /api/tasks?id=`: UNA tarea por id, o `null` si no existe, no es del
	 * usuario del token o está archivada. Encuentra también subtareas.
	 */
	async getTask(id: string): Promise<LumbreResult<LumbreTask | null>> {
		const query = new URLSearchParams({ id });
		const response = await this.send('GET', `/api/tasks?${query.toString()}`);
		if (!response.ok) return response;
		const [first] = tasksFromApi(response.value);
		return { ok: true, value: first ?? null };
	}

	/** `GET /api/tasks?includeLists=1`: todas las listas vivas, incluidas las vacías. */
	async listLists(): Promise<LumbreResult<LumbreList[]>> {
		const response = await this.send('GET', '/api/tasks?includeLists=1');
		if (!response.ok) return response;
		return { ok: true, value: listsFromApi(response.value) };
	}

	/**
	 * `POST /api/ingest`: encola una tarea nueva. El id lo genera el LLAMADOR
	 * (`crypto.randomUUID()`) y viaja como `clientTaskId`: repetir la llamada con
	 * el mismo id no crea una segunda tarea, que es lo que hace seguro reintentar
	 * cuando se pierde la respuesta HTTP.
	 */
	async createTask(draft: TaskDraft, clientTaskId: string): Promise<LumbreResult<void>> {
		const response = await this.send(
			'POST',
			'/api/ingest',
			draftToIngestBody(draft, clientTaskId),
		);
		if (!response.ok) return response;
		return { ok: true, value: undefined };
	}

	/** `POST /api/mutations`: encola una mutación sobre una tarea existente. */
	async mutate(op: MutationOp): Promise<LumbreResult<void>> {
		const response = await this.send('POST', '/api/mutations', translateOp(op));
		if (!response.ok) return response;
		return { ok: true, value: undefined };
	}

	/**
	 * `POST /api/batch`: N operaciones en una petición, con éxito PARCIAL (una op
	 * inválida no tumba las demás; el informe dice cuál falló). Más de
	 * `MAX_BATCH_OPS` operaciones sale como `bad_request` sin gastar la petición.
	 */
	async batch(ops: BatchOperation[]): Promise<LumbreResult<BatchResultItem[]>> {
		if (ops.length === 0) return { ok: true, value: [] };
		if (ops.length > MAX_BATCH_OPS) return { ok: false, reason: 'bad_request' };

		const body = {
			ops: ops.map((operation) =>
				operation.type === 'create'
					? { type: 'ingest', task: draftToIngestBody(operation.draft, operation.clientTaskId) }
					: { type: 'mutate', ...translateOp(operation.op) },
			),
		};
		const response = await this.send('POST', '/api/batch', body);
		if (!response.ok) return response;
		return { ok: true, value: batchResultsFrom(response.value) };
	}

	/**
	 * `POST /api/sync/flush`: fuerza el drenaje de lo encolado ANTES de releer.
	 * Un solo flush en vuelo: si ya hay uno corriendo, esta llamada espera a ese.
	 */
	async flush(): Promise<LumbreResult<void>> {
		const running = this.inFlightFlush;
		if (running !== null) return running;

		const started = this.runFlush();
		this.inFlightFlush = started;
		try {
			return await started;
		} finally {
			if (this.inFlightFlush === started) this.inFlightFlush = null;
		}
	}

	private async runFlush(): Promise<LumbreResult<void>> {
		const response = await this.send('POST', '/api/sync/flush');
		if (!response.ok) return response;
		return { ok: true, value: undefined };
	}

	/**
	 * Una petición autenticada. Devuelve el cuerpo ya parseado, o el fallo ya
	 * clasificado. El error de red se traga a propósito: puede llevar la URL y no
	 * aporta nada accionable más allá de "no se pudo conectar".
	 */
	private async send(
		method: string,
		path: string,
		body?: Record<string, unknown>,
	): Promise<LumbreResult<unknown>> {
		const token = await this.options.getToken();
		if (!token) return { ok: false, reason: 'no_token' };

		const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
		if (body !== undefined) headers['Content-Type'] = 'application/json';

		let response: LumbreResponse;
		try {
			response = await this.options.request({
				url: `${this.origin()}${path}`,
				method,
				headers,
				...(body !== undefined ? { body: JSON.stringify(body) } : {}),
				throw: false,
			});
		} catch {
			return { ok: false, reason: 'network' };
		}

		const failure = failureForStatus(response.status);
		if (failure !== null) return failure;
		return { ok: true, value: readJson(response) };
	}

	private origin(): string {
		const raw =
			typeof this.options.apiOrigin === 'function'
				? this.options.apiOrigin()
				: this.options.apiOrigin;
		return raw.replace(/\/+$/, '');
	}
}

/**
 * Una `MutationOp` del plugin al `{ taskId, kind, payload }` de la API. Los
 * payloads son los que valida `validateMutationPayload` en el repo de Lumbre:
 * un campo de más o un nombre distinto se rechaza con 400.
 */
export function translateOp(op: MutationOp): ServerMutation {
	switch (op.op) {
		case 'complete':
			return { taskId: op.taskId, kind: 'complete', payload: { done: op.done ?? true } };
		case 'completeSubtask':
			// Una subtarea se completa con el MISMO kind que una tarea, apuntando a
			// su propio id: el servidor no tiene un `completeSubtask` aparte.
			return { taskId: op.subtaskId, kind: 'complete', payload: { done: op.done ?? true } };
		case 'update': {
			const payload: Record<string, unknown> = {};
			if (op.content !== undefined) payload['content'] = op.content;
			if (op.notes !== undefined) payload['notes'] = op.notes;
			if (op.priority !== undefined) payload['priority'] = priorityToLevel(op.priority);
			if (op.time !== undefined) payload['time'] = op.time;
			return { taskId: op.taskId, kind: 'update', payload };
		}
		case 'reschedule':
			return { taskId: op.taskId, kind: 'reschedule', payload: { date: op.date } };
		case 'setSection':
			return { taskId: op.taskId, kind: 'setSection', payload: { section: op.section } };
		case 'moveToList': {
			// `listId` manda si viene presente, incluido `null` (desvincular); si no,
			// se cae a `list` por nombre. Mismo criterio que el endpoint.
			const payload: Record<string, unknown> =
				op.listId !== undefined ? { listId: op.listId } : { list: op.list ?? '' };
			return { taskId: op.taskId, kind: 'moveToList', payload };
		}
		case 'cancel':
			return { taskId: op.taskId, kind: 'cancel', payload: { cancelled: op.cancelled ?? true } };
		case 'restore':
			return { taskId: op.taskId, kind: 'restore', payload: {} };
		case 'addSubtask':
			return { taskId: op.taskId, kind: 'addSubtask', payload: { subtasks: op.subtasks } };
	}
}

/**
 * Traduce el status HTTP a un motivo, o `null` si la respuesta es buena. El
 * conjunto de motivos es cerrado: cualquier otro status (un 404 de una ruta que
 * no existe, por ejemplo) cae en `server`, que es donde se ve el número.
 */
function failureForStatus(status: number): LumbreFailure | null {
	if (status >= 200 && status < 300) return null;
	if (status === 400) return { ok: false, reason: 'bad_request', status };
	if (status === 401 || status === 403) return { ok: false, reason: 'unauthorized', status };
	if (status === 429) return { ok: false, reason: 'rate_limited', status };
	return { ok: false, reason: 'server', status };
}

/** El cuerpo JSON, o `null` si no lo hay (el getter de `requestUrl` puede lanzar). */
function readJson(response: LumbreResponse): unknown {
	try {
		return response.json ?? null;
	} catch {
		return null;
	}
}

function batchResultsFrom(raw: unknown): BatchResultItem[] {
	if (raw === null || typeof raw !== 'object') return [];
	const results = (raw as { results?: unknown }).results;
	if (!Array.isArray(results)) return [];
	return results.filter((item): item is BatchResultItem => {
		if (item === null || typeof item !== 'object') return false;
		const row = item as Record<string, unknown>;
		return typeof row['index'] === 'number' && typeof row['ok'] === 'boolean';
	});
}

/** Texto en castellano para cada motivo de fallo, listo para un Notice. */
export function describeFailure(reason: FailureReason, status?: number): string {
	switch (reason) {
		case 'no_token':
			return 'Falta el token personal.';
		case 'unauthorized':
			return 'El token no vale o ha caducado.';
		case 'bad_request':
			return 'Lumbre rechazó la petición por su contenido.';
		case 'rate_limited':
			return 'Demasiadas peticiones a Lumbre; espera un momento.';
		case 'network':
			return 'No se pudo conectar con Lumbre.';
		case 'server':
			return status === undefined
				? 'Lumbre respondió con un error.'
				: `Lumbre respondió con un error (${status}).`;
	}
}
