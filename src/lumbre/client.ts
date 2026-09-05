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
 * La API NO tiene un límite global: cada endpoint tiene su propio cubo, con su
 * propia ventana de 60 s (ver `RATE_LIMITS`), así que un 429 es esperable y
 * sale como `rate_limited`.
 *
 * Las LECTURAS llevan además un pestillo compartido: un 401 en cualquiera de
 * ellas apaga las lecturas de todo el cliente hasta que el usuario cambia el
 * token o pide un reintento a mano (ver `readsLocked` y `unlockReads`). Existe
 * porque el servidor aplica un cubo de 20 peticiones/min POR IP a un token
 * inválido ANTES de devolver el 401, y ese cubo lo comparten `/api/tasks`,
 * `/api/sync/flush` y la autenticación del agente.
 *
 * El logger también entra por inyección y es OPCIONAL: sin él el cliente
 * funciona igual, que es lo que hace que los tests que no miran el registro no
 * tengan que montarlo. Lo que se apunta de cada petición es método, ruta SIN
 * origen, status, milisegundos y bytes; los parámetros de la consulta solo en
 * `debug`, y el token en ningún nivel.
 */

import type { Logger } from '../diagnostics/logger';
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
	/**
	 * 404: lo que se pedía no existe, o es de otra cuenta. Los dos casos
	 * responden IGUAL a propósito (el servidor no delata qué ids existen en
	 * cuentas ajenas), y ninguno se arregla reintentando solo.
	 */
	| 'not_found'
	| 'rate_limited'
	| 'network'
	| 'server'
	/** El cuerpo pasa del tope del endpoint. Hoy solo lo produce `uploadAttachment`. */
	| 'too_large';

export interface LumbreFailure {
	ok: false;
	reason: FailureReason;
	status?: number;
	/**
	 * Segundos que pide esperar el servidor (`Retry-After` de un 429), si los
	 * dice. Lumbre no siempre los manda, así que quien reintente necesita su
	 * propia espera por defecto.
	 */
	retryAfterSeconds?: number;
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
	/** Cabeceras de la respuesta, en minúsculas. De aquí sale el `retry-after`. */
	headers?: Record<string, string>;
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
	/** Registro de diagnóstico. Sin él, el cliente no apunta nada. */
	logger?: Logger;
	/** Reloj en epoch ms, inyectable para los tests. */
	now?: () => number;
}

/**
 * Resultado de la última prueba de conexión. Lo guarda el cliente porque es el
 * único sitio por el que pasan todas: el informe de diagnóstico lo lee de aquí.
 */
