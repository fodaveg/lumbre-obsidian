/**
 * Caché compartida de las consultas de los bloques ```lumbre```.
 *
 * Existe por el límite de la API: 120 llamadas por minuto. Sin esto, una nota
 * con cinco bloques iguales serían cinco peticiones, y cada cambio de nota otras
 * cinco. Aquí una CONSULTA es una entrada: los bloques que piden lo mismo
 * comparten la misma lectura, la misma petición en vuelo y el mismo TTL de 30 s.
 *
 * Dos reglas que vienen del producto:
 *
 * - Si la lectura falla, la anterior NO se borra: se guarda el motivo y se sigue
 *   sirviendo la última confirmada, con su hora. Un bloque vacío mentiría.
 * - Cuando la cola materializa una operación, la caché entera caduca y las
 *   consultas con bloques montados se refrescan DE GOLPE (`refreshAll`), una
 *   petición por consulta distinta, no una por bloque.
 *
 * No importa `obsidian`: recibe el cliente por inyección, igual que el resto.
 */

import type { Logger } from '../diagnostics/logger';
import { describeFailure, type LumbreClient } from '../lumbre/client';
import type { LumbreSubtask, LumbreTask } from '../lumbre/types';
import { queryKey, queryParams, type ResolvedQuery } from './query-parser';
import { CONTEXT_SUBTASK_TASK_CAP } from './task-context';

/** Treinta segundos: lo que dice el lote, y lo que cabe en el límite de la API. */
export const DEFAULT_QUERY_TTL_MS = 30_000;

/**
 * Ventana en la que varias materializaciones seguidas comparten UNA ronda de
 * refresco. Materializar un lote de diez operaciones llamaba diez veces a
 * `refreshAll`, o sea diez lecturas por cada consulta montada, contra un límite
 * de 120 peticiones por minuto.
 */
export const REFRESH_COALESCE_MS = 250;

/**
 * Cuánto sobrevive una entrada SIN bloques montados. Las entradas huérfanas se
 * conservan a propósito (en modo lectura un bloque se desmonta y se remonta con
 * cada edición, y conservarla evita la petición y el parpadeo), pero ese ir y
 * venir dura segundos: pasados diez minutos ya nadie va a volver, y la entrada
 * solo ocupa memoria.
 */
export const IDLE_ENTRY_TTL_MS = 10 * 60_000;

/**
 * TTL propio de la caché de subtareas POR TAREA (ver `SubtaskCacheEntry` y
 * `attachContextSubtasks`). Dos minutos y no los 30 s del listado, a propósito:
 * refrescar el listado es UNA petición compartida entre todos los bloques que
 * pidan lo mismo; refrescar subtareas es una petición POR TAREA (`getTask`,
 * `?ids=` no las sirve, ver `task-context.ts`), así que su TTL puede ser más
 * largo sin que la tarea se vea más vieja de lo razonable. Antes de que
 * venciera este TTL, cada materialización de la cola disparaba `refreshAll` y
 * `refreshAll` volvía a pedir las subtareas de TODAS las tareas de la entrada,
 * no solo la que cambió: una nota con dos bloques `context: full` y cinco
 * casillas marcadas en un minuto eran hasta 5 × 2 × 20 = 200 peticiones extra
 * contra el cubo de 120/min de `GET /api/tasks` (hallazgo de revisión, 5 sep
 * 2026). Con esta caché, una tarea sin cambios dentro del TTL no vuelve a
 * pedirse aunque su consulta se refresque entera.
 */
export const SUBTASK_CACHE_TTL_MS = 2 * 60_000;

/** Lo que ve un bloque de su consulta. */
export interface QuerySnapshot {
	/** Última lectura confirmada. Vacía solo si nunca hubo ninguna. */
	tasks: LumbreTask[];
	/** Epoch ms de esa lectura, o `null` si todavía no ha habido ninguna buena. */
	fetchedAt: number | null;
	/** Motivo del último fallo, en castellano, o `null`. Nunca lleva el token. */
	error: string | null;
	/** Hay una petición en vuelo para esta consulta. */
	loading: boolean;
	/**
	 * `true` si la consulta es `context: full` y había más tareas de primer
	 * nivel que `CONTEXT_SUBTASK_TASK_CAP`: solo las primeras llevan subtareas.
	 * `false` con `context: none` o cuando no hizo falta recortar.
	 */
	subtasksLimited: boolean;
}

