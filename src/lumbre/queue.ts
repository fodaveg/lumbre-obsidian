/**
 * Cola durable de escrituras hacia Lumbre.
 *
 * Existe porque un 200 de `/api/ingest` o de `/api/mutations` NO significa que
 * la tarea exista ya: el servidor ENCOLA (`inbound_tasks`, `inbound_mutations`)
 * y materializa al drenar. Así que cada operación se envía, se fuerza el flush
 * y se RELEE: solo cuando la relectura confirma la tarea se da por materializada
 * y se guarda lo leído.
 *
 * No importa `obsidian`: persiste a través de `QueueStorage`, que implementa
 * `PluginStore`.
 *
 * Todo lo que pasa aquí se apunta en el registro de diagnóstico si se le
 * inyecta un logger: cada cambio de estado con su motivo, cada `flush()` con
 * cuántas operaciones movió, y los dos casos que suelen ser la explicación de
 * "no se ha enviado nada" (una operación agotada y una cola llena de
 * operaciones de OTRO dispositivo).
 */

import type { Logger } from '../diagnostics/logger';
import type {
	BatchOperation,
	LumbreClient,
	FailureReason,
	LumbreFailure,
	LumbreResult,
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
}

export type CreateOperation = OperationBase & {
	kind: 'create';
	/** Id que TENDRÁ la tarea, generado aquí. Hace idempotente el reenvío. */
	clientTaskId: string;
	draft: TaskDraft;
	target: LinkTarget;
	/** La tarea tal y como la devolvió la relectura que la confirmó. */
	task: LumbreTask | null;
};

export type StatusOperation = OperationBase & {
	kind: 'status';
	taskId: string;
	done: boolean;
	target: LinkTarget;
	task: LumbreTask | null;
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
	/** Las tareas creadas, tal y como las devolvió la relectura que las confirmó. */
	tasks: LumbreTask[] | null;
};

export type QueuedOperation =
	| CreateOperation
	| StatusOperation
	| BrlOperation
	| BatchQueuedOperation;

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
		'createTask' | 'mutate' | 'flush' | 'getTask' | 'getTasksByIds' | 'batch' | 'brlJson'
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

/** Motivos que NO se reintentan: el servidor ya ha dicho que no. */
const PERMANENT_REASONS: ReadonlySet<FailureReason> = new Set<FailureReason>([
	'unauthorized',
	'bad_request',
]);

