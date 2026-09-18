/**
 * Cola durable de escrituras hacia Lumbre.
 *
 * Existe porque un 200 de `/api/ingest` o de `/api/mutations` NO significa que
 * la tarea exista ya: el servidor ENCOLA (`inbound_tasks`, `inbound_mutations`)
 * y materializa al drenar. Así que cada operación se envía y se RELEE: solo
 * cuando la relectura la confirma se da por materializada.
 *
 * El drenaje explícito (`POST /api/sync/flush`, limitado a 60 llamadas por
 * minuto) se gasta con cuentagotas: los tres endpoints de escritura ya llaman a
 * `runHeadlessDrain` antes de responder, así que solo hace falta para las
 * operaciones que quedaron aceptadas SIN confirmar de un flush anterior, y va
 * UNO por flush para todas ellas.
 *
 * De lo releído no se guarda la tarea: la cola vive en `data.json`, que viaja
 * por Obsidian Sync, y las materializadas se podan (7 días, 50 como mucho).
 *
 * No importa `obsidian`: persiste a través de `QueueStorage`, que implementa
 * `PluginStore`.
 *
 * Todo lo que pasa aquí se apunta en el registro de diagnóstico si se le
 * inyecta un logger: cada cambio de estado con su motivo, cada `flush()` con
 * cuántas operaciones movió, y los dos casos que suelen ser la explicación de
 * "no se ha enviado nada" (una operación agotada y una cola llena de
 * operaciones de OTRO dispositivo).
 *
 * Excepción a "siempre se relee": `POST /api/mutations` puede devolver un
 * `outcome` (ver `MutationOutcome` en `client.ts`) que YA es la confirmación,
 * sin gastar una relectura. Lo interpretan `status`, `notes` y `mutation` (ver
 * `outcomeOf`); con `queued` o sin `outcome` (un Lumbre anterior al contrato)
 * se sigue relayendo como siempre, y hay comprobaciones que relean SIEMPRE
 * porque el `outcome` de su `kind` no distingue nada (ver `rereadRequired`).
 */

import type { Logger } from '../diagnostics/logger';
import type {
	BatchOperation,
	LumbreClient,
	FailureReason,
	ListLinkTarget,
	LumbreFailure,
	LumbreResult,
	MutationOp,
	MutationOutcome,
	TaskLinkTarget,
} from './client';
import type { LumbreTask, TaskDraft } from './types';

/**
 * Estados de una operación, los mismos que usa Hebra contra la misma API:
 *
 * - `pending_local`: creada, todavía sin enviar.
 * - `sent`: el servidor la aceptó, pero la relectura aún no la confirma.
 * - `materialized`: releída y confirmada. Fin del camino.
 * - `recoverable_error`: red, 5xx o 429. Se reintenta.
 * - `rejected`: 400/401/403. No se reintenta solo.
 */
export type OperationState =
	| 'pending_local'
	| 'sent'
	| 'materialized'
	| 'recoverable_error'
	| 'rejected';

/** A qué parte del vault pertenece la operación. */
export interface LinkTarget {
	/** Ruta de la nota dentro del vault, con extensión. */
	notePath: string;
	/** Cómo se llama esto en la nota (el texto que vio el usuario). */
	label: string;
	/** Contexto corto alrededor, para poder reconocerlo sin abrir la nota. */
	excerpt: string | null;
}

/** Una op de un lote que Lumbre rechazó, con su posición dentro de `ops`. */
export interface BatchFailedItem {
	/** Posición dentro de `ops`, en base 0, tal y como la devuelve el informe. */
	index: number;
	/** Motivo del servidor. Es una validación suya, nunca texto de la nota. */
	error: string | null;
}

interface OperationBase {
	id: string;
	/**
	 * Dispositivo que creó la operación. `data.json` viaja por Obsidian Sync, así
	 * que la cola se ve desde los dos dispositivos: sin esto, los dos enviarían la
	 * MISMA operación. `flush()` solo procesa las de este dispositivo.
	 */
	deviceId: string;
	state: OperationState;
	/** Intentos FALLIDOS acumulados. A partir de `MAX_ATTEMPTS` solo se reintenta a mano. */
	attempts: number;
	/** Motivo del último fallo, en castellano. Nunca lleva el token. */
	error: string | null;
	createdAt: string;
	updatedAt: string;
	/**
	 * Cuándo aceptó el servidor el envío, o `null` si todavía no lo aceptó. Es lo
	 * que impide REENVIAR: una operación con `sentAt` solo se vuelve a comprobar
	 * releyendo, nunca se manda otra vez.
	 */
	sentAt: string | null;
	/**
	 * Cuándo la confirmó la relectura. Es lo ÚNICO que se guarda de lo leído: la
	 * tarea entera viajaría por Obsidian Sync dentro de `data.json`, con su título
	 * y sus notas dentro. Ausente en una cola escrita por una versión anterior.
	 */
	materializedAt?: string | null;
	/**
	 * A partir de cuándo se puede volver a intentar, o `null` si ya. Lo pone un
	 * 429: reintentar antes solo gasta el cupo que el servidor acaba de negar.
	 */
	nextAttemptAt?: string | null;
}

export type CreateOperation = OperationBase & {
	kind: 'create';
	/** Id que TENDRÁ la tarea, generado aquí. Hace idempotente el reenvío. */
	clientTaskId: string;
	draft: TaskDraft;
	target: LinkTarget;
};

export type StatusOperation = OperationBase & {
	kind: 'status';
	taskId: string;
	done: boolean;
	target: LinkTarget;
};

/**
 * Una entrada NUEVA del registro del día (BRL).
 *
 * El id lo fija el plugin (`entryId`) y es el que tendrá la entrada, igual que
 * el `clientTaskId` de un `create`: reenviarla no crea una segunda. La
 * relectura es distinta, eso sí, porque una entrada del BRL no es una tarea y
 * `getTask` no la encuentra: se relee `GET /api/brl/<date>?format=json` y se
 * busca el id ahí.
 */
export type BrlOperation = OperationBase & {
	kind: 'brl';
	entryId: string;
	/** Día del registro, `YYYY-MM-DD` o el literal `today`. */
	date: string;
	/** Texto con su marcador: `- nota` o `= pensamiento`. */
	entry: string;
	target: LinkTarget;
};

/**
 * Un lote de operaciones aprobado por el usuario, hoy el plan de Soplo.
 *
 * Se envía por `POST /api/batch` (una petición, un drenaje) y se confirma
 * releyendo las tareas CREADAS por `ids=`. Las mutaciones del lote no se
 * releen: tocan tareas que ya existían y no hay un "existe / no existe" que
 * comprobar sin saber qué esperaba cada `kind`.
 */
export type BatchQueuedOperation = OperationBase & {
	kind: 'batch';
	ops: BatchOperation[];
	/** Ids de las tareas que el lote CREA. Son los que se releen. */
	createdTaskIds: string[];
	target: LinkTarget;
	/**
	 * Las ops que Lumbre rechazó dentro de un lote que SÍ aceptó. Ausente en una
	 * cola escrita por una versión anterior; vacío significa que entraron todas.
	 */
	failedItems?: BatchFailedItem[];
};

/**
 * Un enlace de vuelta nota ↔ lista por `POST /api/list-links`: registrarlo
 * (`type: 'link'`) o retirarlo (`type: 'unlink'`).
 *
 * `url` es la EXACTA que se mandó (o se va a mandar): el servidor la guarda tal
 * cual llega, así que un `unlink` con una url reconstruida de otra forma no
 * casaría con la registrada y respondería 200 con `removed: false` sin haber
 * quitado nada. `main.ts` guarda esa misma cadena en `NoteListLinkStore` y es
 * de ahí de donde sale para encolar el `unlink`.
 */
