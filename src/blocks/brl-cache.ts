/**
 * Caché compartida de los bloques ```lumbre-brl```.
 *
 * Es la gemela de `QueryCache` para el registro del día: una entrada por DÍA
 * (esa es la clave, distinta de la de las consultas de tareas), el mismo TTL de
 * 30 segundos, una sola petición en vuelo por día y los mismos dos tratos:
 *
 * - Si la lectura falla, la anterior NO se borra: se guarda el motivo y se
 *   sigue sirviendo el último Markdown confirmado con su hora.
 * - Cuando la cola materializa algo, la caché entera caduca y los días con
 *   bloques montados se refrescan de golpe, uno por día distinto.
 *
 * Va aparte de `QueryCache` y no dentro porque lo que guarda es otra cosa:
 * `QueryCache` guarda `LumbreTask[]` de una `ResolvedQuery`, y esto guarda un
 * día del registro. Comparten la constante del TTL, que es lo que de verdad
 * tiene que ir a la vez.
 *
 * Un día del registro se sirve por DOS caminos, y esta clase los trata como
 * dos cosas DISTINTAS a propósito (medido el 18 sep 2026: mientras fueron un
 * único `Promise.all`, cada refresco del bloque gastaba las DOS peticiones del
 * mismo cubo, `GET /api/brl/[date]`, aunque solo una de las dos tuviera algún
 * consumidor):
 *
 * - `get`/`peek`/`subscribe`/`refreshAll` (lo que usa el bloque en vivo,
 *   `LumbreBrlBlock`): UNA petición por refresco, `GET
 *   /api/brl/<date>?format=json`, las entradas CON su id, que es lo único que
 *   pinta el bloque desde que edita y borra entradas sueltas. Cacheado, TTL de
 *   30 s, una petición en vuelo por día, se invalida al materializar.
 * - `getMarkdown` (lo único que usa el comando «Insertar el BRL de hoy como
 *   texto», `insertBrlToday` en `main.ts`): UNA petición POR LLAMADA, `GET
 *   /api/brl/<date>` sin `?format=json`. SIN caché a propósito: es una foto
 *   fija que el usuario pide a mano y que ESCRIBE en la nota, así que la
 *   última lectura buena de hace un rato no vale (ver su JSDoc); cachearla
 *   aquí solo complicaría este fichero con un estado que nadie más comparte.
 *
 * No importa `obsidian`: recibe el cliente por inyección, igual que el resto.
 */

import type { Logger } from '../diagnostics/logger';
import { describeFailure, type BrlEntryRow, type LumbreClient, type LumbreFailure } from '../lumbre/client';
import { DEFAULT_QUERY_TTL_MS, IDLE_ENTRY_TTL_MS, type CacheSnapshotStats } from './query-cache';

/** Lo que ve un bloque de su día. Sin Markdown: el bloque pinta entrada por entrada (ver `brl-block.ts`). */
export interface BrlSnapshot {
	/** Las entradas del día, con su id: lo que hace falta para editar o borrar una. */
	entries: BrlEntryRow[];
	/** Epoch ms de esa lectura, o `null` si todavía no ha habido ninguna buena. */
	fetchedAt: number | null;
	/** Motivo del último fallo, en castellano, o `null`. Nunca lleva el token. */
	error: string | null;
	/** Hay una petición en vuelo para este día. */
	loading: boolean;
}

/** Lo que devuelve `getMarkdown`: una lectura SUELTA, sin caché (ver el JSDoc del fichero). */
export interface BrlMarkdownSnapshot {
	/** El Markdown, o cadena vacía si la lectura falló. */
	markdown: string;
	/** Epoch ms de ESTA lectura, o `null` si ha fallado. */
	fetchedAt: number | null;
	/** Motivo del fallo, en castellano, o `null`. Nunca lleva el token. */
	error: string | null;
}

export type BrlSubscriber = (snapshot: BrlSnapshot) => void;

export interface BrlCacheOptions {
	client: Pick<LumbreClient, 'brl' | 'brlJson'>;
	ttlMs?: number;
	/** Reloj, inyectable para los tests. */
	now?: () => number;
	/** Registro de diagnóstico. Sin él, la caché no apunta nada. */
	logger?: Logger;
}

interface BrlEntry {
	date: string;
	entries: BrlEntryRow[];
	fetchedAt: number | null;
	error: string | null;
	loading: boolean;
	stale: boolean;
	/** Última vez que alguien lo pidió o se suscribió. Es lo que mide el desalojo. */
	touchedAt: number;
	listeners: Set<BrlSubscriber>;
	inFlight: Promise<BrlSnapshot> | null;
}

export class BrlCache {
	private readonly entries = new Map<string, BrlEntry>();
	private readonly ttlMs: number;
	private readonly now: () => number;
	private readonly log: Logger | null;

	constructor(private readonly options: BrlCacheOptions) {
		this.ttlMs = options.ttlMs ?? DEFAULT_QUERY_TTL_MS;
		this.now = options.now ?? ((): number => Date.now());
		this.log = options.logger ?? null;
	}

	/** Apunta a un bloque a los cambios de un día. Devuelve cómo darse de baja. */
	subscribe(date: string, listener: BrlSubscriber): () => void {
		const entry = this.entryFor(date);
		entry.listeners.add(listener);
		return (): void => {
			entry.listeners.delete(listener);
			if (entry.listeners.size === 0) this.evictIdle();
		};
	}

	/**
	 * Lo que hay guardado, sin pedir nada y sin CREAR nada: igual que en
	 * `QueryCache`, preguntar por un día no es usarlo.
	 */
	peek(date: string): BrlSnapshot {
		const entry = this.entries.get(date);
		return entry === undefined ? emptySnapshot() : snapshot(entry);
	}