export type QuerySubscriber = (snapshot: QuerySnapshot) => void;

export interface QueryCacheOptions {
	/**
	 * `getTask` es OPCIONAL en el tipo (a diferencia de `listTasks`) para que un
	 * test que nunca pide `context: full` no tenga que simularlo. En el plugin
	 * real (`main.ts`) el cliente siempre lo trae.
	 */
	client: Pick<LumbreClient, 'listTasks'> & Partial<Pick<LumbreClient, 'getTask'>>;
	ttlMs?: number;
	/** Reloj, inyectable para los tests. */
	now?: () => number;
	/** La espera de la ventana de coalescencia. Inyectable para los tests. */
	wait?: (ms: number) => Promise<void>;
	/**
	 * Se llama tras cada lectura BUENA. Es por donde la API pública emite su
	 * `tasks-changed`: cualquier refresco cuenta, no solo las materializaciones.
	 */
	onRefresh?: () => void;
	/** Registro de diagnóstico. Sin él, la caché no apunta nada. */
	logger?: Logger;
}

/** Lo que la caché le dice al informe de diagnóstico. */
export interface CacheSnapshotStats {
	entries: number;
	/** Epoch ms de la lectura buena más VIEJA que sigue guardada, o `null`. */
	oldestFetchedAt: number | null;
}

interface CacheEntry {
	query: ResolvedQuery;
	tasks: LumbreTask[];
	fetchedAt: number | null;
	error: string | null;
	loading: boolean;
	/** Ver `QuerySnapshot.subtasksLimited`. */
	subtasksLimited: boolean;
	/** Invalidada a mano: la próxima lectura va al servidor aunque no haya vencido el TTL. */
	stale: boolean;
	/** Última vez que alguien la pidió o se suscribió. Es lo que mide el desalojo. */
	touchedAt: number;
	listeners: Set<QuerySubscriber>;
	inFlight: Promise<QuerySnapshot> | null;
}

/**
 * Lo que sabe la caché de subtareas de UNA tarea, por su id. `undefined` en
 * `subtasks` es un caso cacheado tan válido como cualquier otro: "se pidió y
 * no traía subtareas", que es distinto de "no se ha pedido nunca" (ese caso ni
 * siquiera crea la entrada, ver `attachContextSubtasks`).
 *
 * `done`/`cancelledAt`/`archivedAt`/`attachmentCount` son la instantánea del
 * momento en que se pidió: si alguno de los cuatro llega distinto en la
 * lectura siguiente, la tarea CAMBIÓ de verdad y la caché se invalida ANTES
 * del TTL. Una tarea recién materializada por la cola (completada, cancelada,
 * archivada...) cae aquí sin necesitar un aviso aparte: el campo que cambió es
 * justo uno de estos cuatro. Lo que esto NO detecta: una subtarea marcada
 * desde el panel sin que ninguno de los cuatro campos del PADRE cambie; ese
 * caso se queda con la lectura vieja hasta que venza `SUBTASK_CACHE_TTL_MS`,
 * aceptado a propósito (el criterio lo dio la revisión).
 */
interface SubtaskCacheEntry {
	subtasks: LumbreSubtask[] | undefined;
	fetchedAt: number;
	done: boolean;
	cancelledAt: string | null;
	archivedAt: string | null;
	attachmentCount: number | undefined;
}