export type ListLinkQueuedOperation = OperationBase & {
	kind: 'listLink';
	type: 'link' | 'unlink';
	listId: string;
	url: string;
	label: string;
	target: LinkTarget;
};

/**
 * La foto de una nota (o de su selección) guardada dentro de `notes` de una
 * tarea ya existente. `notes` es el texto FINAL que hay que mandar (lo
 * existente más la foto nueva, ya compuesto por
 * `src/notes/note-snapshot.ts`): `POST /api/mutations` con `op: 'update'`
 * REEMPLAZA el campo entero, así que no hay delta que mandar, solo el
 * resultado.
 *
 * No va por `enqueueBatch`: un lote sin altas se confirma SOLO con el informe
 * del `POST /api/batch` (ver `expectedTaskIds`, que con `createdTaskIds: []`
 * da `'confirmed'` sin releer nada), y aquí hace falta la garantía fuerte de
 * la cola, releer de verdad y comprobar que la cabecera de la foto llegó.
 *
 * `notes` SÍ se guarda en la operación pendiente (a diferencia de lo RELEÍDO,
 * que nunca se guarda): es lo que hay que mandar, igual que `draft` en un
 * `create` o `entry` en un `brl`. Viaja por `data.json` (Obsidian Sync) solo
 * mientras está sin materializar; la poda (`pruneQueue`) se la lleva igual que
 * a cualquier otra operación terminada.
 */
export type NotesQueuedOperation = OperationBase & {
	kind: 'notes';
	taskId: string;
	/** El texto FINAL de `notes`, ya compuesto. */
	notes: string;
	/** La cabecera de ESTA foto, para reconocerla al releer sin guardar el texto. */
	header: string;
	target: LinkTarget;
};

/**
 * Un enlace de vuelta nota ↔ TAREA por `POST /api/task-links`: registrarlo
 * (`type: 'link'`) o retirarlo (`type: 'unlink'`). Gemelo de
 * `ListLinkQueuedOperation`, con `taskId` en vez de `listId`.
 *
 * Es un `kind` NUEVO y no una generalización de `listLink`: una cola YA
 * escrita en `data.json` (desde la 0.1.10) tiene operaciones con
 * `kind: 'listLink'` que hay que seguir pudiendo leer, y fusionar los dos en un
 * único `kind` con un `target` discriminado habría exigido traducir esas
 * operaciones ya persistidas al vuelo. El precio es algo de código repetido
 * entre los dos `kind`; la ganancia es que ninguno de los dos cambia de forma.
 */
export type TaskLinkQueuedOperation = OperationBase & {
	kind: 'taskLink';
	type: 'link' | 'unlink';
	taskId: string;
	url: string;
	label: string;
	target: LinkTarget;
};

/**
 * Qué hay que RELEER para confirmar una mutación genérica, y qué comparar en lo
 * releído.
 *
 * Viaja PERSISTIDO dentro de la operación, junto a la op, y no se deduce de la
 * op al vuelo a propósito: una cola ya escrita en `data.json` tiene que poder
 * confirmarse con el criterio que tenía cuando se encoló, no con el que una
 * versión posterior del plugin deduciría del mismo payload. Es también el
 * contrato que usan las superficies que encolan: quien llama elige la
 * comprobación, y la cola solo la ejecuta.
 *
 * Un caso por comprobación, nunca uno por `op`: varias ops comparten criterio
 * (`cancel` y `restore` miran las dos `cancelledAt`) y una misma op puede
 * confirmarse de dos formas según cómo se pidió (`moveToList` por id o por
 * nombre de lista).
 */
export type MutationCheck =
	/**
	 * No hay nada que releer con un token personal: hoy solo `registerHabit`, que
	 * escribe en el store de hábitos y la API no expone por ninguna lectura del
	 * plugin. Se confirma SOLO por `outcome`: `applied` o `noop` la materializan,
	 * y un `queued` (o un Lumbre que no manda `outcome`) la deja en
	 * `recoverable_error` para reintento A MANO, porque volver a enviarla sola
	 * podría apuntar la ocurrencia dos veces.
	 */
	| { check: 'none' }
	/**
	 * Un campo de la tarea que se compara por VALOR exacto contra lo que se pidió.
	 * Hoy `date`, que es lo que mueve un `reschedule`. `expected: null` es "la
	 * tarea tiene que quedarse sin fecha".
	 */
	| { check: 'taskField'; taskId: string; field: 'date'; expected: string | null }
	/**
	 * Un campo de la tarea que solo se compara por PRESENCIA, porque su valor lo
	 * decide el servidor y el plugin no puede predecirlo: `cancelledAt` lleva la
	 * marca de tiempo de la cancelación. `set: true` confirma un `cancel`,
	 * `set: false` un `restore`.
	 */
	| { check: 'taskFieldSet'; taskId: string; field: 'cancelledAt'; set: boolean }
	/**
	 * La lista (`moveToList`) o la sección (`setSection`) de la tarea. `by` dice
	 * si `expected` es un id o un NOMBRE, que es la misma distinción que acepta el
	 * endpoint: `moveToList` va por `listId` o por `list`, y `setSection` siempre
	 * por nombre. `expected: null` es "la tarea tiene que quedarse sin lista" (o
	 * sin sección).
	 */
	| {
			check: 'taskRef';
			taskId: string;
			field: 'list' | 'section';
			by: 'id' | 'name';
			expected: string | null;
	  }
	/**
	 * Las subtareas que un `addSubtask` tenía que añadir al padre. Se relee el
	 * PADRE (`getTask` solo sirve `subtasks` en el lookup por id) y se confirma
	 * cuando todos los títulos están entre las suyas.
	 *
	 * Los títulos se comparan recortados por los dos lados, porque el servidor
	 * recorta los que recibe. También los TRUNCA a su tope, así que un título más
	 * largo que ese tope no se confirmaría nunca: hay que guardar aquí el texto
	 * que se espera LEER, no necesariamente el que se mandó.
	 */
	| { check: 'subtasksInclude'; parentId: string; titles: string[] }
	/**
	 * Una subtarea completada o reabierta (`completeSubtask`). Se relee el PADRE,
	 * porque una subtarea no aparece en un `getTask` por su propio id, y se
	 * compara el `done` de la que lleva `subtaskId`.
	 */
	| { check: 'subtaskDone'; parentId: string; subtaskId: string; done: boolean }
	/**
	 * Una lista que tenía que quedar creada (`createList`). Se relee el catálogo
	 * (`GET /api/tasks?includeLists=1`, que trae también las vacías) y se confirma
	 * si el id aparece.
	 */
	| { check: 'listExists'; listId: string }
	/**
	 * La nota de una lista (`setListNotes`). Se confirma buscando la cabecera de
	 * la foto dentro de la nota releída, igual que hace el `kind` `notes` con una
	 * tarea. `header: null` es el caso de BORRAR la nota: se confirma cuando la
	 * lista está y su nota ya no.
	 */
	| { check: 'listNotes'; listId: string; header: string | null }
	/**
	 * Una entrada del BRL editada (`updateBrlEntry`) o borrada
	 * (`removeBrlEntry`). Se relee `GET /api/brl/<date>?format=json` y se busca el
	 * id: `entry` con texto pide que la entrada ESTÉ y lo lleve; `entry: null`
	 * pide que no esté.
	 *
	 * Aquí la relectura NO es un respaldo, es OBLIGATORIA: el materializador de
	 * Lumbre devuelve `outcome: 'applied'` para los tres `kind`s del BRL exista o
	 * no la entrada (medido en `src/lib/sync/inbound-materialize.ts` de su
	 * `origin/main`: `applyInboundBrlMutation` y `return 'applied'`, sin
	 * comprobar nada). O sea que el `outcome` no distingue "editada" de "no
	 * estaba", y creerlo daría por materializado un cambio que no ocurrió.
	 */
	| { check: 'brlEntry'; date: string; entryId: string; entry: string | null };