export interface PingRecord {
	/** ISO 8601 de cuándo se hizo. */
	at: string;
	ok: boolean;
	reason?: FailureReason;
	status?: number;
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
 * Parámetros de `GET /api/tasks?updatedSince=`, la CUARTA forma de la ruta
 * (hermana de `id`/`ids`, no un filtro más del listado). Sin filtro de
 * visibilidad: entran completadas, canceladas, archivadas y subtareas. Ver el
 * JSDoc de `tasksUpdatedSince`.
 */
export interface TasksUpdatedSinceParams {
	/** ISO 8601 con zona. Devuelve lo con `updatedAt` ESTRICTAMENTE posterior. */
	since: string;
	limit?: number;
	notes?: 'full' | 'length' | 'none';
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

/**
 * Estado del consentimiento de Soplo en la cuenta.
 *
 * `unknown` NO es un error que haya que enseñar: significa "no se ha podido
 * saber", y quien pregunta sigue como si no hubiera preguntado. De los tres, es
 * el único que no autoriza a cambiar lo que se hace.
 */
export type AgentConsentState = 'granted' | 'missing' | 'unknown';

/** Un adjunto ya subido, tal y como lo devuelve `POST /api/attachments`. */
export interface LumbreAttachment {
	id: string;
	taskId: string | null;
	filename: string;
	mime: string;
	size: number;
}

/**
 * Destino de `POST /api/list-links`: el enlace de vuelta de una nota del vault
 * hacia una lista de Lumbre. `url` viaja TAL CUAL: el servidor la guarda con un
 * simple `trim`, sin normalizar, así que un `unlink` tiene que mandar la MISMA
 * cadena que mandó el `link` correspondiente.
 */
export interface ListLinkTarget {
	listId: string;
	url: string;
	label: string;
}

/** Una fila de `GET /api/list-links`. Hoy el plugin solo produce las de `kind: 'obsidian'`. */
export interface ListLinkRow {
	id: string;
	listId: string;
	kind: string;
	targetKey: string;
	url: string;
	label: string;
	updatedAt: string;
}

/**
 * Destino de `POST /api/task-links`: el enlace de vuelta de una nota del vault
 * hacia una TAREA de Lumbre. Gemelo de `ListLinkTarget`, con `taskId` en vez de
 * `listId`: mismo trato de la url (viaja TAL CUAL, sin normalizar).
 */
export interface TaskLinkTarget {
	taskId: string;
	url: string;
	label: string;
}

/** Una fila de `GET /api/task-links`. Gemela de `ListLinkRow`. */
export interface TaskLinkRow {
	id: string;
	taskId: string;
	kind: string;
	targetKey: string;
	url: string;
	label: string;
	updatedAt: string;
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
 * Tope de `?limit=` de `GET /api/tasks` (`MAX_LIMIT` en el repo de Lumbre). Su
 * DEFAULT es 200, así que una consulta que no manda `limit` no trae "todo": trae
 * las 200 primeras y no lo dice. Por eso el plugin manda siempre un `limit`, y
 * cuando la respuesta llega justa a este número avisa de que la lectura puede
 * estar recortada (ver `isPartialRead`).
 */
export const MAX_TASKS_LIMIT = 500;

/**
 * `true` si una lectura pudo quedarse corta por el tope del servidor. No hay
 * forma de distinguir "hay exactamente 500" de "hay más y se cortó", así que se
 * avisa en los dos casos: decir de menos aquí es lo único que no se puede
 * arreglar mirando.
 */
export function isPartialRead(count: number): boolean {
	return count >= MAX_TASKS_LIMIT;
}

/**
 * Tope por fichero de `POST /api/attachments` (`MAX_ATTACHMENT_BYTES` en el
 * repo de Lumbre). El servidor es el autoritativo; aquí se comprueba antes para
 * no subir 30 MB y que los rechace al final.
 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Tope de caracteres del texto que acepta `POST /api/agent` (`MAX_PROMPT_LEN`). */
export const MAX_AGENT_PROMPT_LENGTH = 4000;

/** A partir de aquí una petición se apunta como lenta. */
export const SLOW_REQUEST_MS = 3000;

/**
 * Límite de `GET /api/tasks`: peticiones por minuto, POR TOKEN. Medido por la
 * sesión del servidor (lumbre-3a) en el código de Lumbre el 3 sep 2026.
 */
export const TASKS_RATE_LIMIT = 120;

/** Límite de `POST /api/mutations`: independiente del de lecturas. */
export const MUTATIONS_RATE_LIMIT = 60;

/** Límite de `POST /api/sync/flush`: su propio cubo, no el de mutaciones. */
export const SYNC_FLUSH_RATE_LIMIT = 60;

/**
 * Límite de `POST /api/agent`. El servidor tiene dos: 30/min en modo normal y
 * 45/min en modo "live". Este plugin no manda el modo live, así que aquí
 * siempre aplica el conservador (30): usar el de 45 avisaría tarde de un
 * límite que el plugin nunca tiene disponible.
 */
export const AGENT_RATE_LIMIT = 30;

/**
 * Límite para un endpoint que no está en `RATE_LIMITS` (adjuntos, BRL,
 * consentimiento…): no se ha medido su cubo real, así que se usa el mismo
 * número que tenía el contador global de antes, en vez de inventar uno menor
 * que avisaría sin motivo.
 */
export const DEFAULT_RATE_LIMIT = 120;

/** Límite de escrituras en `POST /api/list-links`: cubo PROPIO, no el de `/api/mutations`. */
export const LIST_LINKS_WRITE_RATE_LIMIT = 60;

/** Límite de lecturas en `GET /api/list-links`. */
export const LIST_LINKS_READ_RATE_LIMIT = 120;

/**
 * Límite de escrituras en `POST /api/task-links`: cubo PROPIO, aparte del de
 * `/api/list-links` (medido en el repo de Lumbre: `task-links:<rateKey>` es una
 * clave distinta de `list-links:<rateKey>`).
 */
export const TASK_LINKS_WRITE_RATE_LIMIT = 60;

/** Límite de lecturas en `GET /api/task-links`. */
export const TASK_LINKS_READ_RATE_LIMIT = 120;

/**
 * Proporción del límite de un cubo a partir de la que se avisa. Con el cubo
 * único de antes era 100 de 120 (5/6); se mantiene la misma proporción por
 * endpoint, así que el de `/api/agent` (30) avisa a partir de 25 y no espera a
 * un número absoluto pensado para un cubo seis veces más grande.
 */
export const RATE_WARN_RATIO = 5 / 6;

/** El aviso de un cubo sale a partir de esta cuenta, redondeada. */
export function warnThreshold(limit: number): number {
	return Math.round(limit * RATE_WARN_RATIO);
}

/** El cubo de cada endpoint, por `MÉTODO RUTA` (la ruta ya sin query). */
const RATE_LIMITS: ReadonlyMap<string, number> = new Map([
	['GET /api/tasks', TASKS_RATE_LIMIT],
	['POST /api/mutations', MUTATIONS_RATE_LIMIT],
	['POST /api/sync/flush', SYNC_FLUSH_RATE_LIMIT],
	['POST /api/agent', AGENT_RATE_LIMIT],
	['POST /api/list-links', LIST_LINKS_WRITE_RATE_LIMIT],
	['GET /api/list-links', LIST_LINKS_READ_RATE_LIMIT],
	['POST /api/task-links', TASK_LINKS_WRITE_RATE_LIMIT],
	['GET /api/task-links', TASK_LINKS_READ_RATE_LIMIT],
]);

/** Ventana del contador de peticiones. */
const RATE_WINDOW_MS = 60_000;

/** Un cubo de peticiones por minuto, con su propia ventana y su propio aviso. */
interface RateBucket {
	start: number;
	count: number;
	warned: boolean;
}

export class LumbreClient {
	/**
	 * El `flush()` en vuelo, si lo hay. Un solo flush a la vez: los demás
	 * llamadores esperan a ESE, en vez de gastar una petición cada uno contra un
	 * endpoint que hace exactamente lo mismo y que tiene su propio límite de
	 * 60 llamadas por minuto.
	 */
	private inFlightFlush: Promise<LumbreResult<void>> | null = null;