export class QueryCache {
	/**
	 * Una entrada por consulta distinta. Las entradas sin suscriptores se quedan
	 * a propósito: en modo lectura un bloque se desmonta y se vuelve a montar con
	 * cada edición, y conservarla es lo que evita la petición (y el parpadeo) en
	 * ese ir y venir. Ese ir y venir dura segundos, así que pasados
	 * `IDLE_ENTRY_TTL_MS` sin nadie que las pida se desalojan (`evictIdle`).
	 */
	private readonly entries = new Map<string, CacheEntry>();
	/**
	 * Caché de subtareas POR TAREA (no por consulta): una tarea que aparece en
	 * dos consultas distintas (`scope: today` y `list: Casa`, por ejemplo) pide
	 * `getTask` UNA vez, no una por consulta. Ver `SubtaskCacheEntry` y
	 * `attachContextSubtasks`.
	 */
	private readonly subtaskCache = new Map<string, SubtaskCacheEntry>();
	private readonly ttlMs: number;
	private readonly now: () => number;
	private readonly wait: (ms: number) => Promise<void>;
	private readonly log: Logger | null;

	/** La ronda de refresco ya programada, si la hay. Es el pestillo de `refreshSoon`. */
	private scheduledRefresh: Promise<void> | null = null;

	constructor(private readonly options: QueryCacheOptions) {
		this.ttlMs = options.ttlMs ?? DEFAULT_QUERY_TTL_MS;
		this.now = options.now ?? ((): number => Date.now());
		this.wait =
			options.wait ??
			((ms: number): Promise<void> =>
				new Promise<void>((done) => {
					// `window.setTimeout` y no `setTimeout` a secas: en una ventana emergente
					// de Obsidian el temporizador tiene que ser el de ESA ventana.
					window.setTimeout(done, ms);
				}));
		this.log = options.logger ?? null;
	}

	/**
	 * Apunta a un bloque a los cambios de una consulta. Devuelve cómo darse de
	 * baja, que es lo que llama el bloque al desmontarse. Al irse el ÚLTIMO
	 * bloque se pasa el desalojo: la entrada solo cae si además lleva tiempo sin
	 * que nadie la pida (ver `IDLE_ENTRY_TTL_MS`).
	 */
	subscribe(query: ResolvedQuery, listener: QuerySubscriber): () => void {
		const entry = this.entryFor(query);
		entry.listeners.add(listener);
		return (): void => {
			entry.listeners.delete(listener);
			if (entry.listeners.size === 0) this.evictIdle();
		};
	}

	/**
	 * Lo que hay guardado, sin pedir nada y sin CREAR nada: preguntar por una
	 * consulta no es usarla, y crear la entrada aquí dejaba en el mapa una fila
	 * vacía por cada bloque que se pintaba antes de su primera lectura.
	 */
	peek(query: ResolvedQuery): QuerySnapshot {
		const entry = this.entries.get(queryKey(query));
		return entry === undefined ? emptySnapshot() : snapshot(entry);
	}

	/**
	 * La consulta. Va al servidor solo si la caché ha vencido, si se invalidó o si
	 * `force`. Dos llamadas a la vez sobre la misma consulta comparten petición.
	 */
	async get(query: ResolvedQuery, force = false): Promise<QuerySnapshot> {
		const entry = this.entryFor(query);
		if (!force && this.isFresh(entry)) {
			this.log?.debug('Caché de consultas: acierto', { key: queryKey(query) });
			return snapshot(entry);
		}
		this.log?.debug('Caché de consultas: hay que pedirla', {
			key: queryKey(query),
			reason: force ? 'forzada' : entry.stale ? 'invalidada' : 'caducada',
		});
		return this.load(entry);
	}

	/** Marca todas las consultas como caducadas, sin pedir nada todavía. */
	invalidate(reason = 'a mano'): void {
		for (const entry of this.entries.values()) entry.stale = true;
		this.log?.debug('Caché de consultas invalidada', { reason, entries: this.entries.size });
	}

	/** Lo que enseña el informe de diagnóstico. */
	stats(): CacheSnapshotStats {
		let oldest: number | null = null;
		for (const entry of this.entries.values()) {
			if (entry.fetchedAt === null) continue;
			if (oldest === null || entry.fetchedAt < oldest) oldest = entry.fetchedAt;
		}
		return { entries: this.entries.size, oldestFetchedAt: oldest };
	}

