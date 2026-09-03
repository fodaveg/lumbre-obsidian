/**
 * Caché en memoria de las listas de Lumbre.
 *
 * El desplegable del modal y la sección de nota de proyecto necesitan los
 * nombres de las listas, y `listLists()` es una petición contra un endpoint con
 * límite de 120 llamadas por minuto: pedirlas cada vez que se abre el modal es
 * gasto puro, porque las listas casi nunca cambian dentro de una sesión.
 *
 * Es caché, no fuente: si la relectura falla se devuelve lo último leído, nunca
 * un array vacío que se leería como "no tienes listas". Y no se persiste a
 * `data.json` a propósito: al arrancar Obsidian se vuelve a pedir, que es
 * barato, y así no hay listas fantasma de hace semanas.
 */

import { normalizeForSearch } from '../ui/search-filter';
import type { LumbreClient } from './client';
import type { LumbreList, LumbreRef } from './types';

export interface ListCacheOptions {
	client: Pick<LumbreClient, 'listLists'>;
	/** Cuánto vale una lectura antes de volver a pedirla. */
	ttlMs?: number;
	/** Reloj, inyectable para los tests. */
	now?: () => number;
}

/** Cinco minutos: lo bastante corto para no enseñar una lista borrada mucho rato. */
export const DEFAULT_LIST_TTL_MS = 5 * 60 * 1000;

export class ListCache {
	private lists: LumbreList[] = [];
	private fetchedAt: number | null = null;
	private inFlight: Promise<LumbreList[]> | null = null;
	private readonly ttlMs: number;
	private readonly now: () => number;

	constructor(private readonly options: ListCacheOptions) {
		this.ttlMs = options.ttlMs ?? DEFAULT_LIST_TTL_MS;
		this.now = options.now ?? ((): number => Date.now());
	}

	/** Lo último leído, sin pedir nada. Puede estar vacío si aún no se ha leído. */
	cached(): LumbreList[] {
		return this.lists;
	}

	/** La referencia (id + nombre) de una lista cacheada, o `null`. */
	refFor(listId: string | null): LumbreRef | null {
		if (listId === null) return null;
		const found = this.lists.find((list) => list.id === listId);
		return found === undefined ? null : { id: found.id, name: found.name };
	}

	/**
	 * El NOMBRE de una lista a partir de su id O de su nombre, o `null` si no
	 * está en la caché. Lo necesitan las consultas de los bloques: `?list=` filtra
	 * por nombre, pero `lumbre-list` guarda un id y el usuario escribe cualquiera
	 * de los dos. El nombre se compara sin tildes ni mayúsculas.
	 */
	nameFor(raw: string): string | null {
		const byId = this.lists.find((list) => list.id === raw);
		if (byId !== undefined) return byId.name;
		const needle = normalizeForSearch(raw);
		const byName = this.lists.find((list) => normalizeForSearch(list.name) === needle);
		return byName?.name ?? null;
	}

	/**
	 * Las listas, releídas si la caché ha caducado. Una sola lectura en vuelo: si
	 * ya hay una corriendo, esta llamada espera a esa. Si la lectura falla se
	 * devuelve la caché tal cual, sin marcar como fresca.
	 */
	async get(): Promise<LumbreList[]> {
		if (this.fetchedAt !== null && this.now() - this.fetchedAt < this.ttlMs) return this.lists;

		const running = this.inFlight;
		if (running !== null) return running;

		const started = this.fetch();
		this.inFlight = started;
		try {
			return await started;
		} finally {
			if (this.inFlight === started) this.inFlight = null;
		}
	}

	/** Fuerza que la siguiente lectura vaya al servidor. */
	invalidate(): void {
		this.fetchedAt = null;
	}

	private async fetch(): Promise<LumbreList[]> {
		const read = await this.options.client.listLists();
		if (!read.ok) return this.lists;
		this.lists = read.value;
		this.fetchedAt = this.now();
		return this.lists;
	}
}