/**
 * Una mutación cualquiera de `POST /api/mutations`, con su comprobación.
 *
 * Es UN `kind` para TODAS las mutaciones, apunten a una tarea o no
 * (`createList`, `setListNotes`, `updateBrlEntry`, `removeBrlEntry`,
 * `registerHabit`): lo que cambia entre ellas es el payload, que ya discrimina
 * `MutationOp`, y la relectura, que discrimina `check`. Un `kind` por op
 * multiplicaría el mismo camino sin añadir nada.
 *
 * `op` viaja VERBATIM, igual que las mutaciones del plan de Soplo en un
 * `mutateRaw`: quien encola compone el payload y la cola no lo reinterpreta.
 * Y `check` viaja al lado porque la relectura tampoco se deduce de la op (ver
 * el JSDoc de `MutationCheck`).
 *
 * Idempotencia: la mayoría de las mutaciones se pueden reenviar sin daño
 * (reescribir el mismo `notes`, mover a la lista en la que ya está), pero
 * `addSubtask` NO, y `registerHabit` tampoco. Como en el `kind` `batch`, una
 * operación con `sentAt` se RELEE y nunca se reenvía, así que no hay que
 * distinguirlas.
 */
export type MutationQueuedOperation = OperationBase & {
	kind: 'mutation';
	/** La mutación tal cual se manda a `POST /api/mutations`. */
	op: MutationOp;
	/** Qué releer y qué comparar cuando el `outcome` no basta. */
	check: MutationCheck;
	target: LinkTarget;
};

export type QueuedOperation =
	| CreateOperation
	| StatusOperation
	| BrlOperation
	| BatchQueuedOperation
	| ListLinkQueuedOperation
	| NotesQueuedOperation
	| TaskLinkQueuedOperation
	| MutationQueuedOperation;

/** Lo que la cola necesita del almacén del plugin. Lo cumple `PluginStore`. */
export interface QueueStorage {
	/** Id de ESTA instalación. */
	readonly deviceId: string;
	readQueue(): QueuedOperation[];
	writeQueue(operations: QueuedOperation[]): Promise<void>;
}

export interface OperationQueueOptions {
	client: Pick<
		LumbreClient,
		| 'createTask'
		| 'mutate'
		| 'flush'
		| 'getTask'
		| 'getTasksByIds'
		| 'batch'
		| 'brlJson'
		| 'listLists'
		| 'listNotes'
		| 'listLink'
		| 'listUnlink'
		| 'listLinks'
		| 'taskLink'
		| 'taskUnlink'
		| 'taskLinks'
	>;
	storage: QueueStorage;
	/** Espera entre la primera relectura vacía y la segunda. Inyectable para los tests. */
	sleep?: (ms: number) => Promise<void>;
	/** Reloj, inyectable para los tests. */
	now?: () => Date;
	/**
	 * Se llama cuando una operación pasa a `materialized`, o sea cuando la
	 * relectura confirma que Lumbre ya la tiene. Es el único momento en que un
	 * cambio deja de ser una promesa: de ahí cuelga la invalidación de la caché de
	 * los bloques, para que la casilla se asiente en todos a la vez.
	 */
	onMaterialized?: (operation: QueuedOperation) => void;
	/** Registro de diagnóstico. Sin él, la cola no apunta nada. */
	logger?: Logger;
}

/** Intentos fallidos tras los cuales la operación solo se reintenta a mano. */
export const MAX_ATTEMPTS = 5;

/**
 * Fallos recuperables a partir de los cuales el aviso sube a `warn`: uno es
 * ruido de red, tres seguidos ya es un patrón que hay que mirar.
 */
export const WARN_AFTER_ATTEMPTS = 3;

/** Espera antes de la SEGUNDA relectura, cuando la primera no encuentra la tarea. */
export const REREAD_DELAY_MS = 1000;

/**
 * Espera tras un 429 cuando el servidor no dice cuánta (`Retry-After`). Lumbre
 * limita `POST /api/sync/flush` a 60 llamadas por minuto, así que medio minuto
 * es lo que hace falta para que la ventana se renueve.
 */
export const RATE_LIMIT_BACKOFF_MS = 30_000;

/**
 * Cuánto se conserva una operación ya materializada. La cola vive en
 * `data.json`, que viaja por Obsidian Sync: sin poda crece sin techo con el
 * historial de todo lo que se ha enviado nunca.
 */
export const MATERIALIZED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Y cuántas se conservan como mucho, por recientes que sean. */
export const MAX_MATERIALIZED = 50;

/**
 * Motivos que NO se reintentan: el servidor ya ha dicho que no.
 *
 * `not_found` (404) es de la COLA, no de un endpoint: cualquier operación de
 * cualquier `kind` que reciba un 404 se queda `rejected` sin reintento. Hoy el
 * único endpoint de escritura de la cola que de verdad puede devolver 404 es
 * `POST /api/list-links` (lista de otra cuenta o borrada; medido endpoint por
 * endpoint en el repo de Lumbre: `/api/ingest`, `/api/mutations` y
 * `/api/batch` no lo emiten en ningún caso legítimo). Si algún día se añade un
 * `kind` nuevo cuyo endpoint pueda dar un 404 TRANSITORIO (por ejemplo, una
 * carrera donde el recurso aún no se ha propagado), esa operación quedaría
 * `rejected` sin más intentos: revisar aquí antes de asumir lo contrario.
 */
const PERMANENT_REASONS: ReadonlySet<FailureReason> = new Set<FailureReason>([
	'unauthorized',
	'bad_request',
	'not_found',
]);

export class OperationQueue {
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly now: () => Date;
	private readonly log: Logger | null;
	private inFlight: Promise<void> | null = null;
	/** El flush de SEGUIMIENTO, el que recogerá lo encolado durante el que corre. */
	private queuedFlush: Promise<void> | null = null;

	constructor(private readonly options: OperationQueueOptions) {
		this.log = options.logger ?? null;
		// `window.setTimeout` y no `setTimeout` a secas: en una ventana emergente de
		// Obsidian el temporizador tiene que ser el de ESA ventana. Los tests
		// inyectan el suyo, así que esta rama no corre fuera del plugin.
		this.sleep =
			options.sleep ??
			((ms): Promise<void> =>
				new Promise((resolve) => {
					window.setTimeout(resolve, ms);
				}));
		this.now = options.now ?? (() => new Date());
	}

	/** Encola crear una tarea. El id se fija AQUÍ y no cambia por muchos reintentos. */
	async enqueueCreate(draft: TaskDraft, target: LinkTarget): Promise<CreateOperation> {
		const operation: CreateOperation = {
			...this.newBase(),
			kind: 'create',
			clientTaskId: crypto.randomUUID(),
			draft,
			target,
		};
		await this.append(operation);
		this.logEnqueued(operation, { listId: draft.listId ?? null, subtasks: draft.subtasks?.length ?? 0 });
		return operation;
	}

	/** Encola completar (o descompletar) una tarea que ya existe. */
	async enqueueStatus(taskId: string, done: boolean, target: LinkTarget): Promise<StatusOperation> {
		const operation: StatusOperation = {
			...this.newBase(),
			kind: 'status',
			taskId,
			done,
			target,
		};
		await this.append(operation);
		this.logEnqueued(operation, { taskId, done });
		return operation;
	}

