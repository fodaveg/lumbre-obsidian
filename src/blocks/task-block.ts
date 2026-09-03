/**
 * El bloque de código ```lumbre```: tareas de Lumbre EN VIVO dentro de una nota.
 *
 * Tres reglas mandan sobre este fichero:
 *
 * - No toca el Markdown. El bloque pinta lo que hay en Lumbre en el momento de
 *   renderizar; el fichero de la nota se queda exactamente como estaba.
 * - Un 200 no es un hecho: la casilla encola por la cola durable y se queda
 *   deshabilitada, con "Enviando…", hasta que la operación se materializa.
 * - Sin red no se enseña un bloque vacío: se enseña la última lectura confirmada
 *   con su hora y una línea que dice que eso es lo que se está viendo.
 *
 * El pintado va en un `DocumentFragment` y entra de una vez: con 200 tareas,
 * insertar fila a fila son 200 recálculos de layout.
 */

import { MarkdownRenderChild, Platform, setIcon } from 'obsidian';

import type { Logger } from '../diagnostics/logger';
import type { ListCache } from '../lumbre/list-cache';
import type { OperationQueue, QueuedOperation } from '../lumbre/queue';
import type { LumbreTask } from '../lumbre/types';
import { linkChipState, pendingOperationFor } from '../ui/link-chip-state';
import { groupBySection } from '../ui/task-sections';
import type { QueryCache, QuerySnapshot } from './query-cache';
import {
	applyClientFilters,
	describeQuery,
	parseQuery,
	queryKey,
	resolveQuery,
	type ParsedQuery,
	type ResolvedQuery,
} from './query-parser';

/** El lenguaje del bloque: ```lumbre```. */
export const LUMBRE_BLOCK_LANGUAGE = 'lumbre';

/**
 * Lo que el bloque necesita del plugin. Se declara aquí como interfaz para no
 * importar `main.ts` y crear un ciclo entre los dos módulos.
 */
export interface TaskBlockHost {
	cache: QueryCache;
	lists: ListCache;
	queue: Pick<OperationQueue, 'pending'>;
	/** Encola completar o reabrir, drena y avisa. El bloque no habla con la cola. */
	setTaskDone(task: LumbreTask, done: boolean, notePath: string): Promise<void>;
	/** El `lumbre-list` de la nota donde vive el bloque, o `null`. */
	noteListId(notePath: string): string | null;
	/** Avisa cuando cambian la cola o los vínculos. Devuelve cómo desuscribirse. */
	onDataChange(listener: () => void): () => void;
	/** Registro de diagnóstico, ya etiquetado como `block`. */
	logger: Logger;
}

export class LumbreTaskBlock extends MarkdownRenderChild {
	private parsed: ParsedQuery | null = null;
	private query: ResolvedQuery | null = null;
	private snapshot: QuerySnapshot | null = null;
	private parseError: string | null = null;
	private unsubscribeCache: (() => void) | null = null;
	private unsubscribeData: (() => void) | null = null;
	private unloaded = false;

	constructor(
		containerEl: HTMLElement,
		private readonly source: string,
		private readonly notePath: string,
		private readonly host: TaskBlockHost,
	) {
		super(containerEl);
	}

	onload(): void {
		this.containerEl.addClass('lumbre-block');
		this.containerEl.toggleClass('lumbre-block--mobile', Platform.isMobile);

		const parsed = parseQuery(this.source);
		if (!parsed.ok) {
			this.parseError = parsed.error;
			// El texto de la consulta SÍ se apunta: es una instrucción al plugin, no
			// contenido de la nota, y sin él el error no se puede reproducir.
			this.host.logger.warn('Consulta del bloque no válida', {
				notePath: this.notePath,
				error: parsed.error,
				source: this.source,
			});
			this.render();
			return;
		}

		this.parsed = parsed.query;
		this.unsubscribeData = this.host.onDataChange(() => {
			this.render();
		});
		this.render();
		void this.start();
	}

	/** Al desmontar el bloque se cancela su suscripción a la caché. */
	onunload(): void {
		this.unloaded = true;
		if (this.query !== null) {
			this.host.logger.debug('Bloque de tareas desmontado', {
				notePath: this.notePath,
				key: queryKey(this.query),
			});
		}
		this.unsubscribeCache?.();
		this.unsubscribeCache = null;
		this.unsubscribeData?.();
		this.unsubscribeData = null;
		this.containerEl.empty();
	}