	/**
	 * Invalida y refresca las consultas que tengan algún bloque montado, todas a
	 * la vez y UNA petición por consulta distinta. Es lo que se llama cuando la
	 * cola materializa una operación, para que la casilla se asiente en todos los
	 * bloques que enseñen esa tarea.
	 */
	async refreshAll(reason = 'la cola ha materializado algo'): Promise<void> {
		this.evictIdle();
		this.invalidate(reason);
		const live = [...this.entries.values()].filter((entry) => entry.listeners.size > 0);
		this.log?.info('Refresco de las consultas con bloques montados', {
			reason,
			queries: live.length,
			cached: this.entries.size,
		});
		await Promise.all(live.map((entry) => this.load(entry)));
	}

	/**
	 * Un `refreshAll` COALESCIDO. Mientras hay uno programado, las llamadas que
	 * lleguen se enganchan a ese en vez de abrir otra ronda.
	 *
	 * Es lo que llama la cola al materializar, y por eso importa: la cola avisa
	 * UNA VEZ POR OPERACIÓN, así que un lote de diez operaciones eran diez rondas
	 * de lecturas, una por consulta montada, contra el límite de 120 peticiones
	 * por minuto de la API.
	 */
	refreshSoon(reason = 'la cola ha materializado algo'): Promise<void> {
		const already = this.scheduledRefresh;
		if (already !== null) {
			this.log?.debug('Refresco ya programado, no se abre otro', { reason });
			return already;
		}

		const scheduled = (async (): Promise<void> => {
			await this.wait(REFRESH_COALESCE_MS);
			// El pestillo se suelta ANTES de leer: lo que materialice DURANTE la ronda
			// merece su propia ronda detrás, o su cambio no se vería hasta el TTL.
			this.scheduledRefresh = null;
			await this.refreshAll(reason);
		})();

		this.scheduledRefresh = scheduled;
		return scheduled;
	}

	/** Cuántas consultas distintas hay guardadas. Para los tests y la depuración. */
	size(): number {
		return this.entries.size;
	}

	/**
	 * `true` si alguna consulta tiene al menos un bloque montado. Lo usa el
	 * sondeo de cambios (`ChangeFeed`, `src/lumbre/change-feed.ts`) para no
	 * pedir nada cuando no hay quien lo necesite: una entrada huérfana (ver
	 * `IDLE_ENTRY_TTL_MS`) no cuenta como "hay quien lo necesite".
	 */
	hasSubscribers(): boolean {
		for (const entry of this.entries.values()) {
			if (entry.listeners.size > 0) return true;
		}
		return false;
	}

	private entryFor(query: ResolvedQuery): CacheEntry {
		const key = queryKey(query);
		const existing = this.entries.get(key);
		if (existing !== undefined) {
			existing.touchedAt = this.now();
			return existing;
		}

		const created: CacheEntry = {
			query,
			tasks: [],
			fetchedAt: null,
			error: null,
			loading: false,
			subtasksLimited: false,
			stale: true,
			touchedAt: this.now(),
			listeners: new Set(),
			inFlight: null,
		};
		this.entries.set(key, created);
		return created;
	}

	/**
	 * Tira las entradas que no tienen bloques montados y llevan más de
	 * `IDLE_ENTRY_TTL_MS` sin que nadie las pida. Nunca toca una con suscriptores
	 * ni una con petición en vuelo.
	 */
	private evictIdle(): void {
		const cutoff = this.now() - IDLE_ENTRY_TTL_MS;
		let dropped = 0;
		for (const [key, entry] of this.entries) {
			if (entry.listeners.size > 0 || entry.inFlight !== null) continue;
			if (entry.touchedAt > cutoff) continue;
			this.entries.delete(key);
			dropped += 1;
		}
		if (dropped > 0) {
			this.log?.debug('Consultas desalojadas de la caché', { dropped, entries: this.entries.size });
		}
		this.evictIdleSubtasks();
	}

