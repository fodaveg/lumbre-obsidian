/**
 * Mapa entre notas del vault y tareas de Lumbre.
 *
 * La nota se identifica por RUTA (decisión 2 del audit): NO se escribe ningún
 * id en el frontmatter, porque la nota es del usuario y el plugin no la ensucia.
 * El precio de esa decisión es que hay que seguir los renombrados, y de eso se
 * encarga `renamePath`, que `main.ts` engancha a `vault.on('rename')`.
 *
 * De la tarea se guarda una CACHÉ de la última lectura confirmada. Es caché, no
 * fuente: Lumbre manda sobre la tarea. Sirve para pintar algo sin red y para no
 * perder el rastro si una lectura falla.
 *
 * No importa `obsidian`: recibe las rutas ya resueltas y persiste a través de
 * `LinkStorage`, que implementa `PluginStore`.
 */

import type { LumbreClient } from '../lumbre/client';
import type { OperationState } from '../lumbre/queue';
import type { LumbreTask } from '../lumbre/types';

/** Lo que se guarda de la nota además de la ruta. */
export interface LinkTargetInfo {
	/** Cómo se llama esto en la nota (el texto que vio el usuario). */
	label: string;
	/** Contexto corto alrededor, para reconocerlo sin abrir la nota. */
	excerpt: string | null;
}

export interface LumbreTaskLink {
	id: string;
	taskId: string;
	/** Ruta de la nota dentro del vault, con extensión. Es la identidad de la nota. */
	notePath: string;
	label: string;
	excerpt: string | null;
	/** Última lectura CONFIRMADA de la tarea. Caché, nunca fuente de verdad. */
	task: LumbreTask;
	syncState: OperationState;
	error: string | null;
	updatedAt: string;
	/**
	 * ISO 8601 de cuándo desapareció la nota, o `null` si sigue ahí. La entrada
	 * NO se borra: un borrado puede ser un accidente o venir de otro dispositivo
	 * por Obsidian Sync, y borrar el enlace perdería el rastro de una tarea que
	 * sigue viva en Lumbre.
	 */
	orphanedAt: string | null;
}

/** Lo que el mapa necesita del almacén del plugin. Lo cumple `PluginStore`. */
export interface LinkStorage {
	readLinks(): LumbreTaskLink[];
	writeLinks(links: LumbreTaskLink[]): Promise<void>;
}

export interface LinkStoreOptions {
	storage: LinkStorage;
	/** Reloj, inyectable para los tests. */
	now?: () => Date;
}

export class LinkStore {
	private readonly now: () => Date;

	constructor(private readonly options: LinkStoreOptions) {
		this.now = options.now ?? (() => new Date());
	}

	/** Todos los enlaces, en el orden en que se crearon. */
	all(): LumbreTaskLink[] {
		return this.options.storage.readLinks();
	}

	/** Enlaces de una nota concreta. */
	linksForNote(path: string): LumbreTaskLink[] {
		return this.all().filter((link) => link.notePath === path);
	}

	/** Rutas de las notas que apuntan a una tarea. Una tarea puede estar en varias. */
	notesForTask(taskId: string): string[] {
		const paths: string[] = [];
		for (const link of this.all()) {
			if (link.taskId === taskId && !paths.includes(link.notePath)) paths.push(link.notePath);
		}
		return paths;
	}

	/**
	 * Enlaza una tarea con una nota. Si esa pareja nota+tarea ya existe, se
	 * actualiza en vez de duplicarse: enlazar dos veces lo mismo es un gesto
	 * repetido del usuario, no dos enlaces.
	 */
	async link(path: string, task: LumbreTask, target: LinkTargetInfo): Promise<LumbreTaskLink> {
		const links = this.all();
		const existing = links.find(
			(link) => link.notePath === path && link.taskId === task.id,
		);
		const stamp = this.stamp();

		if (existing !== undefined) {
			existing.label = target.label;
			existing.excerpt = target.excerpt;
			existing.task = task;
			existing.syncState = 'materialized';
			existing.error = null;
			existing.orphanedAt = null;
			existing.updatedAt = stamp;
			await this.options.storage.writeLinks(links);
			return existing;
		}

		const link: LumbreTaskLink = {
			id: crypto.randomUUID(),
			taskId: task.id,
			notePath: path,
			label: target.label,
			excerpt: target.excerpt,
			task,
			syncState: 'materialized',
			error: null,
			updatedAt: stamp,
			orphanedAt: null,
		};
		await this.options.storage.writeLinks([...links, link]);
		return link;
	}