	/**
	 * Encola una entrada nueva del registro del día. El id se fija AQUÍ, así que
	 * reintentar no duplica la entrada.
	 */
	async enqueueBrl(date: string, entry: string, target: LinkTarget): Promise<BrlOperation> {
		const operation: BrlOperation = {
			...this.newBase(),
			kind: 'brl',
			entryId: crypto.randomUUID(),
			date,
			entry,
			target,
		};
		await this.append(operation);
		// El TEXTO de la entrada no se apunta: es lo que el usuario ha escrito.
		this.logEnqueued(operation, { date, length: entry.length });
		return operation;
	}

	/**
	 * Encola un lote ya aprobado por el usuario. `createdTaskIds` son los ids de
	 * las tareas que el lote crea, que es lo que se relee para confirmarlo.
	 */
	async enqueueBatch(
		ops: BatchOperation[],
		createdTaskIds: string[],
		target: LinkTarget,
	): Promise<BatchQueuedOperation> {
		const operation: BatchQueuedOperation = {
			...this.newBase(),
			kind: 'batch',
			ops,
			createdTaskIds,
			target,
			failedItems: [],
		};
		await this.append(operation);
		this.logEnqueued(operation, { ops: ops.length, creates: createdTaskIds.length });
		return operation;
	}

	/**
	 * Encola un enlace de vuelta nota ↔ lista (`type: 'link'`) o su retirada
	 * (`type: 'unlink'`). `url` y `label` viajan tal cual: es lo que se manda a
	 * `POST /api/list-links`, y en un `unlink` tienen que ser la MISMA cadena que
	 * se mandó en el `link` (ver el JSDoc de `ListLinkQueuedOperation`).
	 */
	async enqueueListLink(
		type: 'link' | 'unlink',
		listId: string,
		url: string,
		label: string,
		target: LinkTarget,
	): Promise<ListLinkQueuedOperation> {
		const operation: ListLinkQueuedOperation = {
			...this.newBase(),
			kind: 'listLink',
			type,
			listId,
			url,
			label,
			target,
		};
		await this.append(operation);
		this.logEnqueued(operation, { type, listId });
		return operation;
	}

	/**
	 * Encola la foto de una nota dentro de `notes` de una tarea que ya existe.
	 * `notes` es el texto FINAL (lo existente más la foto), y `header` es la
	 * cabecera de ESTA foto para poder reconocerla al releer. No lleva id propio
	 * que la haga idempotente: es una mutación sobre un campo, no una creación, y
	 * reenviarla manda el mismo `notes` de nuevo, sin duplicar nada.
	 */
	async enqueueNotes(
		taskId: string,
		notes: string,
		header: string,
		target: LinkTarget,
	): Promise<NotesQueuedOperation> {
		const operation: NotesQueuedOperation = {
			...this.newBase(),
			kind: 'notes',
			taskId,
			notes,
			header,
			target,
		};
		await this.append(operation);
		// El TEXTO no se apunta: es el contenido de la nota. Solo cuánto ocupa.
		this.logEnqueued(operation, { taskId, length: notes.length });
		return operation;
	}

	/**
	 * Encola un enlace de vuelta nota ↔ TAREA (`type: 'link'`) o su retirada
	 * (`type: 'unlink'`) por `POST /api/task-links`. Gemelo de
	 * `enqueueListLink`: mismas garantías sobre la url exacta (ver el JSDoc de
	 * `TaskLinkQueuedOperation` sobre por qué es un `kind` propio).
	 */
	async enqueueTaskLink(
		type: 'link' | 'unlink',
		taskId: string,
		url: string,
		label: string,
		target: LinkTarget,
	): Promise<TaskLinkQueuedOperation> {
		const operation: TaskLinkQueuedOperation = {
			...this.newBase(),
			kind: 'taskLink',
			type,
			taskId,
			url,
			label,
			target,
		};
		await this.append(operation);
		this.logEnqueued(operation, { type, taskId });
		return operation;
	}

	/**
	 * Encola una mutación cualquiera de `POST /api/mutations` con la comprobación
	 * que la confirma.
	 *
	 * `op` se guarda VERBATIM y `check` dice qué releer si el `outcome` no basta:
	 * las dos cosas viajan persistidas en la operación, así que el criterio de
	 * confirmación es el que eligió quien encoló (ver los JSDoc de
	 * `MutationQueuedOperation` y `MutationCheck`).
	 *
	 * Ojo con las ops que NO son idempotentes (`addSubtask`, `registerHabit`): la
	 * cola no las reenvía nunca una vez aceptadas, pero encolar DOS veces la misma
	 * sí las aplica dos veces. Eso es cosa de quien llama, como en cualquier otro
	 * `kind`.
	 */
	async enqueueMutation(
		op: MutationOp,
		check: MutationCheck,
		target: LinkTarget,
	): Promise<MutationQueuedOperation> {
		const operation: MutationQueuedOperation = {
			...this.newBase(),
			kind: 'mutation',
			op,
			check,
			target,
		};
		await this.append(operation);
		// Solo los DISCRIMINANTES: el payload de la op y lo que se compara en la
		// relectura llevan texto del usuario (nombres de lista, notas, entradas del
		// BRL, títulos de subtarea) y eso no entra en el registro.
		this.logEnqueued(operation, { op: op.op, check: check.check });
		return operation;
	}

	/**
	 * Operaciones de ESTE dispositivo que todavía no están materializadas.
	 * Incluye las rechazadas y las agotadas a propósito: son justo las que una
	 * interfaz tiene que enseñar para que el usuario decida.
	 */
	pending(): QueuedOperation[] {
		return this.mine().filter((operation) => operation.state !== 'materialized');
	}

	/**
	 * TODAS las operaciones de este dispositivo, materializadas incluidas. Lo lee
	 * el informe de diagnóstico, que necesita el recuento por estado y las
	 * últimas diez tal cual están.
	 */
	snapshot(): QueuedOperation[] {
		return this.mine();
	}

	/**
	 * Devuelve una operación parada al camino: pone los intentos a cero y borra el
	 * motivo del fallo. Si el servidor ya la había aceptado (`sentAt`), vuelve a
	 * `sent` para que el siguiente `flush()` la RELEA en vez de reenviarla.
	 */
	async retry(id: string): Promise<void> {
		const operations = this.read();
		const operation = operations.find((candidate) => candidate.id === id);
		if (operation === undefined) return;
		const from = operation.state;
		operation.attempts = 0;
		operation.error = null;
		// Reintentar a mano es una orden del usuario: se salta la espera del 429.
		operation.nextAttemptAt = null;
		operation.state = operation.sentAt !== null ? 'sent' : 'pending_local';
		operation.updatedAt = this.stamp();
		await this.write(operations);
		this.logTransition(operation, from, 'Reintento a mano');
	}

	/** Saca una operación de la cola. No deshace nada en Lumbre. */
	async discard(id: string): Promise<void> {
		const operations = this.read();
		const remaining = operations.filter((operation) => operation.id !== id);
		if (remaining.length === operations.length) return;
		await this.write(remaining);
		this.log?.info('Operación descartada de la cola', { id, remaining: remaining.length });
	}

	/**
	 * Operaciones de este dispositivo que este flush intentaría mover: ni las
	 * terminadas, ni las agotadas, ni las que están esperando tras un 429. Es lo
	 * que mira el drenaje periódico para no llamar a `flush()` sin nada que hacer.
	 */
	actionable(): QueuedOperation[] {
		const now = this.now();
		return this.mine().filter((operation) => isActionable(operation, now));
	}

