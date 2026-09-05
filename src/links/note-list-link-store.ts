/**
 * Registro de qué url se mandó a `POST /api/list-links` por cada nota vinculada
 * a una lista.
 *
 * Existe por la trampa del contrato: el servidor guarda la url TAL CUAL llegó
 * (solo `trim`, sin normalizar), así que un `unlink` tiene que mandar la MISMA
 * cadena que mandó el `link`, byte a byte, o responde 200 con `removed: false`
 * sin haber quitado nada (fallo MUDO). Por eso aquí se guarda la url que se
 * envió, no la que se recalcularía en el momento del `unlink`.
 *
 * UNA entrada por RUTA de nota: la propiedad `lumbre-list` del frontmatter es
 * singular, así que una nota solo puede estar vinculada a una lista a la vez.
 * `id` es la propia ruta: no hace falta otro identificador.
 *
 * No importa `obsidian`: persiste a través de `NoteListLinkStorage`, que
 * cumple `PluginStore`.
 */

/** Una entrada del registro. `id` es la ruta de la nota, con extensión. */
export interface NoteListLinkEntry {
	id: string;
	listId: string;
	/** La url EXACTA que se mandó (o se va a mandar) en `POST /api/list-links`. */
	url: string;
	label: string;
	updatedAt: string;
	/**
	 * ISO 8601 de cuándo desapareció la nota, o `null` si sigue ahí. La entrada
	 * NO se borra ni se retira de Lumbre al momento: Obsidian Sync emite
	 * `delete` seguido de `create` en la MISMA ruta cuando una nota vuelve de
	 * otro dispositivo (mismo motivo que `orphanedAt` en `LinkStore`), y un
	 * `unlink` inmediato dejaría el frontmatter con `lumbre-list` pero Lumbre
	 * ya sin la nota. El `unlink` real espera a `ORPHAN_GRACE_MS` sin que la
	 * nota haya vuelto (ver `orphansPastGrace`).
	 */
	orphanedAt: string | null;
}

/** Lo que el registro necesita del almacén del plugin. Lo cumple `PluginStore`. */
export interface NoteListLinkStorage {
	readNoteListLinks(): NoteListLinkEntry[];
	writeNoteListLinks(entries: NoteListLinkEntry[]): Promise<void>;
}

export class NoteListLinkStore {
	private readonly now: () => Date;

	constructor(
		private readonly storage: NoteListLinkStorage,
		now?: () => Date,
	) {
		this.now = now ?? (() => new Date());
	}

	/** Todas las entradas. */
	all(): NoteListLinkEntry[] {
		return this.storage.readNoteListLinks();
	}

	/** La entrada de una nota, o `null` si no está vinculada. */
	get(notePath: string): NoteListLinkEntry | null {
		return this.all().find((entry) => entry.id === notePath) ?? null;
	}

	/** Entradas de una nota o de todas las que cuelgan de una carpeta (mismo criterio que `LinkStore`). */
	entriesUnder(path: string): NoteListLinkEntry[] {
		const prefix = `${path}/`;
		return this.all().filter((entry) => entry.id === path || entry.id.startsWith(prefix));
	}

	/** Registra (o sustituye) la entrada de una nota. Nace sin huérfana. */
	async set(notePath: string, listId: string, url: string, label: string): Promise<void> {
		const entries = this.all().filter((entry) => entry.id !== notePath);
		entries.push({ id: notePath, listId, url, label, updatedAt: this.stamp(), orphanedAt: null });
		await this.storage.writeNoteListLinks(entries);
	}

	/** Quita la entrada de una nota. No toca nada en Lumbre. */
	async remove(notePath: string): Promise<void> {
		const entries = this.all();
		const remaining = entries.filter((entry) => entry.id !== notePath);
		if (remaining.length === entries.length) return;
		await this.storage.writeNoteListLinks(remaining);
	}

	/**
	 * Mueve UNA entrada de `oldNotePath` a `newNotePath`, con su `url` ya
	 * recalculada por el llamante (la url vieja apuntaba a la ruta anterior).
	 * Sin efecto si `oldNotePath` no tenía entrada.
	 */
	async move(oldNotePath: string, newNotePath: string, newUrl: string): Promise<void> {
		const entries = this.all();
		const existing = entries.find((entry) => entry.id === oldNotePath);
		if (existing === undefined) return;
		const moved: NoteListLinkEntry = {
			...existing,
			id: newNotePath,
			url: newUrl,
			updatedAt: this.stamp(),
		};
		const rest = entries.filter((entry) => entry.id !== oldNotePath);
		await this.storage.writeNoteListLinks([...rest, moved]);
	}