	/** Última prueba de conexión, para el informe de diagnóstico. */
	private ping_: PingRecord | null = null;

	/** Un cubo por endpoint (`MÉTODO RUTA`), cada uno con su propia ventana. */
	private readonly windows = new Map<string, RateBucket>();

	/**
	 * Pestillo de lecturas: en cuanto una LECTURA recibe un 401 se pone a
	 * `true` y todas las lecturas siguientes (de cualquier superficie, porque
	 * comparten este mismo cliente) fallan sin gastar petición. Un 403 no lo
	 * toca: aquí significa "falta el consentimiento de Soplo", no "token
	 * malo" (ver `agentConsent`). Solo lo apaga `unlockReads`.
	 */
	private readsLocked = false;

	private readonly log: Logger | null;
	private readonly clock: () => number;

	constructor(private readonly options: LumbreClientOptions) {
		this.log = options.logger ?? null;
		this.clock = options.now ?? ((): number => Date.now());
	}

	/** Resultado de la última prueba de conexión, o `null` si no ha habido ninguna. */
	get lastPing(): PingRecord | null {
		return this.ping_;
	}

	/**
	 * Comprueba que el origen y el token valen: pide una tarea y descarta el cuerpo.
	 * Nunca lanza; todo fallo sale como `{ ok: false, reason }`.
	 */
	async ping(): Promise<PingResult> {
		const response = await this.send('GET', '/api/tasks?limit=1&notes=none');
		this.ping_ = {
			at: new Date(this.clock()).toISOString(),
			ok: response.ok,
			...(response.ok ? {} : { reason: response.reason, status: response.status }),
		};
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
		const path = `/api/tasks${suffix ? `?${suffix}` : ''}`;
		const response = await this.gated('GET', path, () => this.send('GET', path));
		if (!response.ok) return response;
		return { ok: true, value: tasksFromApi(response.value) };
	}