	/**
	 * Procesa la cola en orden, una a una. Un solo flush en vuelo, y UNO de
	 * seguimiento encadenado detrás: `runFlush` congela la lista de operaciones al
	 * empezar, así que lo que se encole mientras tanto se quedaría sin enviar, sin
	 * aviso y sin nadie que lo volviera a intentar. La ranura de seguimiento es
	 * UNA: quien llegue mientras ya hay uno encadenado espera a ese mismo.
	 */
	async flush(): Promise<void> {
		const running = this.inFlight;
		if (running === null) return this.start();

		const queued = this.queuedFlush;
		if (queued !== null) return queued;

		const clear = (): void => {
			this.queuedFlush = null;
		};
		const chained = running.then(
			() => {
				clear();
				return this.flush();
			},
			() => {
				clear();
				return this.flush();
			},
		);
		this.queuedFlush = chained;
		return chained;
	}

	private async start(): Promise<void> {
		const started = this.runFlush();
		this.inFlight = started;
		try {
			await started;
		} finally {
			if (this.inFlight === started) this.inFlight = null;
		}
	}

	private async runFlush(): Promise<void> {
		const startedAt = this.now().getTime();
		const all = this.read();
		const mine = all.filter((operation) => operation.deviceId === this.options.storage.deviceId);
		const foreign = all.length - mine.length;
		if (foreign > 0) {
			// Con el id NO: identifica al otro dispositivo y no hace falta para nada.
			this.log?.warn('Operaciones de otro dispositivo, se saltan', { count: foreign });
		}

		const actionable = mine.filter((operation) => isActionable(operation, this.now()));
		this.log?.debug('Flush empezado', { actionable: actionable.length, queued: all.length });

		// UN drenaje por flush como mucho, compartido por todas las operaciones que
		// ya estaban aceptadas. `POST /api/sync/flush` está limitado a 60 llamadas
		// por minuto: una por operación se come el cupo con una cola normalita.
		const drain = onceDrain(() => this.options.client.flush());

		let processed = 0;
		let stopped: string | null = null;
		for (const operation of actionable) {
			const outcome = await this.process(operation, drain);
			processed += 1;
			// Sin token no ha llegado a haber petición: no se gasta un intento ni se
			// marca nada, la cola se queda tal cual hasta que haya token.
			// Con 429 se para el flush entero: seguir con las demás solo gasta cupo
			// contra un servidor que acaba de decir que espere.
			if (outcome !== null) {
				stopped = outcome;
				break;
			}
		}

		this.log?.info('Flush terminado', {
			processed,
			pending: this.pending().length,
			ms: this.now().getTime() - startedAt,
			...(stopped === null ? {} : { stopped }),
		});
	}

	/** Devuelve por qué se ha parado el flush, o `null` si se puede seguir. */
	private async process(
		operation: QueuedOperation,
		drain: () => Promise<LumbreResult<void>>,
	): Promise<'no_token' | 'rate_limited' | null> {
		if (operation.sentAt === null) {
			const sent = await this.send(operation);
			if (!sent.ok) return this.recordFailure(operation, sent);
			operation.sentAt = this.stamp();
			operation.state = 'sent';
			operation.error = null;
			operation.nextAttemptAt = null;
			await this.persist(operation);
			this.logTransition(operation, 'pending_local', 'Lumbre aceptó el envío');
			this.logBatchFailures(operation);
			// Aquí NO se drena: `/api/ingest`, `/api/mutations` y `/api/batch` ya
			// llaman a `runHeadlessDrain` antes de responder, así que lo recién
			// aceptado ya está materializándose.

			// `outcome` es la evidencia FUERTE que trae el propio envío, y solo la
			// interpretan `status` y `notes` (las dos únicas que mandan por
			// `mutate`): con `applied`/`noop` no hace falta releer, y con
			// `not-found` releer no cambiaría nada (la tarea ya no está). `queued` o
			// ausente (un Lumbre anterior al contrato) caen al camino de siempre,
			// abajo.
			const outcome = outcomeOf(operation, sent.value);
			if (outcome === 'applied' || outcome === 'noop') {
				await this.materializeByOutcome(operation, outcome);
				return null;
			}
			if (outcome === 'not-found') {
				await this.rejectByOutcome(operation);
				return null;
			}
		} else {
			// Ya venía aceptada de un flush anterior: ahí sí puede quedar algo sin
			// drenar. Es el único caso que gasta `POST /api/sync/flush`, y lo comparte
			// con las demás operaciones de este mismo flush.
			const flushed = await drain();
			if (!flushed.ok) return this.recordFailure(operation, flushed);
		}

		const confirmed = await this.confirm(operation);
		if (confirmed === 'unverifiable') {
			// Nada que releer y el `outcome` no la confirmó: se aparca para que el
			// usuario decida (ver `parkUnverifiable` y el caso `none` de
			// `MutationCheck`).
			await this.parkUnverifiable(operation);
			return null;
		}
		if (confirmed !== 'missing' && confirmed !== 'materialized') {
			return this.recordFailure(operation, confirmed);
		}

		if (confirmed === 'missing') {
			// El servidor aceptó el envío pero la tarea todavía no aparece. Se queda
			// en `sent` con un intento más: el siguiente flush la vuelve a comprobar
			// SIN reenviar nada, porque el id ya está fijado. Al agotar los intentos
			// deja de reintentarse sola: si no, una tarea archivada en Lumbre (o
			// borrada) se reintentaría para siempre.
			const from = operation.state;
			operation.attempts += 1;
			const exhausted = operation.attempts >= MAX_ATTEMPTS;
			operation.state = exhausted ? 'recoverable_error' : 'sent';
			operation.error = exhausted
				? `Lumbre aceptó la operación pero no la confirma tras ${MAX_ATTEMPTS} relecturas.`
				: 'Lumbre aceptó la operación pero todavía no aparece al releer.';
			operation.updatedAt = this.stamp();
			await this.persist(operation);
			this.logTransition(
				operation,
				from,
				operation.error,
				{ unconfirmed: true },
				exhausted ? 'error' : 'info',
			);
		}
		return null;
	}

	/** Lo que Lumbre rechazó dentro de un lote que sí aceptó. */
	private logBatchFailures(operation: QueuedOperation): void {
		if (operation.kind !== 'batch') return;
		const failed = operation.failedItems ?? [];
		if (failed.length === 0) return;
		this.log?.warn('Lumbre rechazó parte del lote', {
			id: operation.id,
			ops: operation.ops.length,
			failed: describeFailedItems(failed),
		});
	}

	/**
	 * Envía la operación. El resultado lleva SIEMPRE la forma `{ outcome? }`,
	 * aunque solo la rellenen las que mandan por `mutate` (`status`, `notes`,
	 * `brl` y `mutation`): así `process` puede mirar `sent.value.outcome` sin un
	 * `switch` previo por `kind`, y el resto de operaciones simplemente no lo
	 * traen.
	 */
	private async send(
		operation: QueuedOperation,
	): Promise<LumbreResult<{ outcome?: MutationOutcome }>> {
		switch (operation.kind) {
			case 'create': {
				const sent = await this.options.client.createTask(operation.draft, operation.clientTaskId);
				if (!sent.ok) return sent;
				return { ok: true, value: {} };
			}
			case 'status':
				return this.options.client.mutate({
					op: 'complete',
					taskId: operation.taskId,
					done: operation.done,
				});
			case 'brl':
				return this.options.client.mutate({
					op: 'createBrlEntry',
					entryId: operation.entryId,
					date: operation.date,
					entry: operation.entry,
				});
			case 'batch': {
				const sent = await this.options.client.batch(operation.ops);
				if (!sent.ok) return sent;
				// Éxito PARCIAL por diseño: `/api/batch` responde 200 aunque una op se
				// rechace, y las VÁLIDAS ya están encoladas y drenadas. Por eso el lote
				// queda ENVIADO aunque el informe traiga rojos: reenviarlo aplicaría
				// otra vez lo que sí entró, y una `addSubtask` no es idempotente. Lo
				// que falló se guarda dentro de la operación, con su índice.
				operation.failedItems = sent.value
					.filter((item) => !item.ok)
					.map((item) => ({ index: item.index, error: item.error ?? null }));
				return { ok: true, value: {} };
			}
			case 'listLink': {
				const target: ListLinkTarget = {
					listId: operation.listId,
					url: operation.url,
					label: operation.label,
				};
				const sent =
					operation.type === 'link'
						? await this.options.client.listLink(target)
						: await this.options.client.listUnlink(target);
				if (!sent.ok) return sent;
				return { ok: true, value: {} };
			}
			case 'notes':
				return this.options.client.mutate({
					op: 'update',
					taskId: operation.taskId,
					notes: operation.notes,
				});
			case 'mutation':
				// VERBATIM: lo que compuso quien encoló es lo que se manda.
				return this.options.client.mutate(operation.op);
			case 'taskLink': {
				const target: TaskLinkTarget = {
					taskId: operation.taskId,
					url: operation.url,
					label: operation.label,
				};
				const sent =
					operation.type === 'link'
						? await this.options.client.taskLink(target)
						: await this.options.client.taskUnlink(target);
				if (!sent.ok) return sent;
				return { ok: true, value: {} };
			}
		}
	}

