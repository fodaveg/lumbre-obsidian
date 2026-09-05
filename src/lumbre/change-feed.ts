/**
 * Sondeo barato de cambios: `GET /api/tasks?updatedSince=`.
 *
 * Para qué existe: el panel «Tareas de esta nota» y los bloques ```lumbre```
 * solo se enteran de un cambio hecho fuera de Obsidian (completada, archivada
 * o movida desde la app o el móvil) cuando alguien fuerza una relectura. Sin
 * esto, ese cambio se queda invisible hasta que vence el TTL de 30 s de
 * `QueryCache` o el usuario pulsa «Actualizar».
 *
 * Dos piezas en este módulo, las dos SIN importar `obsidian`:
 *
 * - `ChangeFeed`: el cursor y la paginación. Puro, solo necesita el cliente.
 * - `startChangeFeedPoll`/`pollChangeFeedOnce`: el temporizador y la reacción
 *   al delta (qué se refresca). Sigue el mismo patrón que
 *   `queue-drain.ts`: quien arranca esto (`main.ts`) inyecta cómo registrar el
 *   intervalo y con qué comprobar cada guarda.
 */

import type { Logger } from '../diagnostics/logger';
import { MAX_TASKS_LIMIT, type LumbreClient } from './client';
import type { LumbreTask } from './types';

/** Cada cuánto se sondea el delta. Mismo minuto que el drenaje de la cola: no es urgente. */
export const CHANGE_FEED_INTERVAL_MS = 60_000;

/**
 * Tope de tareas por página al paginar el delta. El mismo tope que impone el
 * servidor en `?limit=` (`MAX_TASKS_LIMIT`): pedir menos no ahorra nada y
 * pedir más el servidor lo recorta igual.
 */
export const CHANGE_FEED_PAGE_LIMIT = MAX_TASKS_LIMIT;

/**
 * Tope de páginas por sondeo, de seguridad (mío: no lo pide el diseño). Cubre
 * el caso patológico de más de `CHANGE_FEED_PAGE_LIMIT` tareas compartiendo
 * EXACTAMENTE el mismo `updatedAt` al milisegundo: sin este tope, el
 * repunte por empates (ver `poll`) encadenaría peticiones sin fin dentro de
 * una sola llamada. Con el tope, el sondeo se corta, guarda el progreso hecho
 * hasta ahí y termina el resto en la siguiente pasada.
 */
export const CHANGE_FEED_MAX_PAGES = 20;

/** Lo que devuelve una pasada de `ChangeFeed.poll()` con éxito. */
export interface ChangeFeedResult {
	/** Tareas cambiadas desde el cursor anterior, sin duplicados. */
	tasks: LumbreTask[];
	/** Cuántas páginas hicieron falta (normalmente 1). */
	pages: number;
}

export interface ChangeFeedDeps {
	client: Pick<LumbreClient, 'tasksUpdatedSince'>;
	/** Registro de diagnóstico, ya etiquetado. Sin él, el feed no apunta nada. */
	logger?: Logger;
}

/**
 * Guarda el cursor y pide el delta desde ahí, paginando mientras la respuesta
 * llegue LLENA. Una instancia por plugin: el cursor es SU estado, no se
 * persiste en `data.json` (ver el porqué en el JSDoc del constructor).
 */
export class ChangeFeed {
	private cursor: string;
	private readonly client: Pick<LumbreClient, 'tasksUpdatedSince'>;
	private readonly log: Logger | null;

	/**
	 * `initialCursor` es el instante del arranque del plugin
	 * (`new Date().toISOString()` en `main.ts`), NUNCA algo persistido: al
	 * arrancar ya se hace una lectura completa (los bloques y el panel piden lo
	 * suyo), y un cursor viejo guardado en `data.json` traería de vuelta deltas
	 * de otro dispositivo si `data.json` llega por Obsidian Sync, cosa que no
	 * tiene sentido pedir dos veces.
	 */
	constructor(deps: ChangeFeedDeps, initialCursor: string) {
		this.client = deps.client;
		this.log = deps.logger ?? null;
		this.cursor = initialCursor;
	}

	/** El cursor actual. Solo para los tests: nadie más necesita mirarlo. */
	currentCursor(): string {
		return this.cursor;
	}

