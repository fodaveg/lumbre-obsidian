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
	| 'server'
	/** El cuerpo pasa del tope del endpoint. Hoy solo lo produce `uploadAttachment`. */
	| 'too_large';

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
	/**
	 * Cuerpo ya serializado: JSON en texto, o los bytes crudos de un adjunto.
	 * Ausente en los GET.
	 */
	body?: string | ArrayBuffer;
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
	/**
	 * Cuerpo en texto. En `requestUrl` también es un getter, así que se lee
	 * dentro de un try igual que `json`. Lo usa el BRL, que responde
	 * `text/markdown` y no JSON.
	 */
	text?: string;
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
	| { op: 'completeSubtask'; subtaskId: string; done?: boolean }
	/**
	 * Una entrada NUEVA del registro del día (BRL). El id lo genera el llamador y
	 * viaja como `taskId`, igual que un `clientTaskId`: reenviar la misma
	 * operación no crea una segunda entrada. `entry` es el texto con su marcador
	 * (`- nota`, `= pensamiento`); el servidor lo canonicaliza. `time` NO se manda:
	 * la resuelve Lumbre con la zona horaria de la cuenta.
	 */
	| { op: 'createBrlEntry'; entryId: string; date: string; entry: string };

/**
 * Una operación de `POST /api/batch`: crear una tarea, mutar una existente, o
 * reenviar VERBATIM una mutación que compuso el servidor.
 *
 * `mutateRaw` existe por el plan de Soplo: el `kind` y el `payload` los escribió
 * Lumbre al planificar y son justo lo que el usuario vio en el preview.
 * Traducirlos a una `MutationOp` del plugin recortaría los campos que el plugin
 * todavía no modela, o sea aplicaría algo distinto de lo que se aprobó.
 */
export type BatchOperation =
	| { type: 'create'; clientTaskId: string; draft: TaskDraft }
	| { type: 'mutate'; op: MutationOp }
	| { type: 'mutateRaw'; taskId: string; kind: string; payload: Record<string, unknown> };

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

/** Una entrada del registro del día, tal y como la sirve `?format=json`. */
export interface BrlEntryRow {
	id: string;
	/** `HH:MM`, o cadena vacía cuando la entrada nació sin hora. */
	time: string;
	/** Texto con su marcador: `- nota` o `= pensamiento`. */
	entry: string;
}

/** Lo que devuelve `GET /api/brl/<date>?format=json`. */
export interface BrlDay {
	/** El día ya resuelto: con `today`, el que decidió el servidor. */
	date: string;
	entries: BrlEntryRow[];
}

/**
 * Una acción del plan de Soplo, tal y como la compuso el servidor. Viaja
 * OPACA a propósito: el plugin no la interpreta, solo la enseña (por su
 * `preview`) y la reenvía. Ver `RawOp` en el repo de Lumbre.
 */
export interface AgentPlanOp {
	op: string;
	[key: string]: unknown;
}

/**
 * Una línea del preview legible. `op` dice de qué tipo es la acción y `text`
 * es la frase que ya resolvió el servidor (con el título de la tarea dentro):
 * el plugin NUNCA resuelve un id a un nombre.
 */
export interface AgentPreviewItem {
	op: string;
	taskId: string;
	text: string;
}

/**
 * La respuesta de `POST /api/agent` en modo previsualización.
 *
 * `plan` y `preview` van en paralelo, MISMO índice: el servidor construye el
 * preview con un `map` sobre el plan. De ahí que una casilla del modal pueda
 * seleccionar la acción por su posición.
 */
export interface AgentPlan {
	plan: AgentPlanOp[];
	preview: AgentPreviewItem[];
	/** Frase de cierre del agente, si la dio. */
	summary: string | null;
	/** El texto se recortó por el tope del servidor (4000 caracteres). */
	truncated: boolean;
}

/** Un adjunto ya subido, tal y como lo devuelve `POST /api/attachments`. */
export interface LumbreAttachment {
	id: string;
	taskId: string | null;
	filename: string;
	mime: string;
	size: number;
}

/** Cuerpo que NO es JSON, con las cabeceras que le tocan. */
interface RawBody {
	body: ArrayBuffer;
	headers: Record<string, string>;
}

/** Tope de ids por petición que impone `GET /api/tasks?ids=` en el servidor. */
const MAX_IDS_PER_REQUEST = 200;

/** Tope de operaciones por lote que impone `POST /api/batch`. */
export const MAX_BATCH_OPS = 200;

/**
 * Tope por fichero de `POST /api/attachments` (`MAX_ATTACHMENT_BYTES` en el
 * repo de Lumbre). El servidor es el autoritativo; aquí se comprueba antes para
 * no subir 30 MB y que los rechace al final.
 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Tope de caracteres del texto que acepta `POST /api/agent` (`MAX_PROMPT_LEN`). */