	/** Quita un enlace. No toca la tarea en Lumbre. */
	async unlink(id: string): Promise<void> {
		const links = this.all();
		const remaining = links.filter((link) => link.id !== id);
		if (remaining.length === links.length) return;
		await this.options.storage.writeLinks(remaining);
	}

	/**
	 * Relee de Lumbre las tareas enlazadas en una nota (una sola petición con
	 * `ids=`) y actualiza la caché.
	 *
	 * Si la lectura falla, la caché NO se borra: se marca `recoverable_error` con
	 * el motivo. Borrarla convertiría un corte de red en pérdida de información.
	 * Una tarea que la lectura no devuelve (borrada en Lumbre, o de otra cuenta)
	 * también conserva su caché, marcada igual: el plugin no puede distinguir
	 * "borrada" de "invisible para este token", y no va a decidir por el usuario.
	 */
	async refresh(
		path: string,
		client: Pick<LumbreClient, 'getTasksByIds'>,
	): Promise<LumbreTaskLink[]> {
		const links = this.all();
		const mine = links.filter((link) => link.notePath === path);
		if (mine.length === 0) return [];

		const ids = [...new Set(mine.map((link) => link.taskId))];
		const read = await client.getTasksByIds(ids);
		const stamp = this.stamp();

		if (!read.ok) {
			const text = `No se pudo releer de Lumbre (${read.reason}).`;
			for (const link of mine) {
				link.syncState = 'recoverable_error';
				link.error = text;
				link.updatedAt = stamp;
			}
			await this.options.storage.writeLinks(links);
			return mine;
		}

		const byId = new Map(read.value.map((task) => [task.id, task]));
		for (const link of mine) {
			const task = byId.get(link.taskId);
			if (task === undefined) {
				link.syncState = 'recoverable_error';
				link.error = 'Lumbre no devolvió esta tarea; se conserva la última lectura.';
			} else {
				link.task = task;
				link.syncState = 'materialized';
				link.error = null;
			}
			link.updatedAt = stamp;
		}
		await this.options.storage.writeLinks(links);
		return mine;
	}

	/**
	 * Mueve los enlaces de `oldPath` a `newPath`. Vale igual para un fichero y
	 * para una carpeta: renombrar una carpeta cambia el PREFIJO de todas las
	 * rutas que cuelgan de ella, así que se casa la ruta exacta O el prefijo
	 * `oldPath/`. Así no hace falta saber si lo renombrado era una u otra cosa.
	 */
	async renamePath(oldPath: string, newPath: string): Promise<number> {
		const links = this.all();
		const stamp = this.stamp();
		let moved = 0;

		for (const link of links) {
			const moving = movedPath(link.notePath, oldPath, newPath);
			if (moving === null) continue;
			link.notePath = moving;
			link.updatedAt = stamp;
			moved += 1;
		}

		if (moved > 0) await this.options.storage.writeLinks(links);
		return moved;
	}

	/**
	 * Marca como huérfanos los enlaces de una nota (o de una carpeta entera) que
	 * ha desaparecido. No borra nada: ver el JSDoc de `orphanedAt`.
	 */
	async markDeleted(path: string): Promise<number> {
		const links = this.all();
		const stamp = this.stamp();
		let marked = 0;

		for (const link of links) {
			if (link.notePath !== path && !link.notePath.startsWith(`${path}/`)) continue;
			if (link.orphanedAt !== null) continue;
			link.orphanedAt = stamp;
			link.updatedAt = stamp;
			marked += 1;
		}

		if (marked > 0) await this.options.storage.writeLinks(links);
		return marked;
	}

	private stamp(): string {
		return this.now().toISOString();
	}
}

/** La ruta nueva si `path` cae bajo el renombrado, o `null` si no le afecta. */
function movedPath(path: string, oldPath: string, newPath: string): string | null {
	if (path === oldPath) return newPath;
	const prefix = `${oldPath}/`;
	if (path.startsWith(prefix)) return `${newPath}/${path.slice(prefix.length)}`;
	return null;
}