	/**
	 * Relee la tarea para confirmar que la operación se materializó. Reintenta la
	 * relectura UNA vez tras `REREAD_DELAY_MS`, que es lo que suele tardar el
	 * drenaje. Cuatro desenlaces: `materialized` (confirmada y guardada),
	 * `missing` (la lectura fue bien pero la tarea aún no está como debería),
	 * `unverifiable` (no hay nada que leer, ver `MutationCheck`) o el fallo de la
	 * lectura en sí.
	 */
	private async confirm(
		operation: QueuedOperation,
	): Promise<'materialized' | 'missing' | 'unverifiable' | LumbreFailure> {
		for (let attempt = 0; attempt < 2; attempt += 1) {
			if (attempt > 0) await this.sleep(REREAD_DELAY_MS);

			const read = await this.reread(operation);
			// Sin relectura posible, esperar y repetir no cambia nada: se sale ya.
			if (read === 'unverifiable') return read;
			if (read !== 'missing' && read !== 'confirmed') return read;
			if (read === 'confirmed') {
				const from = operation.state;
				operation.state = 'materialized';
				operation.error = null;
				operation.materializedAt = this.stamp();
				operation.updatedAt = operation.materializedAt;
				await this.persist(operation);
				this.logTransition(operation, from, 'Confirmada al releer', { reread: attempt + 1 });
				this.options.onMaterialized?.(operation);
				return 'materialized';
			}
		}
		return 'missing';
	}

	/**
	 * Marca `materialized` SIN releer: lo pide un `outcome` de `'applied'` o
	 * `'noop'`, que ya es la confirmación de que el servidor tocó (o no tocó a
	 * propósito) la tarea. Gemela de la rama `confirmed` de `confirm()`.
	 */
	private async materializeByOutcome(
		operation: QueuedOperation,
		outcome: MutationOutcome,
	): Promise<void> {
		const from = operation.state;
		operation.state = 'materialized';
		operation.error = null;
		operation.materializedAt = this.stamp();
		operation.updatedAt = operation.materializedAt;
		await this.persist(operation);
		this.logTransition(operation, from, 'Confirmada por el outcome del servidor', { outcome });
		this.options.onMaterialized?.(operation);
	}

	/**
	 * Aparca una operación que el servidor aceptó y que NADIE puede confirmar: el
	 * `outcome` no la resolvió y su `check` dice que no hay relectura posible (hoy
	 * solo `registerHabit`).
	 *
	 * Queda `recoverable_error` con los intentos AGOTADOS, así que ni el drenaje
	 * periódico ni el siguiente flush la vuelven a tocar: reintentarla sola no
	 * podría aprender nada nuevo, y reenviarla podría apuntar la ocurrencia dos
	 * veces. `retry(id)` sigue estando para que el usuario la mande a comprobar a
	 * mano, que es lo único que puede resolverla.
	 */
	private async parkUnverifiable(operation: QueuedOperation): Promise<void> {
		const from = operation.state;
		operation.state = 'recoverable_error';
		operation.attempts = MAX_ATTEMPTS;
		operation.error = 'Lumbre aceptó la operación y el plugin no puede comprobar si se aplicó.';
		operation.updatedAt = this.stamp();
		await this.persist(operation);
		this.logTransition(operation, from, operation.error, { unverifiable: true }, 'warn');
	}

	/**
	 * Marca `rejected` SIN gastar un reintento: lo pide un `outcome` de
	 * `'not-found'`, que ya dice que la tarea no está en el store del dueño del
	 * token (inexistente, borrada o archivada). Reintentar no la haría
	 * reaparecer.
	 */
	private async rejectByOutcome(operation: QueuedOperation): Promise<void> {
		const from = operation.state;
		operation.state = 'rejected';
		operation.error = 'La tarea ya no existe en Lumbre o está archivada.';
		operation.updatedAt = this.stamp();
		await this.persist(operation);
		this.logTransition(operation, from, operation.error, { outcome: 'not-found' }, 'error');
	}

	/**
	 * UNA relectura. Cada tipo de operación se confirma en su propio sitio: una
	 * tarea por `getTask`, un lote por `getTasksByIds` de lo que creó, y una
	 * entrada del BRL por el JSON del día, porque no es una tarea y `getTask`
	 * nunca la encontraría.
	 *
	 * De lo leído NO se guarda nada: solo interesa si está o no. La tarea entera
	 * (con su título y sus notas) acabaría en `data.json`, que viaja por Sync.
	 */
	private async reread(
		operation: QueuedOperation,
	): Promise<'confirmed' | 'missing' | 'unverifiable' | LumbreFailure> {
		if (operation.kind === 'mutation') return this.rereadMutation(operation.check);

		if (operation.kind === 'brl') {
			const read = await this.options.client.brlJson(operation.date);
			if (!read.ok) return read;
			const found = read.value.entries.some((entry) => entry.id === operation.entryId);
			return found ? 'confirmed' : 'missing';
		}

		if (operation.kind === 'batch') {
			// Un lote sin altas (o con las altas rechazadas) no tiene nada que releer:
			// sus mutaciones tocan tareas que ya existían, y el informe en verde es
			// cuanto se puede saber sin conocer qué esperaba cada `kind`.
			const ids = expectedTaskIds(operation);
			if (ids.length === 0) return 'confirmed';
			const read = await this.options.client.getTasksByIds(ids);
			if (!read.ok) return read;
			return read.value.length < ids.length ? 'missing' : 'confirmed';
		}

		if (operation.kind === 'listLink') {
			// Tras un `link` la url mandada debe ESTAR; tras un `unlink`, no debe
			// estar. `removed: false` de la respuesta del `unlink` (el destino ya no
			// estaba registrado) no cambia nada aquí: la ausencia se confirma igual.
			const read = await this.options.client.listLinks(operation.listId);
			if (!read.ok) return read;
			const present = read.value.some((link) => link.url === operation.url);
			const wanted = operation.type === 'link';
			return present === wanted ? 'confirmed' : 'missing';
		}

		if (operation.kind === 'notes') {
			// Se confirma por CONTENIDO, no por existencia: la tarea ya existía antes
			// de esta operación, así que lo único que dice si la foto llegó es que
			// las `notes` releídas lleven su cabecera.
			const read = await this.options.client.getTask(operation.taskId);
			if (!read.ok) return read;
			const task = read.value;
			if (task === null) return 'missing';
			return (task.notes ?? '').includes(operation.header) ? 'confirmed' : 'missing';
		}

		if (operation.kind === 'taskLink') {
			// Gemelo de `listLink`, arriba.
			const read = await this.options.client.taskLinks(operation.taskId);
			if (!read.ok) return read;
			const present = read.value.some((link) => link.url === operation.url);
			const wanted = operation.type === 'link';
			return present === wanted ? 'confirmed' : 'missing';
		}

		const id = operation.kind === 'create' ? operation.clientTaskId : operation.taskId;
		const read = await this.options.client.getTask(id);
		if (!read.ok) return read;

		const task = read.value;
		if (task === null || !matchesOperation(operation, task)) return 'missing';
		return 'confirmed';
	}