	/**
	 * Marca como huérfanas las entradas de una nota (o de una carpeta entera)
	 * que ha desaparecido. No borra nada ni encola nada: el `unlink` real solo
	 * lo decide `orphansPastGrace`, pasada la gracia. Mismo criterio que
	 * `LinkStore.markDeleted`.
	 */
	async markDeleted(path: string): Promise<number> {
		const entries = this.all();
		const stamp = this.stamp();
		let marked = 0;

		for (const entry of entries) {
			if (entry.id !== path && !entry.id.startsWith(`${path}/`)) continue;
			if (entry.orphanedAt !== null) continue;
			entry.orphanedAt = stamp;
			entry.updatedAt = stamp;
			marked += 1;
		}

		if (marked > 0) await this.storage.writeNoteListLinks(entries);
		return marked;
	}

	/**
	 * Quita el huérfano de las entradas de una nota (o de una carpeta entera)
	 * que ha VUELTO a aparecer. Mismo criterio que `LinkStore.markCreated`: un
	 * borrado seguido de una creación en la misma ruta es lo NORMAL con
	 * Obsidian Sync, no una rareza.
	 */
	async markCreated(path: string): Promise<number> {
		const entries = this.all();
		const stamp = this.stamp();
		let cleared = 0;

		for (const entry of entries) {
			if (entry.orphanedAt === null) continue;
			if (entry.id !== path && !entry.id.startsWith(`${path}/`)) continue;
			entry.orphanedAt = null;
			entry.updatedAt = stamp;
			cleared += 1;
		}

		if (cleared > 0) await this.storage.writeNoteListLinks(entries);
		return cleared;
	}

	private stamp(): string {
		return this.now().toISOString();
	}
}

/** La ruta nueva si `path` cae bajo el renombrado, o `null` si no le afecta. Mismo criterio que `LinkStore`. */
export function movedNotePath(path: string, oldPath: string, newPath: string): string | null {
	if (path === oldPath) return newPath;
	const prefix = `${oldPath}/`;
	if (path.startsWith(prefix)) return `${newPath}/${path.slice(prefix.length)}`;
	return null;
}

/** Una operación de vínculo que hay que encolar, ya resuelta con su url y su nota. */
export interface ListLinkChange {
	type: 'link' | 'unlink';
	listId: string;
	url: string;
	label: string;
	notePath: string;
}

/**
 * Calcula el reemplazo de vínculos para las entradas que caen bajo un
 * renombrado (nota o carpeta entera): un `unlink` de la url VIEJA seguido de un
 * `link` con la NUEVA, en ese orden por entrada. El orden importa: un servidor
 * que procese la cola en el orden en que llega no debe ver nunca las dos url
 * activas para la misma nota a la vez.
 *
 * Módulo puro: `buildUrl` es quien sabe componer la url nueva (normalmente
 * `buildObsidianDeepLink` atado al vault), así que esta función no depende de
 * `obsidian`.
 */
export function renameListLinkChanges(
	entries: readonly NoteListLinkEntry[],
	oldPath: string,
	newPath: string,
	buildUrl: (notePath: string) => string,
): ListLinkChange[] {
	const changes: ListLinkChange[] = [];
	for (const entry of entries) {
		const to = movedNotePath(entry.id, oldPath, newPath);
		if (to === null) continue;
		changes.push({ type: 'unlink', listId: entry.listId, url: entry.url, label: entry.label, notePath: entry.id });
		changes.push({ type: 'link', listId: entry.listId, url: buildUrl(to), label: entry.label, notePath: to });
	}
	return changes;
}

/**
 * A partir de cuánto tiempo huérfana se retira de verdad el vínculo. Es lo que
 * distingue un borrado real de un `delete` seguido de un `create` en la misma
 * ruta, que es lo que hace Obsidian Sync cuando la nota llega de otro
 * dispositivo: ese vaivén dura del orden de segundos, nunca minutos.
 */
export const ORPHAN_GRACE_MS = 30_000;