export class OperationQueue {
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly now: () => Date;
	private readonly log: Logger | null;
	private inFlight: Promise<void> | null = null;

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
			task: null,
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
			task: null,
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
			tasks: null,
		};
		await this.append(operation);
		this.logEnqueued(operation, { ops: ops.length, creates: createdTaskIds.length });
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
	 * Procesa la cola en orden, una a una. Un solo flush en vuelo: si ya hay uno
	 * corriendo, esta llamada espera a ese.
	 */
	async flush(): Promise<void> {
		const running = this.inFlight;
		if (running !== null) return running;

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

		const actionable = mine.filter((operation) => isActionable(operation));
		this.log?.debug('Flush empezado', { actionable: actionable.length, queued: all.length });

		let processed = 0;
		let stopped: string | null = null;
		for (const operation of actionable) {
			const outcome = await this.process(operation);
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
	private async process(operation: QueuedOperation): Promise<'no_token' | 'rate_limited' | null> {
		if (operation.sentAt === null) {
			const sent = await this.send(operation);
			if (!sent.ok) return this.recordFailure(operation, sent);
			operation.sentAt = this.stamp();
			operation.state = 'sent';
			operation.error = null;
			await this.persist(operation);
			this.logTransition(operation, 'pending_local', 'Lumbre aceptó el envío');
		}

		const flushed = await this.options.client.flush();
		if (!flushed.ok) return this.recordFailure(operation, flushed);

		const confirmed = await this.confirm(operation);
		if (confirmed !== 'missing' && confirmed !== 'materialized') {
			return this.recordFailure(operation, confirmed);
		}

		if (confirmed === 'missing') {
			// El servidor aceptó el envío pero la tarea todavía no aparece. Se queda
			// en `sent` con un intento más: el siguiente flush la vuelve a comprobar
			// SIN reenviar nada, porque el id ya está fijado.
			operation.attempts += 1;
			operation.state = 'sent';
			operation.error = 'Lumbre aceptó la operación pero todavía no aparece al releer.';
			operation.updatedAt = this.stamp();
			await this.persist(operation);
			this.logTransition(operation, 'sent', 'Aceptada pero todavía no aparece al releer');
		}
		return null;
	}

	private async send(operation: QueuedOperation): Promise<LumbreResult<void>> {
		switch (operation.kind) {
			case 'create':
				return this.options.client.createTask(operation.draft, operation.clientTaskId);
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
				// Éxito PARCIAL: `/api/batch` responde 200 aunque una op se rechace, y
				// el informe es lo único que lo dice. Si alguna cayó, la operación NO
				// se puede dar por enviada en silencio.
				const failed = sent.value.filter((item) => !item.ok);
				if (failed.length > 0) return { ok: false, reason: 'bad_request' };
				return { ok: true, value: undefined };
			}
		}
	}

	/**
	 * Relee la tarea para confirmar que la operación se materializó. Reintenta la
	 * relectura UNA vez tras `REREAD_DELAY_MS`, que es lo que suele tardar el
	 * drenaje. Tres desenlaces: `materialized` (confirmada y guardada), `missing`
	 * (la lectura fue bien pero la tarea aún no está como debería) o el fallo de
	 * la lectura en sí.
	 */
	private async confirm(
		operation: QueuedOperation,
	): Promise<'materialized' | 'missing' | LumbreFailure> {
		for (let attempt = 0; attempt < 2; attempt += 1) {
			if (attempt > 0) await this.sleep(REREAD_DELAY_MS);

			const read = await this.reread(operation);
			if (read !== 'missing' && read !== 'confirmed') return read;
			if (read === 'confirmed') {
				const from = operation.state;
				operation.state = 'materialized';
				operation.error = null;
				operation.updatedAt = this.stamp();
				await this.persist(operation);
				this.logTransition(operation, from, 'Confirmada al releer', { reread: attempt + 1 });
				this.options.onMaterialized?.(operation);
				return 'materialized';
			}
		}
		return 'missing';
	}

	/**
	 * UNA relectura. Cada tipo de operación se confirma en su propio sitio: una
	 * tarea por `getTask`, un lote por `getTasksByIds` de lo que creó, y una
	 * entrada del BRL por el JSON del día, porque no es una tarea y `getTask`
	 * nunca la encontraría.
	 *
	 * Guarda lo leído dentro de la operación; quien llama solo marca el estado.
	 */
	private async reread(
		operation: QueuedOperation,
	): Promise<'confirmed' | 'missing' | LumbreFailure> {
		if (operation.kind === 'brl') {
			const read = await this.options.client.brlJson(operation.date);
			if (!read.ok) return read;
			const found = read.value.entries.some((entry) => entry.id === operation.entryId);
			return found ? 'confirmed' : 'missing';
		}

		if (operation.kind === 'batch') {
			// Un lote sin altas no tiene nada que releer: sus mutaciones tocan tareas
			// que ya existían, y el 200 con el informe en verde es cuanto se puede
			// saber sin conocer qué esperaba cada `kind`.
			if (operation.createdTaskIds.length === 0) return 'confirmed';
			const read = await this.options.client.getTasksByIds(operation.createdTaskIds);
			if (!read.ok) return read;
			if (read.value.length < operation.createdTaskIds.length) return 'missing';
			operation.tasks = read.value;
			return 'confirmed';
		}

		const id = operation.kind === 'create' ? operation.clientTaskId : operation.taskId;
		const read = await this.options.client.getTask(id);
		if (!read.ok) return read;

		const task = read.value;
		if (task === null || !matchesOperation(operation, task)) return 'missing';
		operation.task = task;
		return 'confirmed';
	}

	/**
	 * Marca el fallo y dice si el flush debe pararse. 401/403/400 dejan la
	 * operación `rejected` (el servidor no va a cambiar de idea solo); red, 5xx y
	 * 429 la dejan `recoverable_error` con un intento más.
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

	private async write(operations: QueuedOperation[]): Promise<void> {
		await this.options.storage.writeQueue(operations);
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
function isActionable(operation: QueuedOperation): boolean {
	if (operation.state === 'materialized' || operation.state === 'rejected') return false;
	if (operation.state === 'recoverable_error' && operation.attempts >= MAX_ATTEMPTS) return false;
	return true;
}

/** `true` si la tarea leída ya refleja lo que pedía la operación. */
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