	/**
	 * La relectura de una mutación genérica, elegida por su `check` y no por su
	 * `op`: cada caso dice qué se lee y qué se compara, y está documentado en
	 * `MutationCheck`.
	 *
	 * Igual que el resto de relecturas, de lo leído no se guarda NADA: solo
	 * interesa si lo que se pidió ya está.
	 */
	private async rereadMutation(
		check: MutationCheck,
	): Promise<'confirmed' | 'missing' | 'unverifiable' | LumbreFailure> {
		switch (check.check) {
			case 'none':
				return 'unverifiable';
			case 'taskField': {
				const read = await this.options.client.getTask(check.taskId);
				if (!read.ok) return read;
				const task = read.value;
				if (task === null) return 'missing';
				return task[check.field] === check.expected ? 'confirmed' : 'missing';
			}
			case 'taskFieldSet': {
				const read = await this.options.client.getTask(check.taskId);
				if (!read.ok) return read;
				const task = read.value;
				if (task === null) return 'missing';
				// Por PRESENCIA: el valor lo pone el servidor (ver `MutationCheck`).
				return (task[check.field] !== null) === check.set ? 'confirmed' : 'missing';
			}
			case 'taskRef': {
				const read = await this.options.client.getTask(check.taskId);
				if (!read.ok) return read;
				const task = read.value;
				if (task === null) return 'missing';
				const ref = task[check.field];
				if (check.expected === null) return ref === null ? 'confirmed' : 'missing';
				if (ref === null) return 'missing';
				return (check.by === 'id' ? ref.id : ref.name) === check.expected
					? 'confirmed'
					: 'missing';
			}
			case 'subtasksInclude': {
				const read = await this.options.client.getTask(check.parentId);
				if (!read.ok) return read;
				// `subtasks` AUSENTE no es "no tiene ninguna": es que esta lectura no
				// las sirve (el padre ya es una subtarea, o la tarea no está), y sin
				// ellas no hay nada que confirmar.
				const subtasks = read.value?.subtasks;
				if (subtasks === undefined) return 'missing';
				const present = new Set(subtasks.map((subtask) => subtask.content.trim()));
				return check.titles.every((title) => present.has(title.trim()))
					? 'confirmed'
					: 'missing';
			}
			case 'subtaskDone': {
				const read = await this.options.client.getTask(check.parentId);
				if (!read.ok) return read;
				const subtask = read.value?.subtasks?.find(
					(candidate) => candidate.id === check.subtaskId,
				);
				if (subtask === undefined) return 'missing';
				return subtask.done === check.done ? 'confirmed' : 'missing';
			}
			case 'listExists': {
				const read = await this.options.client.listLists();
				if (!read.ok) return read;
				return read.value.some((list) => list.id === check.listId) ? 'confirmed' : 'missing';
			}
			case 'listNotes': {
				const read = await this.options.client.listNotes(check.listId);
				if (!read.ok) return read;
				const { found, notes } = read.value;
				// La lista tiene que ESTAR: sin ella, ni la nota puesta ni la borrada
				// significan nada.
				if (!found) return 'missing';
				if (check.header === null) return notes === null ? 'confirmed' : 'missing';
				return (notes ?? '').includes(check.header) ? 'confirmed' : 'missing';
			}
			case 'brlEntry': {
				const read = await this.options.client.brlJson(check.date);
				if (!read.ok) return read;
				const entry = read.value.entries.find((row) => row.id === check.entryId);
				if (check.entry === null) return entry === undefined ? 'confirmed' : 'missing';
				if (entry === undefined) return 'missing';
				// Recortado por los dos lados: el servidor canonicaliza el texto de una
				// entrada al encolarla.
				return entry.entry.trim() === check.entry.trim() ? 'confirmed' : 'missing';
			}
		}
	}

	/**
	 * Marca el fallo y dice si el flush debe pararse. 401/403/400 dejan la
	 * operación `rejected` (el servidor no va a cambiar de idea solo); red y 5xx
	 * la dejan `recoverable_error` con un intento más.
	 *
	 * El 429 es aparte: no ha fallado la operación, ha fallado el MOMENTO. No
	 * gasta intento (si no, cinco 429 seguidos la dejarían muerta sin haberla
	 * llegado a intentar de verdad) y aplaza el siguiente intento hasta que el
	 * servidor diga, o medio minuto si no lo dice.
	 */
	private async recordFailure(
		operation: QueuedOperation,
		failure: LumbreFailure,
	): Promise<'no_token' | 'rate_limited' | null> {
		if (failure.reason === 'no_token') {
			this.log?.debug('Flush parado: no hay token', { id: operation.id, kind: operation.kind });
			return 'no_token';
		}

		const from = operation.state;
		operation.error = failureText(failure);
		operation.updatedAt = this.stamp();
		if (PERMANENT_REASONS.has(failure.reason)) {
			operation.state = 'rejected';
		} else if (failure.reason === 'rate_limited') {
			operation.state = 'recoverable_error';
			const wait = (failure.retryAfterSeconds ?? 0) * 1000 || RATE_LIMIT_BACKOFF_MS;
			operation.nextAttemptAt = new Date(this.now().getTime() + wait).toISOString();
		} else {
			operation.state = 'recoverable_error';
			operation.attempts += 1;
		}
		await this.persist(operation);

		// Tres escalones, y cada uno dice una cosa distinta: uno recuperable es
		// ruido; el tercero es un patrón; el que agota los intentos ya no se va a
		// enviar solo nunca más, y eso es lo que hay que ver en el informe.
		const level =
			operation.state === 'rejected' || operation.attempts >= MAX_ATTEMPTS
				? 'error'
				: operation.attempts >= WARN_AFTER_ATTEMPTS
					? 'warn'
					: 'info';
		this.logTransition(operation, from, operation.error, { reason: failure.reason }, level);
		return failure.reason === 'rate_limited' ? 'rate_limited' : null;
	}

	// ── Registro ─────────────────────────────────────────────────────────────

	private logEnqueued(operation: QueuedOperation, data: Record<string, unknown>): void {
		this.log?.info('Operación encolada', {
			id: operation.id,
			kind: operation.kind,
			...data,
		});
	}

	/**
	 * Un cambio de estado. Lleva SIEMPRE `from` y `to`: leyendo el registro, una
	 * transición sin su origen no dice si algo se reintentó o si nació ya así.
	 */
	private logTransition(
		operation: QueuedOperation,
		from: OperationState,
		reason: string,
		data: Record<string, unknown> = {},
		level: 'debug' | 'info' | 'warn' | 'error' = 'info',
	): void {
		this.log?.event(level, 'Operación de la cola', {
			id: operation.id,
			kind: operation.kind,
			from,
			to: operation.state,
			attempts: operation.attempts,
			reason,
			...data,
		});
	}

	private newBase(): OperationBase {
		const stamp = this.stamp();
		return {
			id: crypto.randomUUID(),
			deviceId: this.options.storage.deviceId,
			state: 'pending_local',
			attempts: 0,
			error: null,
			createdAt: stamp,
			updatedAt: stamp,
			sentAt: null,
		};
	}