	/** El día. Va al servidor solo si venció el TTL, si se invalidó o si `force`. */
	async get(date: string, force = false): Promise<BrlSnapshot> {
		const entry = this.entryFor(date);
		if (!force && this.isFresh(entry)) {
			this.log?.debug('Caché del BRL: acierto', { date });
			return snapshot(entry);
		}
		return this.load(entry);
	}

	/** Marca todos los días como caducados, sin pedir nada todavía. */
	invalidate(reason = 'a mano'): void {
		for (const entry of this.entries.values()) entry.stale = true;
		this.log?.debug('Caché del BRL invalidada', { reason, entries: this.entries.size });
	}

	/** Invalida y refresca los días con algún bloque montado, una petición por día. */
	async refreshAll(reason = 'una entrada nueva del registro'): Promise<void> {
		this.evictIdle();
		this.invalidate(reason);
		const live = [...this.entries.values()].filter((entry) => entry.listeners.size > 0);
		this.log?.info('Refresco del registro del día', { reason, days: live.length });
		await Promise.all(live.map((entry) => this.load(entry)));
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

	private entryFor(date: string): BrlEntry {
		const existing = this.entries.get(date);
		if (existing !== undefined) {
			existing.touchedAt = this.now();
			return existing;
		}

		const created: BrlEntry = {
			date,
			entries: [],
			fetchedAt: null,
			error: null,
			loading: false,
			stale: true,
			touchedAt: this.now(),
			listeners: new Set(),
			inFlight: null,
		};
		this.entries.set(date, created);
		return created;
	}

	/**
	 * Tira los días sin bloques montados que llevan más de `IDLE_ENTRY_TTL_MS`
	 * sin que nadie los pida. Un vault abierto un mes acumulaba un día por cada
	 * fecha mirada, con su Markdown entero dentro.
	 */
	private evictIdle(): void {
		const cutoff = this.now() - IDLE_ENTRY_TTL_MS;
		let dropped = 0;
		for (const [date, entry] of this.entries) {
			if (entry.listeners.size > 0 || entry.inFlight !== null) continue;
			if (entry.touchedAt > cutoff) continue;
			this.entries.delete(date);
			dropped += 1;
		}
		if (dropped > 0) {
			this.log?.debug('Días del registro desalojados de la caché', {
				dropped,
				entries: this.entries.size,
			});
		}
	}

	private isFresh(entry: BrlEntry): boolean {
		if (entry.stale || entry.fetchedAt === null) return false;
		return this.now() - entry.fetchedAt < this.ttlMs;
	}

	private async load(entry: BrlEntry): Promise<BrlSnapshot> {
		const running = entry.inFlight;
		if (running !== null) {
			this.log?.debug('Caché del BRL: petición deduplicada', { date: entry.date });
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

	private async fetch(entry: BrlEntry): Promise<BrlSnapshot> {
		entry.loading = true;
		this.notify(entry);

		// UNA petición, `?format=json`: es lo único que necesita el bloque en vivo
		// (ver el JSDoc del fichero sobre por qué el Markdown va aparte, en
		// `getMarkdown`, y ni se pide aquí).
		const read = await this.options.client.brlJson(entry.date);
		entry.loading = false;

		if (read.ok) {
			entry.entries = read.value.entries;
			entry.fetchedAt = this.now();
			entry.stale = false;
			entry.error = null;
			this.log?.info('Registro del día leído', { date: entry.date, entries: read.value.entries.length });
		} else {
			// Lo leído NO se borra: sin red se sigue enseñando la última lectura
			// confirmada con su hora, igual que en el bloque de tareas.
			entry.error = this.describeBrlFailure(read);
			this.log?.warn('Registro del día fallido, se conserva la última lectura', {
				date: entry.date,
				reason: read.reason,
				status: read.status,
				hadPrevious: entry.fetchedAt !== null,
			});
		}

		this.notify(entry);
		return snapshot(entry);
	}

	/**
	 * El Markdown de un día, en UNA petición suelta y SIN caché (ver el JSDoc del
	 * fichero): el único consumidor es «Insertar el BRL de hoy como texto», que
	 * siempre quiere una lectura fresca y nunca la última buena.
	 */
	async getMarkdown(date: string): Promise<BrlMarkdownSnapshot> {
		const read = await this.options.client.brl(date);
		if (read.ok) {
			this.log?.info('Markdown del BRL leído', { date, chars: read.value.length });
			return { markdown: read.value, fetchedAt: this.now(), error: null };
		}
		this.log?.warn('Markdown del BRL fallido', { date, reason: read.reason, status: read.status });
		return { markdown: '', fetchedAt: null, error: this.describeBrlFailure(read) };
	}

	/**
	 * El motivo de un fallo, en castellano. Con el add-on BRL apagado Lumbre
	 * responde 403 a los DOS caminos (`brl` y `brlJson`), así que el mensaje
	 * especial se comparte entre `fetch` y `getMarkdown`.
	 */
	private describeBrlFailure(failure: LumbreFailure): string {
		return failure.reason === 'unauthorized' && failure.status === 403
			? 'El add-on BRL está desactivado en tu cuenta de Lumbre.'
			: describeFailure(failure.reason, failure.status);
	}

	private notify(entry: BrlEntry): void {
		const current = snapshot(entry);
		for (const listener of entry.listeners) listener(current);
	}
}

/** Lo que ve quien pregunta por un día del que no hay nada guardado. */
function emptySnapshot(): BrlSnapshot {
	return { entries: [], fetchedAt: null, error: null, loading: false };
}

function snapshot(entry: BrlEntry): BrlSnapshot {
	return {
		entries: entry.entries,
		fetchedAt: entry.fetchedAt,
		error: entry.error,
		loading: entry.loading,
	};
}