	/**
	 * Resuelve la consulta y se engancha a la caché. Las listas se piden ANTES
	 * porque `lumbre-list` guarda un id y la API filtra por nombre; esa lectura
	 * está cacheada cinco minutos y es común a todos los bloques.
	 */
	private async start(): Promise<void> {
		const parsed = this.parsed;
		if (parsed === null) return;

		if (parsed.list !== null || (!parsed.scopeExplicit && this.noteListId() !== null)) {
			await this.host.lists.get();
		}
		if (this.unloaded) return;

		const query = resolveQuery(parsed, {
			noteListId: this.noteListId(),
			resolveList: (raw) => this.host.lists.nameFor(raw),
		});
		this.query = query;
		this.host.logger.info('Bloque de tareas montado', {
			notePath: this.notePath,
			key: queryKey(query),
			scope: query.scope,
			list: query.list,
		});

		this.unsubscribeCache = this.host.cache.subscribe(query, (snapshot) => {
			this.snapshot = snapshot;
			this.render();
		});
		this.snapshot = this.host.cache.peek(query);
		this.render();

		this.snapshot = await this.host.cache.get(query);
		if (this.unloaded) return;
		this.render();
	}

	private noteListId(): string | null {
		return this.notePath.length === 0 ? null : this.host.noteListId(this.notePath);
	}

	private async refresh(): Promise<void> {
		const query = this.query;
		if (query === null) return;
		this.snapshot = await this.host.cache.get(query, true);
		if (this.unloaded) return;
		this.render();
	}

	// ── Pintado ──────────────────────────────────────────────────────────────

	private render(): void {
		const root = this.containerEl;
		root.empty();

		const error = this.parseError;
		if (error !== null) {
			root.createDiv({ cls: 'lumbre-block__error', text: error });
			return;
		}

		const startedAt = Date.now();
		this.renderHeader(root);
		const painted = this.renderBody(root);
		this.renderFooter(root);

		// En `debug`: un bloque se repinta con cada cambio de la cola y con cada
		// edición de la nota, así que en `info` sería un evento por tecla.
		if (this.query !== null) {
			this.host.logger.debug('Bloque de tareas pintado', {
				key: queryKey(this.query),
				tasks: painted,
				ms: Date.now() - startedAt,
			});
		}
	}

	private renderHeader(root: HTMLElement): void {
		const header = root.createDiv({ cls: 'lumbre-block__header' });
		const query = this.query;
		header.createDiv({
			cls: 'lumbre-block__title',
			text: query === null ? 'Lumbre' : (query.title ?? describeQuery(query)),
		});

		const button = header.createEl('button', { cls: 'lumbre-button lumbre-block__refresh' });
		const icon = button.createSpan({ cls: 'lumbre-button__icon' });
		setIcon(icon, 'refresh-cw');
		button.createSpan({ text: 'Actualizar' });
		button.disabled = query === null || this.snapshot?.loading === true;
		button.addEventListener('click', () => {
			void this.refresh();
		});
	}

	/** Devuelve cuántas tareas ha pintado, que es lo que se apunta en el registro. */
	private renderBody(root: HTMLElement): number {
		const snapshot = this.snapshot;
		const query = this.query;
		if (snapshot === null || query === null) {
			root.createDiv({ cls: 'lumbre-empty', text: 'Cargando…' });
			return 0;
		}

		if (snapshot.fetchedAt === null) {
			// Todavía no ha habido ninguna lectura buena: o se está pidiendo, o el
			// primer intento falló y no hay nada anterior que enseñar.
			root.createDiv({
				cls: snapshot.error === null ? 'lumbre-empty' : 'lumbre-block__error',
				text: snapshot.error ?? 'Cargando…',
			});
			return 0;
		}

		const tasks = applyClientFilters(snapshot.tasks, query);
		if (tasks.length === 0) {
			root.createDiv({ cls: 'lumbre-empty', text: 'Nada aquí' });
			return 0;
		}

		// Todo el listado se construye DESENGANCHADO del documento y entra de una
		// vez: con 200 tareas, insertar fila a fila son 200 recálculos de layout.
		const fragment = createFragment();
		const operations = this.host.queue.pending();

		if (query.list === null) {
			this.renderTaskList(fragment.createDiv({ cls: 'lumbre-list' }), tasks, operations);
		} else {
			// Solo se agrupa por sección cuando la consulta es de una lista: fuera de
			// una lista, las secciones son de listas distintas y agrupar juntaría
			// cosas que no van juntas.
			for (const group of groupBySection(tasks)) {
				const block = fragment.createDiv({ cls: 'lumbre-block__group' });
				block.createDiv({ cls: 'lumbre-group__title', text: group.name });
				this.renderTaskList(block.createDiv({ cls: 'lumbre-list' }), group.tasks, operations);
			}
		}

		root.createDiv({ cls: 'lumbre-block__body' }).appendChild(fragment);
		return tasks.length;
	}