	/**
	 * `GET /api/tasks?updatedSince=`: el delta de tareas cambiadas ESTRICTAMENTE
	 * después de `since`. Es la MISMA ruta que `listTasks` (comparte su pestillo
	 * de lecturas y su cubo de 120/min), pero es una forma DISTINTA: sin ningún
	 * filtro de visibilidad (entran completadas, canceladas, archivadas y
	 * subtareas), orden por `updatedAt` ascendente con desempate por `id`, y solo
	 * `notes`/`limit` aplican (`scope`/`days`/`list`/`section`/`includeDone`/
	 * `includeArchived`/`today` se ignoran). Medido en
	 * `src/routes/api/tasks/+server.ts` del repo de Lumbre (`origin/main`, JSDoc
	 * de `updatedSince`, 5 sep 2026). El paginado del delta lo hace
	 * `ChangeFeed` (`src/lumbre/change-feed.ts`), no este método: aquí es una
	 * página suelta.
	 */
	async tasksUpdatedSince(
		params: TasksUpdatedSinceParams,
	): Promise<LumbreResult<LumbreTask[]>> {
		const query = new URLSearchParams({ updatedSince: params.since });
		if (params.limit !== undefined) query.set('limit', String(params.limit));
		if (params.notes !== undefined) query.set('notes', params.notes);

		const path = `/api/tasks?${query.toString()}`;
		const response = await this.gated('GET', path, () => this.send('GET', path));
		if (!response.ok) return response;
		return { ok: true, value: tasksFromApi(response.value) };
	}

	/**
	 * `GET /api/tasks?ids=`: varias tareas de golpe. Trocea por encima del tope
	 * del servidor. Un id sin coincidencia simplemente no sale en el resultado,
	 * igual que en `getTask`.
	 *
	 * Va con `includeArchived=true` por el mismo motivo que `getTask`: aquí se
	 * pregunta por ids CONCRETOS, y archivar en Lumbre es visibilidad, no borrar.
	 */
	async getTasksByIds(ids: string[]): Promise<LumbreResult<LumbreTask[]>> {
		if (ids.length === 0) return { ok: true, value: [] };
		const out: LumbreTask[] = [];
		for (let i = 0; i < ids.length; i += MAX_IDS_PER_REQUEST) {
			const chunk = ids.slice(i, i + MAX_IDS_PER_REQUEST);
			const query = new URLSearchParams({ ids: chunk.join(','), includeArchived: 'true' });
			const path = `/api/tasks?${query.toString()}`;
			const response = await this.gated('GET', path, () => this.send('GET', path));
			if (!response.ok) return response;
			out.push(...tasksFromApi(response.value));
		}
		return { ok: true, value: out };
	}

	/**
	 * `GET /api/tasks?id=`: UNA tarea por id, o `null` si no existe o no es del
	 * usuario del token. Encuentra también subtareas.
	 *
	 * Va SIEMPRE con `includeArchived=true`, que en `?id=` es la única excepción
	 * a los filtros que ese parámetro ignora. Sin él, una tarea archivada
	 * responde `200 []` y no hay forma de distinguirla de una que no existe: la
	 * cola leería "todavía no está" y reintentaría la confirmación para siempre.
	 */
	async getTask(id: string): Promise<LumbreResult<LumbreTask | null>> {
		const query = new URLSearchParams({ id, includeArchived: 'true' });
		const path = `/api/tasks?${query.toString()}`;
		const response = await this.gated('GET', path, () => this.send('GET', path));
		if (!response.ok) return response;
		const [first] = tasksFromApi(response.value);
		return { ok: true, value: first ?? null };
	}

