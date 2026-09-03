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
 */

import type { LumbreClient, FailureReason, LumbreFailure, LumbreResult } from './client';
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

export type QueuedOperation = CreateOperation | StatusOperation;

/** Lo que la cola necesita del almacén del plugin. Lo cumple `PluginStore`. */
export interface QueueStorage {
	/** Id de ESTA instalación. */
	readonly deviceId: string;
	readQueue(): QueuedOperation[];
	writeQueue(operations: QueuedOperation[]): Promise<void>;
}

export interface OperationQueueOptions {
	client: Pick<LumbreClient, 'createTask' | 'mutate' | 'flush' | 'getTask'>;
	storage: QueueStorage;
	/** Espera entre la primera relectura vacía y la segunda. Inyectable para los tests. */
	sleep?: (ms: number) => Promise<void>;
	/** Reloj, inyectable para los tests. */
	now?: () => Date;
}

/** Intentos fallidos tras los cuales la operación solo se reintenta a mano. */
export const MAX_ATTEMPTS = 5;

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
	private inFlight: Promise<void> | null = null;

	constructor(private readonly options: OperationQueueOptions) {
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
	 * Devuelve una operación parada al camino: pone los intentos a cero y borra el
	 * motivo del fallo. Si el servidor ya la había aceptado (`sentAt`), vuelve a
	 * `sent` para que el siguiente `flush()` la RELEA en vez de reenviarla.
	 */
	async retry(id: string): Promise<void> {
		const operations = this.read();
		const operation = operations.find((candidate) => candidate.id === id);
		if (operation === undefined) return;
		operation.attempts = 0;
		operation.error = null;
		operation.state = operation.sentAt !== null ? 'sent' : 'pending_local';
		operation.updatedAt = this.stamp();
		await this.write(operations);
	}

	/** Saca una operación de la cola. No deshace nada en Lumbre. */
	async discard(id: string): Promise<void> {
		const operations = this.read();
		const remaining = operations.filter((operation) => operation.id !== id);
		if (remaining.length === operations.length) return;
		await this.write(remaining);
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
		for (const operation of this.mine()) {
			if (!isActionable(operation)) continue;

			const outcome = await this.process(operation);
			// Sin token no ha llegado a haber petición: no se gasta un intento ni se
			// marca nada, la cola se queda tal cual hasta que haya token.
			if (outcome === 'no_token') return;
			// Con 429 se para el flush entero: seguir con las demás solo gasta cupo
			// contra un servidor que acaba de decir que espere.
			if (outcome === 'rate_limited') return;
		}
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
		}
		return null;
	}

	private async send(operation: QueuedOperation): Promise<LumbreResult<void>> {
		if (operation.kind === 'create') {
			return this.options.client.createTask(operation.draft, operation.clientTaskId);
		}
		return this.options.client.mutate({
			op: 'complete',
			taskId: operation.taskId,
			done: operation.done,
		});
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
		const id = operation.kind === 'create' ? operation.clientTaskId : operation.taskId;

		for (let attempt = 0; attempt < 2; attempt += 1) {
			if (attempt > 0) await this.sleep(REREAD_DELAY_MS);

			const read = await this.options.client.getTask(id);
			if (!read.ok) return read;

			const task = read.value;
			if (task !== null && matchesOperation(operation, task)) {
				operation.state = 'materialized';
				operation.task = task;
				operation.error = null;
				operation.updatedAt = this.stamp();
				await this.persist(operation);
				return 'materialized';
			}
		}
		return 'missing';
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
		if (failure.reason === 'no_token') return 'no_token';

		operation.error = failureText(failure);
		operation.updatedAt = this.stamp();
		if (PERMANENT_REASONS.has(failure.reason)) {
			operation.state = 'rejected';
		} else {
			operation.state = 'recoverable_error';
			operation.attempts += 1;
		}
		await this.persist(operation);
		return failure.reason === 'rate_limited' ? 'rate_limited' : null;
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
function matchesOperation(operation: QueuedOperation, task: LumbreTask): boolean {
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
		case 'server':
			return `Lumbre respondió con un error${status}.`;
	}
}