	private stamp(): string {
		return this.now().toISOString();
	}

	private read(): QueuedOperation[] {
		return this.options.storage.readQueue();
	}

	private mine(): QueuedOperation[] {
		return this.read().filter(
			(operation) => operation.deviceId === this.options.storage.deviceId,
		);
	}

	/**
	 * Escribe la cola YA PODADA. Es el único camino de escritura, así que la poda
	 * no depende de que nadie se acuerde de llamarla.
	 */
	private async write(operations: QueuedOperation[]): Promise<void> {
		const kept = pruneQueue(operations, this.now());
		const dropped = operations.length - kept.length;
		if (dropped > 0) this.log?.debug('Materializadas podadas de la cola', { dropped });
		await this.options.storage.writeQueue(kept);
	}

	private async append(operation: QueuedOperation): Promise<void> {
		await this.write([...this.read(), operation]);
	}

	/** Guarda la operación ya mutada dentro de la cola entera. */
	private async persist(operation: QueuedOperation): Promise<void> {
		const operations = this.read().map((candidate) =>
			candidate.id === operation.id ? operation : candidate,
		);
		await this.write(operations);
	}
}

/** `true` si la operación todavía tiene algo que hacer en este flush. */
function isActionable(operation: QueuedOperation, now: Date): boolean {
	if (operation.state === 'materialized' || operation.state === 'rejected') return false;
	if (operation.state === 'recoverable_error' && operation.attempts >= MAX_ATTEMPTS) return false;
	const wait = operation.nextAttemptAt;
	if (typeof wait === 'string' && Date.parse(wait) > now.getTime()) return false;
	return true;
}

/**
 * Poda las operaciones ya terminadas: fuera las materializadas de más de
 * `MATERIALIZED_TTL_MS`, y de las que quedan solo las `MAX_MATERIALIZED` más
 * recientes. Lo que no está materializado no se toca NUNCA: ahí hay escrituras
 * que todavía no han llegado a Lumbre.
 */
export function pruneQueue(operations: readonly QueuedOperation[], now: Date): QueuedOperation[] {
	const materialized = operations.filter((operation) => operation.state === 'materialized');
	if (materialized.length === 0) return [...operations];

	const cutoff = now.getTime() - MATERIALIZED_TTL_MS;
	const keep = new Set(
		materialized
			.filter((operation) => timeOf(operation.updatedAt) >= cutoff)
			.sort((a, b) => timeOf(b.updatedAt) - timeOf(a.updatedAt))
			.slice(0, MAX_MATERIALIZED)
			.map((operation) => operation.id),
	);
	return operations.filter(
		(operation) => operation.state !== 'materialized' || keep.has(operation.id),
	);
}

/** Epoch de una marca ISO, o 0 si no se puede leer (una cola de otra versión). */
function timeOf(stamp: string): number {
	const parsed = Date.parse(stamp);
	return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * UN drenaje por flush: la primera llamada pide `POST /api/sync/flush` y las
 * demás esperan a esa misma respuesta.
 */
function onceDrain(run: () => Promise<LumbreResult<void>>): () => Promise<LumbreResult<void>> {
	let pending: Promise<LumbreResult<void>> | null = null;
	return () => (pending ??= run());
}

/** Las tareas del lote que HAY que releer: las que el servidor no rechazó. */
function expectedTaskIds(operation: BatchQueuedOperation): string[] {
	const failed = operation.failedItems ?? [];
	if (failed.length === 0) return operation.createdTaskIds;

	const rejected = new Set<string>();
	for (const item of failed) {
		const op = operation.ops[item.index];
		if (op !== undefined && op.type === 'create') rejected.add(op.clientTaskId);
	}
	return operation.createdTaskIds.filter((id) => !rejected.has(id));
}

/**
 * Qué ops del lote rechazó Lumbre, en una línea para el usuario. La posición va
 * en base 1 (la primera acción es la 1) y el motivo es el del servidor: una
 * validación suya, nunca texto de la nota.
 */
export function describeFailedItems(items: readonly BatchFailedItem[]): string {
	return items
		.map((item) =>
			item.error === null ? `acción ${item.index + 1}` : `acción ${item.index + 1} (${item.error})`,
		)
		.join('; ');
}

/**
 * El `outcome` que trae un envío, para los `kind`s que pueden creérselo:
 * `status`, `notes` y `mutation`.
 *
 * `status` y `notes` apuntan a una tarea existente, así que su `not-found`
 * significa de verdad "esa tarea ya no está". `mutation` se lo cree salvo que su
 * comprobación EXIJA releer (ver `rereadRequired`). Los demás `kind`s lo ignoran
 * a propósito: un `create` apunta a una tarea que el propio plugin acaba de
 * inventar, y `brl` (que también manda por `mutate`) tiene su propia relectura.
 */
function outcomeOf(
	operation: QueuedOperation,
	value: { outcome?: MutationOutcome },
): MutationOutcome | undefined {
	if (operation.kind === 'mutation') {
		return rereadRequired(operation.check) ? undefined : value.outcome;
	}
	if (operation.kind !== 'status' && operation.kind !== 'notes') return undefined;
	return value.outcome;
}

/**
 * `true` si la comprobación no acepta el `outcome` como evidencia y hay que
 * releer de todas formas.
 *
 * Hoy solo el BRL: el materializador de Lumbre responde `applied` a
 * `updateBrlEntry` y `removeBrlEntry` exista o no la entrada, así que su
 * `outcome` no distingue el cambio de la nada (ver el JSDoc del caso
 * `brlEntry`).
 */
function rereadRequired(check: MutationCheck): boolean {
	return check.check === 'brlEntry';
}

/**
 * `true` si la tarea leída ya refleja lo que pedía la operación.
 *
 * Solo se llama por RELECTURA, o sea cuando `process` no ha podido resolver el
 * envío por `outcome` (ver `outcomeOf`): un `create` (que no tiene outcome), o
 * un `status`/`notes` contra un Lumbre anterior al contrato, o con `outcome:
 * 'queued'`. Con outcome disponible, `'applied'`/`'noop'` ya distinguen si la
 * mutación CAMBIÓ algo, que es justo lo que esta función no puede saber: un
 * `status` se confirma aquí solo por `done`, así que reabrir una tarea que en
 * Lumbre YA estaba abierta (o completar una que ya estaba hecha) se da por
 * materializado al instante, haya llegado a aplicarse la mutación o no. Este
 * límite se documentaba como H7 (`docs/ESTADO.md`, lote H) y lo cierra el
 * `outcome`, no esta función: contra un servidor sin él, sigue vigente.
 */
function matchesOperation(operation: CreateOperation | StatusOperation, task: LumbreTask): boolean {
	// Para un `create` basta con que la tarea EXISTA: el id lo fijamos nosotros.
	if (operation.kind === 'create') return true;
	return task.done === operation.done;
}

/** Texto del fallo para guardar en la operación. Nunca incluye el token. */
function failureText(failure: LumbreFailure): string {
	const status = failure.status !== undefined ? ` (${failure.status})` : '';
	switch (failure.reason) {
		case 'no_token':
			return 'Falta el token personal.';
		case 'unauthorized':
			return `El token no vale o ha caducado${status}.`;
		case 'bad_request':
			return `Lumbre rechazó la operación por su contenido${status}.`;
		case 'not_found':
			return `Eso ya no existe en Lumbre${status}.`;
		case 'rate_limited':
			return `Demasiadas peticiones a Lumbre${status}.`;
		case 'network':
			return 'No se pudo conectar con Lumbre.';
		case 'too_large':
			return 'El contenido pasa del tope de Lumbre.';
		case 'server':
			return `Lumbre respondió con un error${status}.`;
	}
}