export const MAX_AGENT_PROMPT_LENGTH = 4000;

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

		const body = { ops: ops.map(batchOpBody) };
		const response = await this.send('POST', '/api/batch', body);
		if (!response.ok) return response;
		return { ok: true, value: batchResultsFrom(response.value) };
	}

	/**
	 * `GET /api/brl/<date>`: la nota del día ENTERA, en Markdown. `date` es
	 * `YYYY-MM-DD` o el literal `today`, que resuelve el servidor con la zona
	 * horaria de la cuenta (así el plugin no tiene que saberla).
	 *
	 * Con el add-on BRL apagado, Lumbre responde 403; aquí sale como
	 * `unauthorized` con `status: 403`, y quien llama lo distingue por el status.
	 */
	async brl(date: string): Promise<LumbreResult<string>> {
		const response = await this.request('GET', `/api/brl/${encodeURIComponent(date)}`);
		if (!response.ok) return response;
		return { ok: true, value: readText(response.value) };
	}

	/**
	 * `GET /api/brl/<date>?format=json`: las mismas entradas CON su id. Es la
	 * relectura de un `createBrlEntry`: el Markdown no lleva ids, así que sin
	 * esta vista no habría forma de confirmar que la entrada existe.
	 */
	async brlJson(date: string): Promise<LumbreResult<BrlDay>> {
		const response = await this.send(
			'GET',
			`/api/brl/${encodeURIComponent(date)}?format=json`,
		);
		if (!response.ok) return response;
		return { ok: true, value: brlDayFrom(response.value, date) };
	}

	/**
	 * `POST /api/agent`: manda un texto a Soplo y devuelve lo que HARÍA con él.
	 *
	 * Corre SIEMPRE en `dryRun` (lo fuerza el endpoint): la respuesta trae el
	 * `plan` y su `preview` legible, y no se ha encolado nada. Aplicar es cosa de
	 * quien llama, que manda las acciones elegidas por `POST /api/batch`.
	 *
	 * Un 403 aquí significa que falta el consentimiento de Soplo en la cuenta
	 * (`requireSoploAgentAccess` en el repo de Lumbre). Sale como `unauthorized`
	 * con `status: 403`, que es lo que distingue ese caso de un token caducado
	 * (401): el endpoint de consentimiento va por cookie de sesión y un plugin
	 * con token Bearer no puede consultarlo.
	 */
	async agent(text: string): Promise<LumbreResult<AgentPlan>> {
		const response = await this.send('POST', '/api/agent', { prompt: text });
		if (!response.ok) return response;
		return { ok: true, value: agentPlanFrom(response.value) };
	}

	/**
	 * `POST /api/attachments?taskId=`: sube un fichero del vault a una tarea.
	 *
	 * Va por la vía de credencial de máquina: cuerpo BINARIO crudo,
	 * `Content-Type: application/octet-stream` SIEMPRE y el mime real en
	 * `x-lumbre-content-type`. Ese desdoble no es cosmético: SvelteKit rechaza con
	 * 403, antes de llegar al handler, un POST cuyo `Content-Type` sea uno de los
	 * cuatro que trata como formulario, y `text/plain` (un `.txt` del vault) es
	 * uno de ellos.
	 *
	 * Por encima de `MAX_ATTACHMENT_BYTES` no se gasta la petición.
	 */
	async uploadAttachment(
		taskId: string,
		filename: string,
		mime: string,
		bytes: ArrayBuffer,
	): Promise<LumbreResult<LumbreAttachment>> {
		if (bytes.byteLength === 0) return { ok: false, reason: 'bad_request' };
		if (bytes.byteLength > MAX_ATTACHMENT_BYTES) return { ok: false, reason: 'too_large' };

		const query = new URLSearchParams({ taskId });
		const response = await this.send('POST', `/api/attachments?${query.toString()}`, undefined, {
			body: bytes,
			headers: {
				'Content-Type': 'application/octet-stream',
				// URL-encodeado y en cabecera, nunca en la query: un nombre de fichero
				// ahí acabaría en los access logs del proxy.
				'x-lumbre-filename': encodeURIComponent(filename),
				'x-lumbre-content-type': mime,
			},
		});
		if (!response.ok) return response;
		return { ok: true, value: attachmentFrom(response.value) };
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
	 *
	 * `raw` es para el único cuerpo que no es JSON: los bytes de un adjunto, con
	 * sus propias cabeceras.
	 */
	private async send(
		method: string,
		path: string,
		body?: Record<string, unknown>,
		raw?: RawBody,
	): Promise<LumbreResult<unknown>> {
		const response = await this.request(method, path, body, raw);
		if (!response.ok) return response;
		return { ok: true, value: readJson(response.value) };
	}

	/** Como `send`, pero devuelve la respuesta entera: la necesita el BRL, que responde Markdown. */
	private async request(
		method: string,
		path: string,
		body?: Record<string, unknown>,
		raw?: RawBody,
	): Promise<LumbreResult<LumbreResponse>> {
		const token = await this.options.getToken();
		if (!token) return { ok: false, reason: 'no_token' };

		const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
		if (body !== undefined) headers['Content-Type'] = 'application/json';
		Object.assign(headers, raw?.headers);

		const payload =
			raw !== undefined ? raw.body : body !== undefined ? JSON.stringify(body) : undefined;

		let response: LumbreResponse;
		try {
			response = await this.options.request({
				url: `${this.origin()}${path}`,
				method,
				headers,
				...(payload !== undefined ? { body: payload } : {}),
				throw: false,
			});
		} catch {
			return { ok: false, reason: 'network' };
		}

		const failure = failureForStatus(response.status);
		if (failure !== null) return failure;
		return { ok: true, value: response };
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
		case 'createBrlEntry':
			// El id de la ENTRADA viaja en `taskId`: esa columna es genérica en el
			// servidor (lo mismo hacen `removeList` o `createList`). `time` no se
			// manda a propósito, la resuelve el encolado con la zona de la cuenta.
			return { taskId: op.entryId, kind: 'createBrlEntry', payload: { date: op.date, entry: op.entry } };
	}
}

