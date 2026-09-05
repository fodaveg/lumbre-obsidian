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

	/** Registra (o sustituye) la entrada de una nota. */
	async set(notePath: string, listId: string, url: string, label: string): Promise<void> {
		const entries = this.all().filter((entry) => entry.id !== notePath);
		entries.push({ id: notePath, listId, url, label, updatedAt: this.stamp() });
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
