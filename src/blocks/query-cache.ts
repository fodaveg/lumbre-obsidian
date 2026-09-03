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
import type { LumbreTask } from '../lumbre/types';
import { queryKey, queryParams, type ResolvedQuery } from './query-parser';

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
}

export type QuerySubscriber = (snapshot: QuerySnapshot) => void;

export interface QueryCacheOptions {
	client: Pick<LumbreClient, 'listTasks'>;
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
	/** Invalidada a mano: la próxima lectura va al servidor aunque no haya vencido el TTL. */
	stale: boolean;
	/** Última vez que alguien la pidió o se suscribió. Es lo que mide el desalojo. */
	touchedAt: number;
	listeners: Set<QuerySubscriber>;
	inFlight: Promise<QuerySnapshot> | null;
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
		const startedAt = this.now();
		const read = await this.options.client.listTasks(queryParams(entry.query));
		entry.loading = false;

		if (read.ok) {
			entry.tasks = read.value;
			entry.fetchedAt = this.now();
			entry.stale = false;
			entry.error = null;
			this.log?.info('Consulta leída', {
				key,
				tasks: read.value.length,
				ms: this.now() - startedAt,
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

	private notify(entry: CacheEntry): void {
		const current = snapshot(entry);
		for (const listener of entry.listeners) listener(current);
	}
}

/** Lo que ve quien pregunta por una consulta de la que no hay nada guardado. */
function emptySnapshot(): QuerySnapshot {
	return { tasks: [], fetchedAt: null, error: null, loading: false };
}

function snapshot(entry: CacheEntry): QuerySnapshot {
	return {
		tasks: entry.tasks,
		fetchedAt: entry.fetchedAt,
		error: entry.error,
		loading: entry.loading,
	};
}
