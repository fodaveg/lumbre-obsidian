/**
 * La API pública del plugin, la que ven Dataview y js-engine.
 *
 * Se alcanza como `app.plugins.plugins.lumbre.api`. Es una superficie PEQUEÑA y
 * estable: lo que hay aquí se documenta en `docs/API.md` y no se rompe sin subir
 * `version`. Lo de dentro del plugin (cliente, cola, mapa) NO se expone, para que
 * un script de un usuario no dependa de nuestras tripas.
 *
 * Dos reglas que atan todo lo que sigue:
 *
 * - Todo lo que MUTA pasa por la cola durable. Ni un `createTask` ni un
 *   `completeTask` hablan directamente con la API de Lumbre: si lo hicieran, un
 *   200 se leería como un hecho y un corte de red perdería la escritura.
 * - Nada de aquí escribe en el vault. La API lee tareas y encola escrituras
 *   hacia Lumbre; el Markdown es del usuario.
 *
 * No importa `obsidian`: la plataforma y el `workspace.trigger` entran por
 * inyección, así que esto se prueba entero con Vitest.
 */

import type { QueryCache } from '../blocks/query-cache';
import { shortTitle, type LogEvent, type Logger } from '../diagnostics/logger';
import { DEFAULT_REPORT_EVENTS } from '../diagnostics/report';
import {
	applyClientFilters,
	parseQuery,
	resolveQuery,
	type LumbreScope,
	type ResolvedQuery,
} from '../blocks/query-parser';
import type { LumbreTaskLink, LinkStore } from '../links/link-store';
import { describeFailure, type LumbreClient } from '../lumbre/client';
import type { ListCache } from '../lumbre/list-cache';
import type { LinkTarget, OperationQueue } from '../lumbre/queue';
import { taskDeepLinks, type LumbreList, type LumbreTask, type TaskDraft } from '../lumbre/types';

/** El evento que se dispara en el workspace de Obsidian. Lo escucha Dataview. */
export const TASKS_CHANGED_EVENT = 'lumbre:tasks-changed';

/**
 * Una consulta en objeto, con las mismas claves que el bloque. También se acepta
 * el texto del bloque tal cual, y las dos vías pasan por el MISMO parser.
 */
export interface LumbreQueryInput {
	scope?: LumbreScope;
	/** Nombre o id de lista. */
	list?: string;
	section?: string;
	days?: number;
	/** Etiqueta dentro del título, con o sin almohadilla. */
	tag?: string;
	includeDone?: boolean;
	limit?: number;
}

/** A qué parte del vault pertenece una tarea creada desde la API. */
export interface LumbreApiTarget {
	notePath: string;
	label?: string;
	excerpt?: string | null;
}

/** La firma más ancha que cabe: cualquier handler de la API es asignable a esta. */
type AnyHandler = (...args: never[]) => void;

export interface LumbreApiEvents {
	/** Tras cualquier materialización de la cola o cualquier refresco de la caché. */
	'tasks-changed': () => void;
	/** Cuando cambia si se puede hablar con Lumbre. */
	'connection-changed': (connected: boolean) => void;
}

export interface LumbreApiDeps {
	/** Versión del plugin, la del `manifest.json`. */
	version: string;
	client: Pick<LumbreClient, 'ping' | 'getTask'>;
	queue: Pick<OperationQueue, 'enqueueCreate' | 'enqueueStatus' | 'flush' | 'pending'>;
	links: Pick<LinkStore, 'linksForNote'>;
	cache: Pick<QueryCache, 'get'>;
	lists: Pick<ListCache, 'get' | 'nameFor'>;
	/** Abre una URL. En el plugin es `window.open`. */
	openUrl(url: string): void;
	/** Origen web de Lumbre, para el enlace de la web. */
	webOrigin(): string;
	/** `true` en la app de escritorio, donde el esquema nativo tiene quien lo atienda. */
	isDesktopApp(): boolean;
	/** Dispara un evento del workspace de Obsidian. */
	triggerWorkspace(event: string): void;
	/** Registro de diagnóstico, ya etiquetado como `api`. */
	logger: Logger;
	/** El informe de diagnóstico en texto plano. Lo compone `main.ts`. */
	buildReport(): string;
}

/**
 * La parte de diagnóstico de la API pública. Es de solo lectura y ya viene
 * limpia: ni el token ni el contenido de una nota salen por aquí, igual que en
 * el informe que copia el botón de Ajustes.
 */