	/**
	 * Tira una fila de la caché de subtareas por tarea si lleva más de
	 * `IDLE_ENTRY_TTL_MS` sin refrescarse (MISMA constante que las consultas;
	 * `SUBTASK_CACHE_TTL_MS` decide cuándo hay que REFRESCAR una fila viva, no
	 * cuándo tirarla) o si ninguna consulta que sigue en la caché la referencia
	 * ya: una tarea que salió de todos los listados no necesita seguir ocupando
	 * memoria solo porque todavía no ha pasado el TTL de inactividad.
	 */
	private evictIdleSubtasks(): void {
		const referenced = new Set<string>();
		for (const entry of this.entries.values()) {
			for (const task of entry.tasks) referenced.add(task.id);
		}

		const cutoff = this.now() - IDLE_ENTRY_TTL_MS;
		let dropped = 0;
		for (const [taskId, cached] of this.subtaskCache) {
			if (cached.fetchedAt > cutoff && referenced.has(taskId)) continue;
			this.subtaskCache.delete(taskId);
			dropped += 1;
		}
		if (dropped > 0) {
			this.log?.debug('Subtareas desalojadas de la caché', {
				dropped,
				entries: this.subtaskCache.size,
			});
		}
	}

	private isFresh(entry: CacheEntry): boolean {
		if (entry.stale || entry.fetchedAt === null) return false;
		return this.now() - entry.fetchedAt < this.ttlMs;
	}

	/** Una sola petición en vuelo por consulta: las demás esperan a esa. */
	private async load(entry: CacheEntry): Promise<QuerySnapshot> {
		const running = entry.inFlight;
		if (running !== null) {
			this.log?.debug('Caché de consultas: petición deduplicada', {
				key: queryKey(entry.query),
			});
			return running;
		}

		const started = this.fetch(entry);
		entry.inFlight = started;
		try {
			return await started;
		} finally {
			if (entry.inFlight === started) entry.inFlight = null;
		}
	}

	private async fetch(entry: CacheEntry): Promise<QuerySnapshot> {
		entry.loading = true;
		this.notify(entry);

		const key = queryKey(entry.query);
		if (entry.query.context === 'full' && entry.query.notesExplicit && entry.query.notes !== 'full') {
			// `resolveQuery`/`queryParams` ya pisan el valor (ver su JSDoc); esto solo
			// avisa de que lo escrito por el usuario no es lo que viajó.
			this.log?.debug('context: full impone notes: full, se ignora lo escrito', {
				key,
				notesEscrito: entry.query.notes,
			});
		}

		const startedAt = this.now();
		const read = await this.options.client.listTasks(queryParams(entry.query));
		entry.loading = false;

		if (read.ok) {
			const { tasks, subtasksLimited } = await this.attachContextSubtasks(entry, read.value);
			entry.tasks = tasks;
			entry.subtasksLimited = subtasksLimited;
			entry.fetchedAt = this.now();
			entry.stale = false;
			entry.error = null;
			this.log?.info('Consulta leída', {
				key,
				tasks: read.value.length,
				ms: this.now() - startedAt,
				...(entry.query.context === 'full' ? { subtasksLimited } : {}),
			});
		} else {
			// Lo leído NO se borra: sin red se sigue enseñando la última lectura
			// confirmada con su hora, que es el trato del bloque.
			entry.error = describeFailure(read.reason, read.status);
			this.log?.warn('Consulta fallida, se conserva la última lectura', {
				key,
				reason: read.reason,
				status: read.status,
				hadPrevious: entry.fetchedAt !== null,
				tasks: entry.tasks.length,
			});
		}

		this.notify(entry);
		if (read.ok) this.options.onRefresh?.();
		return snapshot(entry);
	}