/** Una `BatchOperation` del plugin a la op que acepta `POST /api/batch`. */
function batchOpBody(operation: BatchOperation): Record<string, unknown> {
	switch (operation.type) {
		case 'create':
			return { type: 'ingest', task: draftToIngestBody(operation.draft, operation.clientTaskId) };
		case 'mutate':
			return { type: 'mutate', ...translateOp(operation.op) };
		case 'mutateRaw':
			return {
				type: 'mutate',
				taskId: operation.taskId,
				kind: operation.kind,
				payload: operation.payload,
			};
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

/** El cuerpo en texto, o cadena vacía. Mismo cuidado con el getter que `readJson`. */
function readText(response: LumbreResponse): string {
	try {
		return response.text ?? '';
	} catch {
		return '';
	}
}

function asRow(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** El JSON del BRL a `BrlDay`, descartando lo que no sea una entrada. */
function brlDayFrom(raw: unknown, fallbackDate: string): BrlDay {
	const row = asRow(raw);
	const date = typeof row?.['date'] === 'string' ? row['date'] : fallbackDate;
	const rawEntries = row?.['entries'];
	if (!Array.isArray(rawEntries)) return { date, entries: [] };

	const entries: BrlEntryRow[] = [];
	for (const item of rawEntries) {
		const entry = asRow(item);
		const id = entry === null ? null : entry['id'];
		if (typeof id !== 'string' || id.length === 0) continue;
		entries.push({
			id,
			time: typeof entry?.['time'] === 'string' ? entry['time'] : '',
			entry: typeof entry?.['entry'] === 'string' ? entry['entry'] : '',
		});
	}
	return { date, entries };
}

/**
 * La respuesta de `POST /api/agent` a `AgentPlan`. Se descartan las acciones sin
 * su línea de preview: sin texto que enseñar no se puede pedir confirmación, y
 * aplicar a ciegas algo que el usuario no ha visto es justo lo que no se hace.
 */
function agentPlanFrom(raw: unknown): AgentPlan {
	const row = asRow(raw);
	const rawPlan = Array.isArray(row?.['plan']) ? row['plan'] : [];
	const rawPreview = Array.isArray(row?.['preview']) ? row['preview'] : [];

	const plan: AgentPlanOp[] = [];
	const preview: AgentPreviewItem[] = [];
	for (const [index, item] of rawPlan.entries()) {
		const op = asRow(item);
		const line = asRow(rawPreview[index]);
		if (op === null || line === null) continue;
		if (typeof op['op'] !== 'string' || typeof line['text'] !== 'string') continue;
		plan.push(op as AgentPlanOp);
		preview.push({
			op: typeof line['op'] === 'string' ? line['op'] : op['op'],
			taskId: typeof line['taskId'] === 'string' ? line['taskId'] : '',
			text: line['text'],
		});
	}

	return {
		plan,
		preview,
		summary: typeof row?.['summary'] === 'string' ? row['summary'] : null,
		truncated: row?.['truncated'] === true,
	};
}

/** El JSON de `POST /api/attachments` a `LumbreAttachment`. */
function attachmentFrom(raw: unknown): LumbreAttachment {
	const row = asRow(raw);
	return {
		id: typeof row?.['id'] === 'string' ? row['id'] : '',
		taskId: typeof row?.['taskId'] === 'string' ? row['taskId'] : null,
		filename: typeof row?.['filename'] === 'string' ? row['filename'] : '',
		mime: typeof row?.['mime'] === 'string' ? row['mime'] : 'application/octet-stream',
		size: typeof row?.['size'] === 'number' ? row['size'] : 0,
	};
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
		case 'too_large':
			return 'El fichero pasa de 25 MB, el tope de Lumbre.';
		case 'server':
			return status === undefined
				? 'Lumbre respondió con un error.'
				: `Lumbre respondió con un error (${status}).`;
	}
}