export interface LumbreDiagnosticsApi {
	/** El informe entero, el mismo que «Copiar registro». */
	report(): string;
	/** Los últimos eventos del registro, del más viejo al más nuevo. */
	events(count?: number): LogEvent[];
}

export class LumbreApi {
	/** Versión del plugin. Sube con el `manifest.json`. */
	readonly version: string;

	/**
	 * Un conjunto por evento. Se guardan con la firma más ancha que existe para
	 * poder aceptar cualquier handler sin aserciones al apuntarse; el tipo bueno se
	 * recupera al llamarlos, que es donde de verdad importa.
	 */
	private readonly tasksHandlers = new Set<AnyHandler>();
	private readonly connectionHandlers = new Set<AnyHandler>();
	/** Último estado de conexión conocido, para no repetir el evento. */
	private connected: boolean | null = null;

	/**
	 * El registro de diagnóstico, para que un script pueda leerlo sin abrir los
	 * ajustes: es lo que hace útil un botón de js-engine que pide el informe.
	 */
	readonly diagnostics: LumbreDiagnosticsApi;

	constructor(private readonly deps: LumbreApiDeps) {
		this.version = deps.version;
		this.diagnostics = {
			report: (): string => {
				this.called('diagnostics.report');
				return this.deps.buildReport();
			},
			events: (count = DEFAULT_REPORT_EVENTS): LogEvent[] => {
				this.called('diagnostics.events', { count });
				return this.deps.logger.recent(count);
			},
		};
	}

	/**
	 * `true` si el origen y el token valen. Emite `connection-changed` cuando la
	 * respuesta cambia respecto a la anterior.
	 */
	async isConnected(): Promise<boolean> {
		this.called('isConnected');
		const result = await this.deps.client.ping();
		this.notifyConnectionChanged(result.ok);
		return result.ok;
	}

	/**
	 * Las tareas de una consulta, con la misma forma que el bloque: el texto del
	 * bloque o un objeto con sus claves. Va por la caché compartida, así que un
	 * script que se repinte cada pocos segundos no gasta una petición por repintado.
	 *
	 * Si la lectura falla pero hay una anterior confirmada, devuelve ESA (es lo
	 * mismo que enseña el bloque). Solo lanza si no hay ninguna lectura y además
	 * la petición falló, o si la consulta no se entiende.
	 */
	async listTasks(query: string | LumbreQueryInput = ''): Promise<LumbreTask[]> {
		this.called('listTasks', { query });
		const resolved = await this.resolve(query);
		const snapshot = await this.deps.cache.get(resolved);
		if (snapshot.fetchedAt === null && snapshot.error !== null) throw new Error(snapshot.error);
		return applyClientFilters(snapshot.tasks, resolved);
	}

	/** Una tarea por id, o `null` si no existe o no es del token. */
	async getTask(id: string): Promise<LumbreTask | null> {
		this.called('getTask', { id });
		const read = await this.deps.client.getTask(id);
		if (!read.ok) throw new Error(describeFailure(read.reason, read.status));
		return read.value;
	}

	/** Las listas de Lumbre, de la caché de listas. */
	async listLists(): Promise<LumbreList[]> {
		this.called('listLists');
		return this.deps.lists.get();
	}

	/**
	 * Encola una tarea nueva y devuelve su `clientTaskId`, que es el id que tendrá
	 * en Lumbre. Resuelve cuando la cola ha intentado enviarla; el id vale desde
	 * el primer momento, aunque el envío todavía no haya salido.
	 */
	async createTask(draft: TaskDraft, target?: LumbreApiTarget): Promise<string> {
		this.called('createTask', {
			notePath: target?.notePath ?? null,
			listId: draft.listId ?? null,
			// El título lo escribe quien llama y puede venir de una nota: solo en
			// `debug` y recortado, como en el resto del plugin.
			title: shortTitle(draft.title),
		});
		const operation = await this.deps.queue.enqueueCreate(draft, linkTarget(target));
		await this.flush();
		return operation.clientTaskId;
	}

	/** Encola completar una tarea. La casilla no se asienta hasta materializar. */
	async completeTask(id: string, target?: LumbreApiTarget): Promise<void> {
		this.called('completeTask', { id, notePath: target?.notePath ?? null });
		await this.setDone(id, true, target);
	}

	/** Encola reabrir una tarea. */
	async reopenTask(id: string, target?: LumbreApiTarget): Promise<void> {
		this.called('reopenTask', { id, notePath: target?.notePath ?? null });
		await this.setDone(id, false, target);
	}