	private renderTaskList(
		list: HTMLElement,
		tasks: readonly LumbreTask[],
		operations: readonly QueuedOperation[],
	): void {
		for (const task of tasks) this.renderTask(list, task, operations);
	}

	private renderTask(
		parent: HTMLElement,
		task: LumbreTask,
		operations: readonly QueuedOperation[],
	): void {
		const chip = linkChipState(
			{ syncState: 'materialized', error: null },
			pendingOperationFor(operations, task.id),
		);
		const cancelled = task.cancelledAt !== null;
		const row = parent.createDiv({ cls: 'lumbre-task lumbre-block__task' });
		const main = row.createDiv({ cls: 'lumbre-task__main' });

		if (cancelled) {
			// Una cancelada no se completa ni se reabre desde aquí: eso se hace en
			// Lumbre. Sin casilla, y el hueco se queda para que la fila no baile.
			main.createSpan({ cls: 'lumbre-task__slot' });
		} else {
			const box = main.createEl('input', { type: 'checkbox', cls: 'lumbre-task__check' });
			box.checked = task.done;
			box.disabled = chip.tone === 'pending';
			box.setAttribute(
				'aria-label',
				task.done ? `Reabrir ${task.content}` : `Completar ${task.content}`,
			);
			box.addEventListener('change', () => {
				void this.toggleDone(task, box.checked);
			});
		}

		if (task.priority !== 'p4') {
			const dot = main.createSpan({
				cls: `lumbre-block__priority lumbre-block__priority--${task.priority}`,
			});
			dot.setAttribute('title', `Prioridad ${task.priority}`);
			// El punto es decoración: quien no ve el color lee la prioridad aquí.
			dot.setAttribute('aria-label', `Prioridad ${task.priority}`);
		}

		const title = main.createSpan({ cls: 'lumbre-task__title', text: task.content });
		title.toggleClass('lumbre-task__title--cancelled', cancelled);

		if (chip.label !== null) {
			const label = main.createSpan({
				cls: `lumbre-chip lumbre-chip--${chip.tone ?? 'pending'}`,
				text: chip.label,
			});
			if (chip.reason !== null) label.setAttribute('title', chip.reason);
		}

		this.renderMeta(row, task, cancelled);
	}

	private renderMeta(row: HTMLElement, task: LumbreTask, cancelled: boolean): void {
		const meta = row.createDiv({ cls: 'lumbre-task__meta' });
		if (cancelled) meta.createSpan({ cls: 'lumbre-task__meta-item', text: 'Cancelada' });
		if (task.list !== null) {
			meta.createSpan({ cls: 'lumbre-task__meta-item', text: task.list.name });
		}

		const when = task.someday ? 'Algún día' : whenText(task);
		if (when !== null) meta.createSpan({ cls: 'lumbre-task__meta-item', text: when });

		if (task.deadline !== null) {
			const deadline = meta.createSpan({ cls: 'lumbre-task__meta-item' });
			const icon = deadline.createSpan({ cls: 'lumbre-block__icon' });
			setIcon(icon, 'calendar-clock');
			deadline.createSpan({ text: task.deadline });
			deadline.setAttribute('title', `Fecha límite: ${task.deadline}`);
		}
	}

	private renderFooter(root: HTMLElement): void {
		const snapshot = this.snapshot;
		const footer = root.createDiv({ cls: 'lumbre-block__footer' });
		footer.setAttribute('aria-live', 'polite');

		if (snapshot === null) return;
		if (snapshot.fetchedAt !== null) {
			footer.createSpan({ text: `Datos de ${clockText(snapshot.fetchedAt)}` });
		}
		if (snapshot.error !== null) {
			footer.createSpan({
				cls: 'lumbre-block__stale',
				text: 'Sin conexión, mostrando la última lectura',
			});
		}
	}

	// ── Acciones ─────────────────────────────────────────────────────────────

	/** Completar o reabrir. Encola; la casilla no se asienta hasta materializar. */
	private async toggleDone(task: LumbreTask, done: boolean): Promise<void> {
		await this.host.setTaskDone(task, done, this.notePath);
		if (this.unloaded) return;
		this.render();
	}
}

/** La fecha de la tarea con su hora, o `null` si no tiene ninguna de las dos. */
function whenText(task: LumbreTask): string | null {
	if (task.date === null) return task.time;
	return task.time === null ? task.date : `${task.date} ${task.time}`;
}

/** `HH:MM` en la hora local del dispositivo. */
function clockText(epochMs: number): string {
	return new Date(epochMs).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
