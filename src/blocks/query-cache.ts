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

import { describeFailure, type LumbreClient } from '../lumbre/client';
import type { LumbreTask } from '../lumbre/types';
import { queryKey, queryParams, type ResolvedQuery } from './query-parser';

/** Treinta segundos: lo que dice el lote, y lo que cabe en el límite de la API. */
export const DEFAULT_QUERY_TTL_MS = 30_000;

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
	/**
	 * Se llama tras cada lectura BUENA. Es por donde la API pública emite su
	 * `tasks-changed`: cualquier refresco cuenta, no solo las materializaciones.
	 */
	onRefresh?: () => void;
}

interface CacheEntry {
	query: ResolvedQuery;
	tasks: LumbreTask[];
	fetchedAt: number | null;
	error: string | null;
	loading: boolean;
	/** Invalidada a mano: la próxima lectura va al servidor aunque no haya vencido el TTL. */
	stale: boolean;
	listeners: Set<QuerySubscriber>;
	inFlight: Promise<QuerySnapshot> | null;
}

export class QueryCache {
	/**
	 * Una entrada por consulta distinta. Las entradas sin suscriptores se quedan
	 * a propósito: en modo lectura un bloque se desmonta y se vuelve a montar con
	 * cada edición, y conservarla es lo que evita la petición (y el parpadeo) en
	 * ese ir y venir. El conjunto de consultas distintas de un vault es pequeño y
	 * lo escribe el usuario, así que no crece solo.
	 */
	private readonly entries = new Map<string, CacheEntry>();
	private readonly ttlMs: number;
	private readonly now: () => number;

	constructor(private readonly options: QueryCacheOptions) {
		this.ttlMs = options.ttlMs ?? DEFAULT_QUERY_TTL_MS;
		this.now = options.now ?? ((): number => Date.now());
	}

	/**
	 * Apunta a un bloque a los cambios de una consulta. Devuelve cómo darse de
	 * baja, que es lo que llama el bloque al desmontarse.
	 */
	subscribe(query: ResolvedQuery, listener: QuerySubscriber): () => void {
		const entry = this.entryFor(query);
		entry.listeners.add(listener);
		return (): void => {
			entry.listeners.delete(listener);
		};
	}

	/** Lo que hay guardado, sin pedir nada. */
	peek(query: ResolvedQuery): QuerySnapshot {
		return snapshot(this.entryFor(query));
	}

	/**
	 * La consulta. Va al servidor solo si la caché ha vencido, si se invalidó o si
	 * `force`. Dos llamadas a la vez sobre la misma consulta comparten petición.
	 */
	async get(query: ResolvedQuery, force = false): Promise<QuerySnapshot> {
		const entry = this.entryFor(query);
		if (!force && this.isFresh(entry)) return snapshot(entry);
		return this.load(entry);
	}

	/** Marca todas las consultas como caducadas, sin pedir nada todavía. */
	invalidate(): void {
		for (const entry of this.entries.values()) entry.stale = true;
	}

	/**
	 * Invalida y refresca las consultas que tengan algún bloque montado, todas a
	 * la vez y UNA petición por consulta distinta. Es lo que se llama cuando la
	 * cola materializa una operación, para que la casilla se asiente en todos los
	 * bloques que enseñen esa tarea.
	 */
	async refreshAll(): Promise<void> {
		this.invalidate();
		const live = [...this.entries.values()].filter((entry) => entry.listeners.size > 0);
		await Promise.all(live.map((entry) => this.load(entry)));
	}

	/** Cuántas consultas distintas hay guardadas. Para los tests y la depuración. */
	size(): number {
		return this.entries.size;
	}

	private entryFor(query: ResolvedQuery): CacheEntry {
		const key = queryKey(query);
		const existing = this.entries.get(key);
		if (existing !== undefined) return existing;

		const created: CacheEntry = {
			query,
			tasks: [],
			fetchedAt: null,
			error: null,
			loading: false,
			stale: true,
			listeners: new Set(),
			inFlight: null,
		};
		this.entries.set(key, created);
		return created;
	}

	private isFresh(entry: CacheEntry): boolean {
		if (entry.stale || entry.fetchedAt === null) return false;
		return this.now() - entry.fetchedAt < this.ttlMs;
	}

	/** Una sola petición en vuelo por consulta: las demás esperan a esa. */
	private async load(entry: CacheEntry): Promise<QuerySnapshot> {
		const running = entry.inFlight;
		if (running !== null) return running;

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

		const read = await this.options.client.listTasks(queryParams(entry.query));
		entry.loading = false;

		if (read.ok) {
			entry.tasks = read.value;
			entry.fetchedAt = this.now();
			entry.stale = false;
			entry.error = null;
		} else {
			// Lo leído NO se borra: sin red se sigue enseñando la última lectura
			// confirmada con su hora, que es el trato del bloque.
			entry.error = describeFailure(read.reason, read.status);
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

function snapshot(entry: CacheEntry): QuerySnapshot {
	return {
		tasks: entry.tasks,
		fetchedAt: entry.fetchedAt,
		error: entry.error,
		loading: entry.loading,
	};
}