/**
 * Las entradas huérfanas que ya pasaron `graceMs` sin que la nota haya vuelto
 * Y cuya nota SIGUE sin existir ahora mismo: son las que hay que retirar de
 * Lumbre de verdad con un `unlink`. `exists` es quien sabe si la ruta sigue en
 * el vault (inyectado, para que este módulo siga sin importar `obsidian`); se
 * comprueba aquí y no solo con el paso del tiempo porque una nota puede volver
 * bien pasada la gracia (un dispositivo que tardó en sincronizar) y en ese
 * caso `markCreated` ya la habrá limpiado, pero por si el orden de eventos no
 * llegó a tiempo, la comprobación doble no hace daño.
 */
export function orphansPastGrace(
	entries: readonly NoteListLinkEntry[],
	now: Date,
	exists: (notePath: string) => boolean,
	graceMs: number = ORPHAN_GRACE_MS,
): NoteListLinkEntry[] {
	const cutoff = now.getTime() - graceMs;
	return entries.filter((entry) => {
		if (entry.orphanedAt === null) return false;
		const orphanedAt = Date.parse(entry.orphanedAt);
		if (Number.isNaN(orphanedAt) || orphanedAt > cutoff) return false;
		return !exists(entry.id);
	});
}

/**
 * Orquesta el reemitido de un renombrado: actualiza el registro local
 * PRIMERO y solo DESPUÉS encola los cambios en Lumbre. El orden importa: los
 * listeners de `vault.on('rename', ...)` van con `void`, sin esperarse entre
 * sí, así que dos renombrados seguidos de la MISMA nota pueden solaparse. Si
 * el registro se actualizara DESPUÉS de encolar, el segundo renombrado leería
 * la ruta todavía vieja (la del primero, sin mover) y no encontraría nada por
 * la ruta intermedia, dejando un vínculo muerto en Lumbre sin vía de limpieza.
 *
 * Actualizar el registro es la única operación de esta función con un efecto
 * SÍNCRONO que un llamador concurrente puede observar (`PluginStore` muta su
 * copia en memoria antes de que la escritura a disco resuelva), así que
 * hacerlo antes de la primera espera de red es lo que cierra la ventana.
 *
 * Tras mover, se cede el turno (`await Promise.resolve()`) y se relee el
 * registro ANTES de encolar cada `link`: si para entonces la nota ya no está
 * en `to` es que un renombrado ENCADENADO la movió más allá mientras
 * esperábamos, y ese `link` sería del todo transitorio (Lumbre lo vería vivo
 * un instante y el siguiente paso ya lo estaría retirando). El `unlink`, en
 * cambio, se manda SIEMPRE: retirar una url que nunca llegó a registrarse es
 * un 200 con `removed: false` (éxito, ver el JSDoc de `ListLinkTarget`), así
 * que de más nunca rompe nada, y de menos deja un vínculo sin vía de limpieza.
 * Así, dos renombrados de la misma nota sin esperarse entre sí acaban en
 * exactamente UN `link` (el de la ruta final) y un `unlink` por cada ruta por
 * la que pasó.
 *
 * `enqueue` es quien encola de verdad (normalmente
 * `queue.enqueueListLink`); se inyecta para poder probar el solape sin la
 * cola real ni `obsidian`. Devuelve los ids de las operaciones encoladas.
 */
export async function applyRenameListLinks(
	store: Pick<NoteListLinkStore, 'entriesUnder' | 'move' | 'get'>,
	oldPath: string,
	newPath: string,
	buildUrl: (notePath: string) => string,
	enqueue: (change: ListLinkChange) => Promise<{ id: string }>,
): Promise<string[]> {
	const entries = store.entriesUnder(oldPath);
	if (entries.length === 0) return [];

	const changes = renameListLinkChanges(entries, oldPath, newPath, buildUrl);

	for (const entry of entries) {
		const to = movedNotePath(entry.id, oldPath, newPath);
		if (to === null) continue;
		await store.move(entry.id, to, buildUrl(to));
	}

	// Cede el turno: si un renombrado ENCADENADO ha corrido mientras tanto, ya
	// habrá movido la nota otra vez y lo verá el chequeo de abajo.
	await Promise.resolve();

	const ids: string[] = [];
	for (const change of changes) {
		if (change.type === 'link' && store.get(change.notePath) === null) {
			// Superado por un renombrado posterior: la nota ya no está en la ruta
			// que este `link` registraría, así que mandarlo sería darle a Lumbre un
			// vínculo vivo por un instante para retirarlo enseguida. El `unlink`
			// que le sigue en la cola (el del siguiente renombrado) ya se encarga.
			continue;
		}
		const operation = await enqueue(change);
		ids.push(operation.id);
	}
	return ids;
}