	/** Los vínculos nota ↔ tarea de una nota, por su ruta dentro del vault. */
	linksForNote(path: string): LumbreTaskLink[] {
		this.called('linksForNote', { notePath: path });
		return this.deps.links.linksForNote(path);
	}

	/**
	 * Abre una tarea en Lumbre: el esquema nativo en la app de escritorio, la web
	 * en móvil, donde no hay nada que atienda `lumbre://`.
	 */
	openInLumbre(id: string): void {
		this.called('openInLumbre', { id });
		const links = taskDeepLinks({ id }, this.deps.webOrigin());
		this.deps.openUrl(this.deps.isDesktopApp() ? links.native : links.web);
	}

	/** Se apunta a un evento. Devuelve cómo darse de baja. */
	on(event: 'tasks-changed', handler: LumbreApiEvents['tasks-changed']): () => void;
	on(event: 'connection-changed', handler: LumbreApiEvents['connection-changed']): () => void;
	on(event: keyof LumbreApiEvents, handler: AnyHandler): () => void {
		this.called('on', { event });
		const set = event === 'tasks-changed' ? this.tasksHandlers : this.connectionHandlers;
		set.add(handler);
		return (): void => {
			set.delete(handler);
		};
	}

	/**
	 * UN evento por llamada en `info`, que es el trato: el nombre del método basta
	 * para seguir qué hizo un script. Los argumentos van aparte y solo en `debug`,
	 * porque ahí es donde pueden aparecer títulos o rutas de notas.
	 */
	private called(method: string, args?: Record<string, unknown>): void {
		this.deps.logger.info('Llamada a la API pública', { method });
		if (args === undefined || !this.deps.logger.enabled('debug')) return;
		this.deps.logger.debug('Argumentos de la llamada', { method, ...args });
	}

	// ── Lo que llama el plugin, no los scripts ───────────────────────────────

	/**
	 * Avisa de que las tareas han cambiado. Lo llama el plugin tras cada
	 * materialización de la cola y tras cada refresco de la caché. Además del
	 * evento propio dispara el del workspace, que es el que puede escuchar un
	 * script de Dataview sin guardarse una función de baja.
	 */
	notifyTasksChanged(): void {
		for (const handler of this.tasksHandlers) handler();
		this.deps.triggerWorkspace(TASKS_CHANGED_EVENT);
	}

	/** Emite `connection-changed`, pero solo si el estado ha cambiado de verdad. */
	notifyConnectionChanged(connected: boolean): void {
		if (this.connected === connected) return;
		this.connected = connected;
		for (const handler of this.connectionHandlers) {
			(handler as LumbreApiEvents['connection-changed'])(connected);
		}
	}

	// ── Interior ─────────────────────────────────────────────────────────────

	private async setDone(id: string, done: boolean, target?: LumbreApiTarget): Promise<void> {
		await this.deps.queue.enqueueStatus(id, done, linkTarget(target));
		await this.flush();
	}

	/**
	 * Drena la cola y avisa. El aviso va aunque el envío falle: lo que ha cambiado
	 * es el estado de la operación, y eso es justo lo que un bloque tiene que
	 * repintar.
	 */
	private async flush(): Promise<void> {
		await this.deps.queue.flush();
		this.notifyTasksChanged();
	}

	/**
	 * La consulta del usuario a la consulta resuelta. Las listas se piden antes de
	 * resolver porque `list` puede venir como id y la API filtra por nombre.
	 */
	private async resolve(query: string | LumbreQueryInput): Promise<ResolvedQuery> {
		const parsed = parseQuery(typeof query === 'string' ? query : querySource(query));
		if (!parsed.ok) throw new Error(parsed.error);
		if (parsed.query.list !== null) await this.deps.lists.get();
		return resolveQuery(parsed.query, {
			// La API no vive dentro de ninguna nota: aquí no hay `lumbre-list` que
			// valga, la lista se dice o no se dice.
			noteListId: null,
			resolveList: (raw) => this.deps.lists.nameFor(raw),
		});
	}
}

/** El objeto de consulta al texto `clave: valor` que entiende el parser. */
function querySource(input: LumbreQueryInput): string {
	const lines: string[] = [];
	for (const [key, value] of Object.entries(input)) {
		if (value === undefined || value === null) continue;
		lines.push(`${key}: ${String(value)}`);
	}
	return lines.join('\n');
}

/** El destino de una operación, con los huecos rellenos. */
function linkTarget(target?: LumbreApiTarget): LinkTarget {
	return {
		notePath: target?.notePath ?? '',
		label: target?.label ?? 'Sin nota',
		excerpt: target?.excerpt ?? null,
	};
}
