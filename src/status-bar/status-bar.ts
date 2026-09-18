/**
 * Barra de estado del escritorio: cuántas operaciones esperan, si falta red y
 * si el token dejó de valer.
 *
 * Antes de esto, lo único que decía "algo no ha llegado" era abrir el panel de
 * la nota (que además exige tener una nota abierta) o el diagnóstico a mano.
 * `NOTE_TASKS_ICON` en el ribbon abre el panel, pero no dice NADA hasta que se
 * hace clic. La barra de estado vive siempre visible en el escritorio y solo
 * ocupa sitio cuando hay algo que contar: cola vacía, online y con token bueno
 * es el estado normal, y ahí no pinta nada (texto vacío).
 *
 * `queue.pending()` incluye las operaciones RECHAZADAS y las AGOTADAS (ver su
 * JSDoc en `lumbre/queue.ts`): contarlas junto con las que se van a reintentar
 * solas confundiría "esto se arregla en el próximo drenaje" con "esto necesita
 * que alguien mire". `queueStatusCounts` las separa por estado.
 *
 * Prioridad de lo que se enseña, de más a menos urgente: token rechazado (nada
 * se puede leer ni escribir hasta que alguien lo cambie), sin conexión (nada se
 * puede enviar hasta que vuelva), operaciones con error (no se van a reintentar
 * solas) y por último las que sí. La barra NO EXISTE en móvil: Obsidian no la
 * pinta ahí, así que `main.ts` no la registra con `Platform.isMobile`.
 *
 * Módulo puro: no importa `obsidian`. Quien lo arranca (`main.ts`) crea el
 * elemento con `addStatusBarItem()`, le engancha el clic (que abre el
 * diagnóstico) y le pasa cómo pintar el texto y cómo enterarse de los cambios.
 */

import { MAX_ATTEMPTS, type OperationQueue, type QueuedOperation } from '../lumbre/queue';

/** Lo mínimo de una operación que hace falta para contarla. */
type CountableOperation = Pick<QueuedOperation, 'state' | 'attempts'>;

export interface QueueStatusCounts {
	/** Se va a reintentar sola en el próximo drenaje: no hace falta tocar nada. */
	waiting: number;
	/** Rechazada, o agotó los reintentos automáticos: no se arregla sola. */
	attention: number;
}

/** Separa `queue.pending()` en lo que se arregla solo y lo que no. */
export function queueStatusCounts(operations: readonly CountableOperation[]): QueueStatusCounts {
	let waiting = 0;
	let attention = 0;
	for (const operation of operations) {
		if (operation.state === 'materialized') continue;
		if (operation.state === 'rejected') {
			attention += 1;
			continue;
		}
		if (operation.state === 'recoverable_error' && operation.attempts >= MAX_ATTEMPTS) {
			attention += 1;
			continue;
		}
		waiting += 1;
	}
	return { waiting, attention };
}

export interface StatusBarText {
	/** Cadena vacía oculta el elemento: nada que decir es nada que ocupar sitio. */
	text: string;
	/** Vacío cuando `text` también lo está. */
	tooltip: string;
}

export interface StatusBarInput {
	operations: readonly CountableOperation[];
	online: boolean;
	tokenRejected: boolean;
}

/** El texto y el tooltip de la barra para un estado dado. Sin efectos. */
export function statusBarText(input: StatusBarInput): StatusBarText {
	if (input.tokenRejected) {
		return {
			text: 'Lumbre: token rechazado',
			tooltip: 'Lumbre: el token no vale. Clic para ver el diagnóstico.',
		};
	}

	const { waiting, attention } = queueStatusCounts(input.operations);

	if (!input.online) {
		const total = waiting + attention;
		return {
			text: total > 0 ? `Lumbre: sin conexión (${total})` : 'Lumbre: sin conexión',
			tooltip: 'Lumbre: sin conexión. Se reintenta sola al volver la red.',
		};
	}

	if (attention > 0) {
		return {
			text: attention === 1 ? 'Lumbre: 1 operación con error' : `Lumbre: ${attention} operaciones con error`,
			tooltip: 'Lumbre: no se van a reintentar solas. Clic para ver el diagnóstico.',
		};
	}

	if (waiting > 0) {
		return {
			text: waiting === 1 ? 'Lumbre: 1 pendiente' : `Lumbre: ${waiting} pendientes`,
			tooltip: 'Lumbre: sin confirmar todavía. Clic para ver el diagnóstico.',
		};
	}

	return { text: '', tooltip: '' };
}

export interface StatusBarDeps {
	queue: Pick<OperationQueue, 'pending'>;
	/** En el plugin, `navigator.onLine`. */
	isOnline(): boolean;
	/** En el plugin, `client.readsAreLocked`. */
	isTokenRejected(): boolean;
	/** Pinta el estado en el elemento de la barra. */
	render(state: StatusBarText): void;
	/**
	 * Se suscribe al mismo canal que ya usan el panel y los bloques
	 * (`notifyDataChange` en `main.ts`): la cola no emite eventos propios salvo
	 * al materializar, así que sin esto la barra solo se refrescaría al cargar.
	 */
	onDataChange(listener: () => void): void;
	/** Se suscribe a `online`/`offline`. En el plugin, vía `registerDomEvent`. */
	onConnectionChange(listener: () => void): void;
}

/** Arranca la barra: pinta el estado ahora y se suscribe a lo que lo cambia. */
export function startStatusBar(deps: StatusBarDeps): void {
	const refresh = (): void => {
		deps.render(
			statusBarText({
				operations: deps.queue.pending(),
				online: deps.isOnline(),
				tokenRejected: deps.isTokenRejected(),
			}),
		);
	};

	refresh();
	deps.onDataChange(refresh);
	deps.onConnectionChange(refresh);
}
