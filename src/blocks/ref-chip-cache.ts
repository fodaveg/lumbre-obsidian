/**
 * Caché de las tareas que aparecen en fichas de referencia
 * (`[[task:ID|Etiqueta]]` pegado desde Lumbre), por id de tarea.
 *
 * Existe por el mismo motivo que `QueryCache`: sin ella, cada remontado de la
 * sección en modo lectura (o cada nota con varias referencias a la misma
 * tarea) volvería a pedir lo que ya se acaba de leer. Comparte su TTL
 * (`DEFAULT_QUERY_TTL_MS`, 30 s): son fichas de la MISMA API con el mismo
 * cubo de 120/min, no hay motivo para que caduquen distinto.
 *
 * Módulo puro: no importa `obsidian`. Quien pide la lectura (`fetchMany`) se
 * inyecta, igual que en el resto de cachés del plugin.
 */

import type { Logger } from '../diagnostics/logger';
import type { LumbreResult } from '../lumbre/client';
import type { LumbreTask } from '../lumbre/types';
import { DEFAULT_QUERY_TTL_MS } from './query-cache';

interface CacheEntry {
	/** La tarea, o `null` si Lumbre confirmó que ese id ya no existe. */
	task: LumbreTask | null;
	fetchedAt: number;
}

export type RefFetchMany = (ids: string[]) => Promise<LumbreResult<LumbreTask[]>>;

/**
 * Lo que sabe la caché de un id tras `resolve`: la tarea, `null` si Lumbre
 * confirmó que no existe, o `undefined` si nunca se consiguió leer (nunca se
 * pidió, o la última lectura falló y no había nada guardado de antes). El
 * llamante trata `null`/`undefined` igual: sin dato, el chip se queda con el
 * texto de la referencia.
 */
export type RefLookup = LumbreTask | null | undefined;

export interface RefTaskCacheOptions {
	ttlMs?: number;
	/** Reloj, inyectable para los tests. */
	now?: () => number;
	logger?: Logger;
}

export class RefTaskCache {
	private readonly entries = new Map<string, CacheEntry>();
	private readonly ttlMs: number;
	private readonly now: () => number;
	private readonly log: Logger | null;

	constructor(options: RefTaskCacheOptions = {}) {
		this.ttlMs = options.ttlMs ?? DEFAULT_QUERY_TTL_MS;
		this.now = options.now ?? ((): number => Date.now());
		this.log = options.logger ?? null;
	}

	/** Lo que hay guardado para un id, sin pedir nada. */
	peek(id: string): RefLookup {
		return this.entries.get(id)?.task;
	}

	/**
	 * Resuelve una lista de ids de tarea (puede traer repetidos: se dedupan).
	 * Los que ya están FRESCOS no vuelven a pedirse; el resto se piden de
	 * golpe en UNA sola llamada a `fetchMany`, nunca una por id. Si no queda
	 * ninguno por pedir, `fetchMany` no se llama.
	 *
	 * Si la lectura falla, la caché NO se toca: los ids que ya tenían algo
	 * guardado siguen sirviendo esa última lectura (aunque haya caducado) y
	 * los que no tenían nada quedan `undefined`. El fallo se reintenta en la
	 * siguiente llamada, nunca se cachea.
	 */
	async resolve(ids: readonly string[], fetchMany: RefFetchMany): Promise<Map<string, RefLookup>> {
		const unique = [...new Set(ids)];
		const now = this.now();
		const stale = unique.filter((id) => !this.isFresh(id, now));

		if (stale.length > 0) {
			this.log?.debug('Caché de referencias: pidiendo', {
				total: unique.length,
				aPedir: stale.length,
			});
			const result = await fetchMany(stale);
			if (result.ok) {
				const byId = new Map(result.value.map((task) => [task.id, task]));
				const fetchedAt = this.now();
				for (const id of stale) {
					this.entries.set(id, { task: byId.get(id) ?? null, fetchedAt });
				}
			} else {
				this.log?.warn('Caché de referencias: lectura fallida, se conserva lo que había', {
					reason: result.reason,
					status: result.status,
				});
			}
		}

		const out = new Map<string, RefLookup>();
		for (const id of unique) out.set(id, this.entries.get(id)?.task);
		return out;
	}

	private isFresh(id: string, now: number): boolean {
		const entry = this.entries.get(id);
		if (entry === undefined) return false;
		return now - entry.fetchedAt < this.ttlMs;
	}
}