	/**
	 * Pide el delta desde el cursor. Devuelve `null` si alguna página falla (y
	 * el cursor NO se mueve: la próxima pasada repite el mismo tramo) o el
	 * conjunto de tareas cambiadas, con el cursor ya avanzado al `updatedAt`
	 * MAYOR visto.
	 *
	 * El borde de los empates: si una página llega LLENA
	 * (`CHANGE_FEED_PAGE_LIMIT`), el corte pudo partir un grupo de tareas con
	 * el MISMO `updatedAt` que el último elemento («estrictamente posterior»
	 * se habría saltado a sus gemelas). Se resuelve repitiendo la página con
	 * `since` = ese `updatedAt` menos un milisegundo, descartando por id lo ya
	 * visto: así las gemelas que quedaron fuera del corte anterior entran en
	 * la siguiente página.
	 */
	async poll(): Promise<ChangeFeedResult | null> {
		const seen = new Set<string>();
		const tasks: LumbreTask[] = [];
		let requestSince = this.cursor;
		let nextCursor = this.cursor;
		let pages = 0;

		for (;;) {
			const read = await this.client.tasksUpdatedSince({
				since: requestSince,
				limit: CHANGE_FEED_PAGE_LIMIT,
				notes: 'none',
			});
			if (!read.ok) {
				this.log?.warn('Sondeo de cambios fallido, el cursor no se mueve', {
					reason: read.reason,
					status: read.status,
					pages,
				});
				return null;
			}

			pages += 1;
			const page = read.value;
			for (const task of page) {
				if (seen.has(task.id)) continue;
				seen.add(task.id);
				tasks.push(task);
			}

			const lastUpdatedAt = page.at(-1)?.updatedAt;
			if (lastUpdatedAt !== undefined) nextCursor = lastUpdatedAt;

			// Página no llena, o sin `updatedAt` en el último elemento (no debería
			// pasar con una fila real): no hay más delta que pedir.
			if (page.length < CHANGE_FEED_PAGE_LIMIT || lastUpdatedAt === undefined) break;
			if (pages >= CHANGE_FEED_MAX_PAGES) {
				this.log?.warn('Sondeo de cambios: tope de páginas, se corta y sigue en la próxima pasada', {
					pages,
				});
				break;
			}

			requestSince = minusOneMillisecond(lastUpdatedAt);
		}

		this.cursor = nextCursor;
		this.log?.info('Sondeo de cambios', { changed: tasks.length, pages });
		return { tasks, pages };
	}
}

/** El ISO un milisegundo antes. Para repetir el borde de una página llena. */
function minusOneMillisecond(iso: string): string {
	return new Date(new Date(iso).getTime() - 1).toISOString();
}

/**
 * Lo que necesita la reacción a una pasada de sondeo, aparte del feed. Sigue
 * el patrón de `QueueDrainDeps`: nada de aquí importa `obsidian`, `main.ts` le
 * pasa cierres que sí lo hacen.
 */
export interface ChangeFeedPollDeps {
	feed: Pick<ChangeFeed, 'poll'>;
	/**
	 * `true` si hay algo montado que necesite el delta: alguna consulta de
	 * `QueryCache` con bloques suscritos, o el panel «Tareas de esta nota»
	 * abierto. Sin esto, sondear no ahorraría nada: se pediría igual aunque no
	 * hubiera nadie mirando el resultado.
	 */
	isNeeded: () => boolean;
	isOnline: () => boolean;
	/** `document.hidden` en el plugin: una pestaña en segundo plano no necesita el delta AHORA. */
	isHidden: () => boolean;
	/** El pestillo de lecturas del cliente (`LumbreClient.readsAreLocked`). */
	isReadsLocked: () => boolean;
	/**
	 * Refresca las consultas vivas de `QueryCache`. En el plugin es
	 * `queries.refreshSoon()`: COALESCIDO, así que si la cola materializa algo
	 * a la vez, las dos comparten la misma ronda en vez de doblarla.
	 */
	refreshQueries: () => Promise<void>;
	/** Notas que tienen vinculada esta tarea. En el plugin, `links.notesForTask`. */
	notesForTask: (taskId: string) => string[];
	/** Relee de Lumbre los vínculos de una nota. En el plugin, `links.refresh(path, client)`. */
	refreshLinksForNote: (notePath: string) => Promise<void>;
	/** Avisa al panel de que algo ha cambiado. En el plugin, `notifyDataChange`. */
	notifyDataChange: () => void;
	/** Registra el temporizador (`registerInterval(window.setInterval(...))` en el plugin). */
	register: (handler: () => void, ms: number) => void;
	logger?: Logger;
}

/** Arranca el sondeo periódico. */
export function startChangeFeedPoll(deps: ChangeFeedPollDeps, ms = CHANGE_FEED_INTERVAL_MS): void {
	deps.register(() => {
		void pollChangeFeedOnce(deps);
	}, ms);
}

/**
 * Una pasada: solo pide si hace falta (hay algo montado, hay conexión, la
 * pestaña está visible y el pestillo de lecturas no está echado). Con delta
 * vacío no se hace nada más: es justo lo que ahorra las lecturas.
 */
export async function pollChangeFeedOnce(deps: ChangeFeedPollDeps): Promise<void> {
	if (!deps.isNeeded() || !deps.isOnline() || deps.isHidden() || deps.isReadsLocked()) return;

	const result = await deps.feed.poll();
	if (result === null || result.tasks.length === 0) return;

	deps.logger?.info('Sondeo de cambios: delta con tareas', {
		changed: result.tasks.length,
		pages: result.pages,
	});

	// Las consultas vivas se relee: una tarea archivada o completada fuera
	// desaparece del bloque sin que el cliente tenga que adivinar qué scope la
	// incluía. Coalescido con lo que dispare la cola en la misma ventana.
	await deps.refreshQueries();

	// Y el panel: solo las notas que tengan vinculada alguna tarea del delta.
	const notePaths = new Set<string>();
	for (const task of result.tasks) {
		for (const path of deps.notesForTask(task.id)) notePaths.add(path);
	}
	for (const path of notePaths) {
		await deps.refreshLinksForNote(path);
	}
	deps.notifyDataChange();
}