	/** `GET /api/tasks?includeLists=1`: todas las listas vivas, incluidas las vacías. */
	async listLists(): Promise<LumbreResult<LumbreList[]>> {
		const path = '/api/tasks?includeLists=1';
		const response = await this.gated('GET', path, () => this.send('GET', path));
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
		const path = `/api/brl/${encodeURIComponent(date)}`;
		const response = await this.gated('GET', path, () => this.request('GET', path));
		if (!response.ok) return response;
		return { ok: true, value: readText(response.value) };
	}

	/**
	 * `GET /api/brl/<date>?format=json`: las mismas entradas CON su id. Es la
	 * relectura de un `createBrlEntry`: el Markdown no lleva ids, así que sin
	 * esta vista no habría forma de confirmar que la entrada existe.
	 */
	async brlJson(date: string): Promise<LumbreResult<BrlDay>> {
		const path = `/api/brl/${encodeURIComponent(date)}?format=json`;
		const response = await this.gated('GET', path, () => this.send('GET', path));
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
	 * `GET /api/agent/consent`: si la cuenta ha dado ya el consentimiento de Soplo.
	 *
	 * Sirve para no mandarle a Lumbre el texto de una nota que va a rechazar. Nunca
	 * falla: lo que no se sabe sale como `unknown`, y quien pregunta sigue como
	 * hasta ahora (manda y trata el 403 del POST).
	 *
	 * El reparto de los status no es el general del cliente, y por eso está aquí:
	 *
	 * - 200 con `consentedAt` → `granted`; 200 sin él → `missing`.
	 * - 403 → `missing`: el endpoint dice que no lo hay.
	 * - 401 → `unknown`, NO "token malo". Un Lumbre anterior al Bearer en este
	 *   endpoint (solo aceptaba la cookie de sesión) responde 401 a un token
	 *   VÁLIDO, así que leerlo como token caducado sería un aviso falso.
	 * - Red, 429 o 5xx → `unknown` por lo mismo: no se ha llegado a preguntar.
	 */
	async agentConsent(): Promise<AgentConsentState> {
		const response = await this.send('GET', '/api/agent/consent');
		if (response.ok) return consentFrom(response.value);
		if (response.reason === 'unauthorized' && response.status === 403) return 'missing';
		return 'unknown';
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
	 * `POST /api/list-links` con `type: 'link'`: registra en Lumbre el enlace de
	 * vuelta a la nota, para que la vista de proyecto lo enseñe en «Notas
	 * vinculadas». Idempotente: mandar el mismo `url` dos veces no duplica.
	 */
	async listLink(target: ListLinkTarget): Promise<LumbreResult<void>> {
		const response = await this.send('POST', '/api/list-links', listLinkBody('link', target));
		if (!response.ok) return response;
		return { ok: true, value: undefined };
	}

	/**
	 * `POST /api/list-links` con `type: 'unlink'`. `label` viaja igual que en
	 * `listLink` porque el servidor lo valida en los DOS tipos, aunque no lo use
	 * para retirar el vínculo. Un destino que ya no estaba registrado responde
	 * 200 con `removed: false`: es ÉXITO, no motivo para reintentar.
	 */
	async listUnlink(target: ListLinkTarget): Promise<LumbreResult<void>> {
		const response = await this.send('POST', '/api/list-links', listLinkBody('unlink', target));
		if (!response.ok) return response;
		return { ok: true, value: undefined };
	}

	/**
	 * `GET /api/list-links?listId=`: todos los vínculos de esa lista, de
	 * cualquier origen. Es la relectura de `listLink`/`listUnlink`: tras un
	 * `link` la url mandada debe estar; tras un `unlink`, no.
	 */
	async listLinks(listId: string): Promise<LumbreResult<ListLinkRow[]>> {
		const query = new URLSearchParams({ listId });
		const path = `/api/list-links?${query.toString()}`;
		const response = await this.gated('GET', path, () => this.send('GET', path));
		if (!response.ok) return response;
		return { ok: true, value: listLinksFrom(response.value) };
	}

	/**
	 * `POST /api/task-links` con `type: 'link'`: registra en Lumbre el enlace de
	 * vuelta a la nota, para el detalle de tarea («Abrir en Obsidian»). Gemelo de
	 * `listLink`. Una tarea archivada o cancelada responde igualmente 200 (con
	 * `archived: true` en el cuerpo, que aquí no hace falta mirar: el vínculo se
	 * registra igual, es el contrato del endpoint).
	 */
	async taskLink(target: TaskLinkTarget): Promise<LumbreResult<void>> {
		const response = await this.send('POST', '/api/task-links', taskLinkBody('link', target));
		if (!response.ok) return response;
		return { ok: true, value: undefined };
	}

	/**
	 * `POST /api/task-links` con `type: 'unlink'`. Mismo trato que `listUnlink`:
	 * un destino que ya no estaba registrado responde 200, no motivo para
	 * reintentar.
	 */
	async taskUnlink(target: TaskLinkTarget): Promise<LumbreResult<void>> {
		const response = await this.send('POST', '/api/task-links', taskLinkBody('unlink', target));
		if (!response.ok) return response;
		return { ok: true, value: undefined };
	}

	/**
	 * `GET /api/task-links?taskId=`: todos los vínculos de esa tarea. Es la
	 * relectura de `taskLink`/`taskUnlink`, gemela de `listLinks`.
	 */
	async taskLinks(taskId: string): Promise<LumbreResult<TaskLinkRow[]>> {
		const query = new URLSearchParams({ taskId });
		const path = `/api/task-links?${query.toString()}`;
		const response = await this.gated('GET', path, () => this.send('GET', path));
		if (!response.ok) return response;
		return { ok: true, value: taskLinksFrom(response.value) };
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

	/** `true` mientras el pestillo de lecturas está echado. Lo consultan el panel y los bloques para pintar el motivo. */
	get readsAreLocked(): boolean {
		return this.readsLocked;
	}

	/**
	 * Vuelve a permitir lecturas. La llaman los dos sitios que ya existían para
	 * decirle al plugin "prueba otra vez": los ajustes al cambiar el token
	 * (`src/settings.ts`) y el botón "Reintentar" del panel de la nota
	 * (`src/ui/note-tasks-view.ts`). No hace ninguna petición por sí sola: la
	 * siguiente lectura es la que decide si el token vale ahora.
	 */
	unlockReads(source: string): void {
		if (!this.readsLocked) return;
		this.readsLocked = false;
		this.log?.info('Lecturas encendidas de nuevo', { source });
	}

	/**
	 * Envuelve una LECTURA con el pestillo: si está echado, falla sin gastar
	 * petición; si la lectura devuelve un 401, lo echa para todo el cliente. Un
	 * 403 no lo toca, así que `agentConsent` (que trata el 401 de otra forma, ver
	 * su comentario) NO pasa por aquí y llama a `send`/`request` directamente.
	 */
	private async gated<T>(
		method: string,
		path: string,
		run: () => Promise<LumbreResult<T>>,
	): Promise<LumbreResult<T>> {
		if (this.readsLocked) {
			this.log?.debug('Lectura no enviada: el pestillo está echado', {
				method,
				path: routeOf(path),
			});
			return { ok: false, reason: 'unauthorized', status: 401 };
		}

		const result = await run();
		if (!result.ok && result.reason === 'unauthorized' && result.status === 401) {
			this.readsLocked = true;
			this.log?.warn('Lecturas apagadas: el token no vale', {
				method,
				path: routeOf(path),
			});
		}
		return result;
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
		if (!token) {
			this.log?.debug('Petición sin token, no se envía', { method, path: routeOf(path) });
			return { ok: false, reason: 'no_token' };
		}

		const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
		if (body !== undefined) headers['Content-Type'] = 'application/json';
		Object.assign(headers, raw?.headers);

		const payload =
			raw !== undefined ? raw.body : body !== undefined ? JSON.stringify(body) : undefined;

		const startedAt = this.clock();
		this.countRequest(method, path);

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
			// El error de red se traga a propósito: puede llevar la URL entera y no
			// aporta nada más allá de "no se pudo conectar".
			this.logRequest(method, path, startedAt, { reason: 'network' });
			return { ok: false, reason: 'network' };
		}

		const failure = failureForStatus(response.status, response.headers);
		this.logRequest(method, path, startedAt, {
			status: response.status,
			bytes: bytesOf(response),
			...(failure === null ? {} : { reason: failure.reason }),
		});
		if (failure !== null) return failure;
		return { ok: true, value: response };
	}

	/**
	 * UN evento por petición, que es el trato del nivel `info`. Los parámetros de
	 * la consulta solo se apuntan en `debug`: son instrucciones al servidor, no
	 * contenido de una nota, pero engordan el registro sin hacer falta casi nunca.
	 */
	private logRequest(
		method: string,
		path: string,
		startedAt: number,
		outcome: { status?: number; bytes?: number; reason?: FailureReason },
	): void {
		const logger = this.log;
		if (logger === null) return;

		const ms = this.clock() - startedAt;
		const data: Record<string, unknown> = { method, path: routeOf(path), ms };
		if (outcome.status !== undefined) data['status'] = outcome.status;
		if (outcome.bytes !== undefined) data['bytes'] = outcome.bytes;
		if (outcome.reason !== undefined) data['reason'] = describeFailure(outcome.reason, outcome.status);
		if (logger.enabled('debug')) {
			const query = queryOf(path);
			if (query !== null) data['query'] = query;
		}

		if (outcome.reason !== undefined) logger.warn('Petición fallida', data);
		else if (ms >= SLOW_REQUEST_MS) logger.warn('Petición lenta', data);
		else logger.info('Petición', data);
	}

	/**
	 * Cuenta las peticiones por minuto DE ESTE ENDPOINT y avisa al pasar de su
	 * `warnThreshold`. El servidor no tiene un cubo global (cada endpoint tiene
	 * el suyo, ver `RATE_LIMITS`), así que un cubo de 120 no puede prestarle
	 * margen a uno de 30: contarlos juntos escondía un 429 de `/api/agent` bajo
	 * un contador que aún parecía lejos del aviso.
	 */
	private countRequest(method: string, path: string): void {
		const route = routeOf(path);
		const key = `${method} ${route}`;
		const limit = RATE_LIMITS.get(key) ?? DEFAULT_RATE_LIMIT;

		const now = this.clock();
		let bucket = this.windows.get(key);
		if (bucket === undefined || now - bucket.start >= RATE_WINDOW_MS) {
			bucket = { start: now, count: 0, warned: false };
			this.windows.set(key, bucket);
		}
		bucket.count += 1;

		const threshold = warnThreshold(limit);
		if (bucket.count <= threshold || bucket.warned) return;

		bucket.warned = true;
		this.log?.warn('Muchas peticiones en un minuto', {
			count: bucket.count,
			limit: threshold,
			serverLimit: limit,
			method,
			path: route,
		});
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
function failureForStatus(
	status: number,
	headers?: Record<string, string>,
): LumbreFailure | null {
	if (status >= 200 && status < 300) return null;
	if (status === 400) return { ok: false, reason: 'bad_request', status };
	if (status === 401 || status === 403) return { ok: false, reason: 'unauthorized', status };
	if (status === 404) return { ok: false, reason: 'not_found', status };
	if (status === 429) {
		const wait = retryAfterOf(headers);
		return {
			ok: false,
			reason: 'rate_limited',
			status,
			...(wait === null ? {} : { retryAfterSeconds: wait }),
		};
	}
	return { ok: false, reason: 'server', status };
}

/**
 * Los segundos de `Retry-After`, o `null` si no viene o no es un número. La
 * forma de fecha HTTP no se interpreta: Lumbre manda segundos cuando lo manda.
 */
function retryAfterOf(headers?: Record<string, string>): number | null {
	const raw = headers?.['retry-after'] ?? headers?.['Retry-After'];
	if (raw === undefined) return null;
	const seconds = Number.parseInt(raw, 10);
	return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/** La ruta sin sus parámetros: lo que se apunta en el registro por defecto. */
function routeOf(path: string): string {
	const mark = path.indexOf('?');
	return mark < 0 ? path : path.slice(0, mark);
}

/** Los parámetros de la consulta, o `null` si no los hay. Solo se apuntan en `debug`. */
function queryOf(path: string): string | null {
	const mark = path.indexOf('?');
	return mark < 0 ? null : path.slice(mark + 1);
}

/**
 * Bytes del cuerpo de la respuesta, si se pueden saber. El `text` de
 * `requestUrl` es un getter que puede lanzar (una respuesta binaria, un cuerpo
 * vacío), así que se lee dentro de un try como todo lo demás.
 */
function bytesOf(response: LumbreResponse): number | undefined {
	try {
		return response.text?.length;
	} catch {
		return undefined;
	}
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

/**
 * El JSON de `GET /api/agent/consent` a su estado. El cuerpo es
 * `{ consentedAt, version }` y lo que decide es `consentedAt`: una fecha
 * significa dado, `null` significa que la cuenta todavía no lo ha dado.
 */
function consentFrom(raw: unknown): AgentConsentState {
	const consentedAt = asRow(raw)?.['consentedAt'];
	return typeof consentedAt === 'string' && consentedAt.length > 0 ? 'granted' : 'missing';
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

/** El cuerpo de `POST /api/list-links`. `label` va SIEMPRE, incluso en `unlink`: el servidor lo valida en los dos tipos. */
function listLinkBody(type: 'link' | 'unlink', target: ListLinkTarget): Record<string, unknown> {
	return {
		type,
		listId: target.listId,
		target: { kind: 'obsidian', url: target.url, label: target.label },
	};
}

/** El JSON de `GET /api/list-links` a la lista de filas, descartando lo que no tenga forma de vínculo. */
function listLinksFrom(raw: unknown): ListLinkRow[] {
	const row = asRow(raw);
	const rawLinks = row?.['links'];
	if (!Array.isArray(rawLinks)) return [];

	const links: ListLinkRow[] = [];
	for (const item of rawLinks) {
		const link = asRow(item);
		if (link === null) continue;
		const id = link['id'];
		const listId = link['listId'];
		const url = link['url'];
		if (typeof id !== 'string' || typeof listId !== 'string' || typeof url !== 'string') continue;
		links.push({
			id,
			listId,
			kind: typeof link['kind'] === 'string' ? link['kind'] : '',
			targetKey: typeof link['targetKey'] === 'string' ? link['targetKey'] : '',
			url,
			label: typeof link['label'] === 'string' ? link['label'] : '',
			updatedAt: typeof link['updatedAt'] === 'string' ? link['updatedAt'] : '',
		});
	}
	return links;
}

/** El cuerpo de `POST /api/task-links`. Gemelo de `listLinkBody`, con `taskId` en vez de `listId`. */
function taskLinkBody(type: 'link' | 'unlink', target: TaskLinkTarget): Record<string, unknown> {
	return {
		type,
		taskId: target.taskId,
		target: { kind: 'obsidian', url: target.url, label: target.label },
	};
}

/** El JSON de `GET /api/task-links` a la lista de filas. Gemelo de `listLinksFrom`. */
function taskLinksFrom(raw: unknown): TaskLinkRow[] {
	const row = asRow(raw);
	const rawLinks = row?.['links'];
	if (!Array.isArray(rawLinks)) return [];

	const links: TaskLinkRow[] = [];
	for (const item of rawLinks) {
		const link = asRow(item);
		if (link === null) continue;
		const id = link['id'];
		const taskId = link['taskId'];
		const url = link['url'];
		if (typeof id !== 'string' || typeof taskId !== 'string' || typeof url !== 'string') continue;
		links.push({
			id,
			taskId,
			kind: typeof link['kind'] === 'string' ? link['kind'] : '',
			targetKey: typeof link['targetKey'] === 'string' ? link['targetKey'] : '',
			url,
			label: typeof link['label'] === 'string' ? link['label'] : '',
			updatedAt: typeof link['updatedAt'] === 'string' ? link['updatedAt'] : '',
		});
	}
	return links;
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
			return 'El token no vale o ha caducado. Cámbialo en Ajustes → Token personal.';
		case 'bad_request':
			return 'Lumbre rechazó la petición por su contenido.';
		case 'not_found':
			return 'Eso ya no existe en Lumbre.';
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
