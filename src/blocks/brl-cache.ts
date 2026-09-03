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
 * `QueryCache` guarda `LumbreTask[]` de una `ResolvedQuery`, y esto guarda el
 * Markdown de un día. Comparten la constante del TTL, que es lo que de verdad
 * tiene que ir a la vez.
 *
 * No importa `obsidian`: recibe el cliente por inyección, igual que el resto.
 */

import { describeFailure, type LumbreClient } from '../lumbre/client';
import { DEFAULT_QUERY_TTL_MS } from './query-cache';

/** Lo que ve un bloque de su día. */
export interface BrlSnapshot {
	/** Último Markdown confirmado. Vacío solo si nunca hubo lectura buena. */
	markdown: string;
	/** Epoch ms de esa lectura, o `null` si todavía no ha habido ninguna buena. */
	fetchedAt: number | null;
	/** Motivo del último fallo, en castellano, o `null`. Nunca lleva el token. */
	error: string | null;
	/** Hay una petición en vuelo para este día. */
	loading: boolean;
}

export type BrlSubscriber = (snapshot: BrlSnapshot) => void;

export interface BrlCacheOptions {
	client: Pick<LumbreClient, 'brl'>;
	ttlMs?: number;
	/** Reloj, inyectable para los tests. */
	now?: () => number;
}

interface BrlEntry {
	date: string;
	markdown: string;
	fetchedAt: number | null;
	error: string | null;
	loading: boolean;
	stale: boolean;
	listeners: Set<BrlSubscriber>;
	inFlight: Promise<BrlSnapshot> | null;
}

export class BrlCache {
	private readonly entries = new Map<string, BrlEntry>();
	private readonly ttlMs: number;
	private readonly now: () => number;

	constructor(private readonly options: BrlCacheOptions) {
		this.ttlMs = options.ttlMs ?? DEFAULT_QUERY_TTL_MS;
		this.now = options.now ?? ((): number => Date.now());
	}

	/** Apunta a un bloque a los cambios de un día. Devuelve cómo darse de baja. */
	subscribe(date: string, listener: BrlSubscriber): () => void {
		const entry = this.entryFor(date);
		entry.listeners.add(listener);
		return (): void => {
			entry.listeners.delete(listener);
		};
	}

	/** Lo que hay guardado, sin pedir nada. */
	peek(date: string): BrlSnapshot {
		return snapshot(this.entryFor(date));
	}

	/** El día. Va al servidor solo si venció el TTL, si se invalidó o si `force`. */
	async get(date: string, force = false): Promise<BrlSnapshot> {
		const entry = this.entryFor(date);
		if (!force && this.isFresh(entry)) return snapshot(entry);
		return this.load(entry);
	}

	/** Marca todos los días como caducados, sin pedir nada todavía. */
	invalidate(): void {
		for (const entry of this.entries.values()) entry.stale = true;
	}

	/** Invalida y refresca los días con algún bloque montado, una petición por día. */
	async refreshAll(): Promise<void> {
		this.invalidate();
		const live = [...this.entries.values()].filter((entry) => entry.listeners.size > 0);
		await Promise.all(live.map((entry) => this.load(entry)));
	}

	private entryFor(date: string): BrlEntry {
		const existing = this.entries.get(date);
		if (existing !== undefined) return existing;

		const created: BrlEntry = {
			date,
			markdown: '',
			fetchedAt: null,
			error: null,
			loading: false,
			stale: true,
			listeners: new Set(),
			inFlight: null,
		};
		this.entries.set(date, created);
		return created;
	}

	private isFresh(entry: BrlEntry): boolean {
		if (entry.stale || entry.fetchedAt === null) return false;
		return this.now() - entry.fetchedAt < this.ttlMs;
	}

	private async load(entry: BrlEntry): Promise<BrlSnapshot> {
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

	private async fetch(entry: BrlEntry): Promise<BrlSnapshot> {
		entry.loading = true;
		this.notify(entry);

		const read = await this.options.client.brl(entry.date);
		entry.loading = false;

		if (read.ok) {
			entry.markdown = read.value;
			entry.fetchedAt = this.now();
			entry.stale = false;
			entry.error = null;
		} else {
			// Lo leído NO se borra: sin red se sigue enseñando la última lectura
			// confirmada con su hora, igual que en el bloque de tareas.
			entry.error =
				read.reason === 'unauthorized' && read.status === 403
					? 'El add-on BRL está desactivado en tu cuenta de Lumbre.'
					: describeFailure(read.reason, read.status);
		}

		this.notify(entry);
		return snapshot(entry);
	}

	private notify(entry: BrlEntry): void {
		const current = snapshot(entry);
		for (const listener of entry.listeners) listener(current);
	}
}

function snapshot(entry: BrlEntry): BrlSnapshot {
	return {
		markdown: entry.markdown,
		fetchedAt: entry.fetchedAt,
		error: entry.error,
		loading: entry.loading,
	};
}