	/**
	 * Con `context: none`, no hace nada (la mayoría de las lecturas). Con
	 * `context: full`, asegura que las primeras `CONTEXT_SUBTASK_TASK_CAP`
	 * tareas de primer nivel tengan subtareas FRESCAS en `this.subtaskCache`
	 * (pidiendo `getTask(id)` solo para las que hagan falta, ver
	 * `needsSubtaskFetch`) y las adjunta a la tarea. `getTask` es el ÚNICO
	 * camino que trae subtareas (ver el HECHO MEDIDO en `task-context.ts`,
	 * `?ids=` no las sirve). Un fallo puntual de una de esas peticiones no tira
	 * la lectura entera ni pisa lo que ya hubiera en caché: esa tarea
	 * sencillamente no se actualiza esta vez.
	 */
	private async attachContextSubtasks(
		entry: CacheEntry,
		tasks: LumbreTask[],
	): Promise<{ tasks: LumbreTask[]; subtasksLimited: boolean }> {
		const getTask = this.options.client.getTask;
		if (entry.query.context !== 'full' || getTask === undefined) {
			return { tasks, subtasksLimited: false };
		}

		const topLevel = tasks.filter((task) => task.parentId === null);
		const candidates = topLevel.slice(0, CONTEXT_SUBTASK_TASK_CAP);
		if (candidates.length === 0) return { tasks, subtasksLimited: false };

		const now = this.now();
		const toFetch = candidates.filter((task) => this.needsSubtaskFetch(task, now));
		if (toFetch.length > 0) {
			this.log?.debug('Pidiendo subtareas por tarea', {
				key: queryKey(entry.query),
				candidates: candidates.length,
				toFetch: toFetch.length,
			});
			const results = await Promise.all(
				toFetch.map(async (task) => ({ task, result: await getTask(task.id) })),
			);
			for (const { task, result } of results) {
				// Un fallo puntual NO se cachea: mejor reintentar en la próxima
				// lectura que quedarse pegado con un `fetchedAt` de ahora mismo sin
				// haber conseguido nada.
				if (!result.ok || result.value === null) continue;
				this.subtaskCache.set(task.id, {
					subtasks: result.value.subtasks,
					fetchedAt: now,
					done: task.done,
					cancelledAt: task.cancelledAt,
					archivedAt: task.archivedAt,
					attachmentCount: task.attachmentCount,
				});
			}
		}

		const withSubtasks = tasks.map((task) => {
			const cached = this.subtaskCache.get(task.id);
			if (cached === undefined || cached.subtasks === undefined) return task;
			return { ...task, subtasks: cached.subtasks };
		});

		return { tasks: withSubtasks, subtasksLimited: topLevel.length > CONTEXT_SUBTASK_TASK_CAP };
	}

	/**
	 * `true` si hace falta pedir `getTask` para esta tarea: sin nada en caché,
	 * con la caché vencida (`SUBTASK_CACHE_TTL_MS`), o con alguno de los cuatro
	 * campos que delatan un cambio real (`done`, `cancelledAt`, `archivedAt`,
	 * `attachmentCount`) distinto de la instantánea guardada. Ver el JSDoc de
	 * `SubtaskCacheEntry` para el porqué de justo estos cuatro campos.
	 */
	private needsSubtaskFetch(task: LumbreTask, now: number): boolean {
		const cached = this.subtaskCache.get(task.id);
		if (cached === undefined) return true;
		if (now - cached.fetchedAt >= SUBTASK_CACHE_TTL_MS) return true;
		return (
			cached.done !== task.done ||
			cached.cancelledAt !== task.cancelledAt ||
			cached.archivedAt !== task.archivedAt ||
			cached.attachmentCount !== task.attachmentCount
		);
	}

	private notify(entry: CacheEntry): void {
		const current = snapshot(entry);
		for (const listener of entry.listeners) listener(current);
	}
}

/** Lo que ve quien pregunta por una consulta de la que no hay nada guardado. */
function emptySnapshot(): QuerySnapshot {
	return { tasks: [], fetchedAt: null, error: null, loading: false, subtasksLimited: false };
}

function snapshot(entry: CacheEntry): QuerySnapshot {
	return {
		tasks: entry.tasks,
		fetchedAt: entry.fetchedAt,
		error: entry.error,
		subtasksLimited: entry.subtasksLimited,
		loading: entry.loading,
	};
}
