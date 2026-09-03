/**
 * Panel lateral "Tareas de esta nota".
 *
 * Sigue a la nota activa y enseña TRES cosas: las tareas vinculadas a esa nota,
 * un buscador para vincular una que ya existe en Lumbre, y (si la nota tiene
 * `lumbre-list`) las tareas de esa lista agrupadas por sección.
 *
 * Tres reglas que explican por qué está escrito así:
 *
 * - No escribe nada en la nota. Ni una tarea, ni un id, ni una marca.
 * - Un 200 no es un hecho: completar encola y el chip dice "Enviando…" hasta que
 *   la cola confirma releyendo. El estado del chip lo decide `link-chip-state`.
 * - Sin red no se esconde nada: la cabecera se marca "Sin conexión ·" y se sigue
 *   enseñando la última lectura confirmada con su chip.
 */

import { ItemView, Notice, Platform, setIcon, type TFile, type WorkspaceLeaf } from 'obsidian';

import type { LinkStore, LumbreTaskLink } from '../links/link-store';
import { describeFailure, type LumbreClient } from '../lumbre/client';
import type { ListCache } from '../lumbre/list-cache';
import type { OperationQueue, QueuedOperation } from '../lumbre/queue';
import { taskDeepLinks, type LumbreTask } from '../lumbre/types';
import { linkChipState, pendingOperationFor, type ChipState } from './link-chip-state';
import { filterTasks } from './search-filter';
import { groupBySection } from './task-sections';

export const NOTE_TASKS_VIEW_TYPE = 'lumbre-note-tasks';

/** Icono de Lucide del panel, del ribbon y del comando. */
export const NOTE_TASKS_ICON = 'flame';

/** Tope de resultados que se pintan del buscador. */
const MAX_SEARCH_RESULTS = 50;

/**
 * Lo que el panel necesita del plugin. Se declara aquí como interfaz para no
 * importar `main.ts` y crear un ciclo entre los dos módulos.
 */
export interface NoteTasksHost {
	links: LinkStore;
	queue: OperationQueue;
	client: LumbreClient;
	lists: ListCache;
	/** Origen web de Lumbre, para el enlace de "Abrir en Lumbre". */
	webOrigin(): string;
	hasToken(): Promise<boolean>;
	openSettings(): void;
	openSendModal(file: TFile | null): void;
	/**
	 * Abre el selector de fichero y sube el elegido como adjunto de la tarea. La
	 * subida NO va por la cola: un binario no se persiste en `data.json`.
	 */
	attachFile(task: LumbreTask): void;
	/** El `lumbre-list` de la nota, o `null`. */
	noteListId(file: TFile): string | null;
	/** Avisa cuando cambian la cola o los vínculos. Devuelve cómo desuscribirse. */
	onDataChange(listener: () => void): () => void;
}

/** Lo cargado de la lista de proyecto de la nota. */
interface ProjectState {
	name: string | null;
	tasks: LumbreTask[];
	loading: boolean;
	error: string | null;
}

export class NoteTasksView extends ItemView {
	private file: TFile | null = null;
	private hasToken = true;
	private searchQuery = '';
	private searchResults: LumbreTask[] | null = null;
	private searching = false;
	private confirmingUnlink: string | null = null;
	private project: ProjectState | null = null;
	private unsubscribe: (() => void) | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly host: NoteTasksHost,
	) {
		super(leaf);
		this.navigation = false;
	}

	getViewType(): string {
		return NOTE_TASKS_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Tareas de esta nota';
	}

	getIcon(): string {
		return NOTE_TASKS_ICON;
	}

	async onOpen(): Promise<void> {
		this.unsubscribe = this.host.onDataChange(() => {
			this.render();
		});

		this.registerEvent(
			this.app.workspace.on('active-leaf-change', () => {
				void this.followActiveFile();
			}),
		);
		this.registerEvent(
			this.app.workspace.on('file-open', () => {
				void this.followActiveFile();
			}),
		);
		// La propiedad `lumbre-list` puede cambiarla el usuario a mano o el comando.
		this.registerEvent(
			this.app.metadataCache.on('changed', (file: TFile) => {
				if (file.path === this.file?.path) void this.loadProject();
			}),
		);
		// Sin red no se borra nada, pero la cabecera lo dice.
		this.registerDomEvent(window, 'online', () => {
			this.render();
		});
		this.registerDomEvent(window, 'offline', () => {
			this.render();
		});

		await this.followActiveFile(true);
	}

	async onClose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.contentEl.empty();
		await Promise.resolve();
	}

	// ── Seguimiento de la nota activa ────────────────────────────────────────

	/** Apunta el panel a la nota activa y recarga lo que dependa de ella. */
	private async followActiveFile(force = false): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!force && (file?.path ?? null) === (this.file?.path ?? null)) return;

		this.file = file;
		this.searchQuery = '';
		this.searchResults = null;
		this.confirmingUnlink = null;
		this.project = null;
		this.render();

		this.hasToken = await this.host.hasToken();
		if (!this.stillOn(file)) return;
		this.render();

		await this.refreshLinks();
		await this.loadProject();
		if (!this.stillOn(file)) return;
		this.render();
	}

	/** `true` si el panel sigue en la misma nota que cuando empezó la espera. */
	private stillOn(file: TFile | null): boolean {
		return (this.file?.path ?? null) === (file?.path ?? null);
	}

	/**
	 * Relee de Lumbre las tareas de la nota. Sin red no se intenta: `refresh`
	 * marcaría todos los vínculos con un error que ya se ve en la cabecera.
	 */
	private async refreshLinks(): Promise<void> {
		const file = this.file;
		if (file === null || !navigator.onLine) return;
		await this.host.links.refresh(file.path, this.host.client);
	}

	// ── Pintado ──────────────────────────────────────────────────────────────

	private render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass('lumbre-panel');
		root.toggleClass('lumbre-panel--mobile', Platform.isMobile);

		this.renderHeader(root);
		if (!this.hasToken) this.renderTokenWarning(root);
		this.renderNoteTasks(root);
		this.renderSearch(root);
		this.renderProject(root);
	}

	private renderHeader(root: HTMLElement): void {
		const header = root.createDiv({ cls: 'lumbre-panel__header' });
		const title = header.createDiv({ cls: 'lumbre-panel__note' });
		if (!navigator.onLine) {
			title.createSpan({ cls: 'lumbre-panel__offline', text: 'Sin conexión ·' });
		}
		title.createSpan({ text: this.file?.basename ?? 'Ninguna nota abierta' });

		const button = this.button(header, {
			text: 'Nueva tarea',
			cls: 'lumbre-button--cta',
			icon: 'plus',
			onClick: () => {
				this.host.openSendModal(this.file);
			},
		});
		button.disabled = this.file === null;
	}

	private renderTokenWarning(root: HTMLElement): void {
		const warning = root.createDiv({ cls: 'lumbre-notice lumbre-notice--error' });
		warning.createSpan({ text: 'Falta el token personal de Lumbre.' });
		this.button(warning, {
			text: 'Abrir ajustes',
			onClick: () => {
				this.host.openSettings();
			},
		});
	}

	private renderNoteTasks(root: HTMLElement): void {
		const section = this.section(root, 'Tareas de esta nota');
		if (this.file === null) {
			section.createDiv({ cls: 'lumbre-empty', text: 'Abre una nota para ver sus tareas.' });
			return;
		}

		const links = this.host.links.linksForNote(this.file.path);
		if (links.length === 0) {
			section.createDiv({ cls: 'lumbre-empty', text: 'Esta nota no tiene tareas.' });
			return;
		}

		const operations = this.host.queue.pending();
		const list = section.createDiv({ cls: 'lumbre-list' });
		for (const link of links) this.renderLinkRow(list, link, operations);
	}

	private renderLinkRow(
		parent: HTMLElement,
		link: LumbreTaskLink,
		operations: readonly QueuedOperation[],
	): void {
		const operation = pendingOperationFor(operations, link.taskId);
		const chip = linkChipState(link, operation);
		const row = this.renderTaskRow(parent, link.task, chip);

		if (link.orphanedAt !== null) {
			row.meta.createSpan({
				cls: 'lumbre-task__meta-item',
				text: 'La nota ya no existe',
			});
		}

		this.button(row.actions, {
			text: 'Abrir en Lumbre',
			icon: 'external-link',
			onClick: () => {
				this.openInLumbre(link.task);
			},
		});

		// Una tarea que todavía no existe en Lumbre no puede tener adjuntos: el
		// servidor rechaza con 404 un `taskId` que no encuentra vivo.
		const attach = this.button(row.actions, {
			text: 'Adjuntar fichero…',
			icon: 'paperclip',
			onClick: () => {
				this.host.attachFile(link.task);
			},
		});
		attach.disabled = link.syncState !== 'materialized';

		if (operation !== undefined && operation.state === 'recoverable_error') {
			this.button(row.actions, {
				text: 'Reintentar',
				icon: 'rotate-ccw',
				onClick: () => {
					void this.retry(operation.id);
				},
			});
		}

		if (this.confirmingUnlink === link.id) {
			this.button(row.actions, {
				text: 'Confirmar',
				cls: 'lumbre-button--danger',
				onClick: () => {
					void this.unlink(link.id);
				},
			});
			this.button(row.actions, {
				text: 'Cancelar',
				onClick: () => {
					this.confirmingUnlink = null;
					this.render();
				},
			});
			row.actions.createSpan({
				cls: 'lumbre-task__meta-item',
				text: 'Se quita el vínculo; la tarea sigue en Lumbre.',
			});
			return;
		}

		this.button(row.actions, {
			text: 'Desvincular',
			icon: 'unlink',
			onClick: () => {
				this.confirmingUnlink = link.id;
				this.render();
			},
		});
	}

	/**
	 * Una fila de tarea: checkbox, título, metadatos y chip. La usan las tareas
	 * vinculadas y las de la lista de proyecto, que se pintan igual.
	 */
	private renderTaskRow(
		parent: HTMLElement,
		task: LumbreTask,
		chip: ChipState,
	): { row: HTMLElement; meta: HTMLElement; actions: HTMLElement } {
		const cancelled = task.cancelledAt !== null;
		const row = parent.createDiv({ cls: 'lumbre-task' });
		const main = row.createDiv({ cls: 'lumbre-task__main' });

		if (cancelled) {
			// Una cancelada no se completa ni se reabre desde aquí: eso se hace en
			// Lumbre. Sin checkbox, y el hueco se queda para que la fila no baile.
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

		const title = main.createSpan({ cls: 'lumbre-task__title', text: task.content });
		title.toggleClass('lumbre-task__title--cancelled', cancelled);

		if (chip.label !== null) {
			const label = main.createSpan({
				cls: `lumbre-chip lumbre-chip--${chip.tone ?? 'pending'}`,
				text: chip.label,
			});
			if (chip.reason !== null) label.setAttribute('title', chip.reason);
		}

		const meta = row.createDiv({ cls: 'lumbre-task__meta' });
		if (cancelled) meta.createSpan({ cls: 'lumbre-task__meta-item', text: 'Cancelada' });
		if (task.list !== null) {
			meta.createSpan({ cls: 'lumbre-task__meta-item', text: task.list.name });
		}
		if (task.date !== null) {
			meta.createSpan({ cls: 'lumbre-task__meta-item', text: task.date });
		}
		// Solo cuando la API lo dice: `undefined` es "el servidor no lo cuenta", no
		// "no tiene ninguno". Y un cero no se pinta, que no aporta nada.
		if (task.attachmentCount !== undefined && task.attachmentCount > 0) {
			const attachments = meta.createSpan({ cls: 'lumbre-task__meta-item' });
			const icon = attachments.createSpan({ cls: 'lumbre-block__icon' });
			setIcon(icon, 'paperclip');
			attachments.createSpan({ text: String(task.attachmentCount) });
			attachments.setAttribute(
				'aria-label',
				task.attachmentCount === 1 ? '1 adjunto' : `${task.attachmentCount} adjuntos`,
			);
		}

		const actions = row.createDiv({ cls: 'lumbre-task__actions' });
		return { row, meta, actions };
	}

	private renderSearch(root: HTMLElement): void {
		const section = this.section(root, 'Vincular una tarea de Lumbre');
		const form = section.createDiv({ cls: 'lumbre-search' });

		const input = form.createEl('input', { type: 'search', cls: 'lumbre-search__input' });
		input.placeholder = 'Título de la tarea, o nombre de una lista';
		input.value = this.searchQuery;
		input.disabled = this.file === null;
		input.setAttribute('aria-label', 'Texto para buscar tareas en Lumbre');
		input.addEventListener('input', () => {
			this.searchQuery = input.value;
		});
		input.addEventListener('keydown', (event: KeyboardEvent) => {
			if (event.key !== 'Enter') return;
			event.preventDefault();
			void this.search();
		});

		const button = this.button(form, {
			text: this.searching ? 'Buscando…' : 'Buscar',
			icon: 'search',
			onClick: () => {
				void this.search();
			},
		});
		button.disabled = this.searching || this.file === null;

		const results = this.searchResults;
		if (results === null) return;
		if (results.length === 0) {
			section.createDiv({ cls: 'lumbre-empty', text: 'Ninguna tarea con ese texto.' });
			return;
		}

		const list = section.createDiv({ cls: 'lumbre-list' });
		for (const task of results) {
			const row = this.renderTaskRowStatic(list, task);
			this.button(row.actions, {
				text: 'Vincular',
				icon: 'link',
				onClick: () => {
					void this.linkExisting(task);
				},
			});
		}
	}

	/** Fila de solo lectura, sin checkbox: la de los resultados del buscador. */
	private renderTaskRowStatic(
		parent: HTMLElement,
		task: LumbreTask,
	): { actions: HTMLElement } {
		const row = parent.createDiv({ cls: 'lumbre-task' });
		row.createDiv({ cls: 'lumbre-task__main' }).createSpan({
			cls: 'lumbre-task__title',
			text: task.content,
		});
		const meta = row.createDiv({ cls: 'lumbre-task__meta' });
		if (task.list !== null) meta.createSpan({ cls: 'lumbre-task__meta-item', text: task.list.name });
		if (task.date !== null) meta.createSpan({ cls: 'lumbre-task__meta-item', text: task.date });
		return { actions: row.createDiv({ cls: 'lumbre-task__actions' }) };
	}

	private renderProject(root: HTMLElement): void {
		const project = this.project;
		if (project === null) return;

		const section = this.section(root, `Lista ${project.name ?? '(sin resolver)'}`);
		if (project.loading) {
			section.createDiv({ cls: 'lumbre-empty', text: 'Cargando las tareas de la lista…' });
			return;
		}
		if (project.error !== null) {
			const failed = section.createDiv({ cls: 'lumbre-notice lumbre-notice--error' });
			failed.createSpan({ text: project.error });
			this.button(failed, {
				text: 'Reintentar',
				icon: 'rotate-ccw',
				onClick: () => {
					void this.loadProject(true);
				},
			});
			return;
		}
		if (project.tasks.length === 0) {
			section.createDiv({ cls: 'lumbre-empty', text: 'Esta lista no tiene tareas abiertas.' });
			return;
		}

		// El bloque entero se construye DESENGANCHADO del documento y entra de una
		// vez: con 200 tareas, insertar fila a fila son 200 recálculos de layout.
		const holder = createDiv({ cls: 'lumbre-groups' });
		const operations = this.host.queue.pending();
		for (const group of groupBySection(project.tasks)) {
			const block = holder.createDiv({ cls: 'lumbre-group' });
			block.createDiv({ cls: 'lumbre-group__title', text: group.name });
			const list = block.createDiv({ cls: 'lumbre-list' });
			for (const task of group.tasks) {
				const chip = linkChipState(
					{ syncState: 'materialized', error: null },
					pendingOperationFor(operations, task.id),
				);
				this.renderTaskRow(list, task, chip);
			}
		}
		section.appendChild(holder);
	}

	// ── Acciones ─────────────────────────────────────────────────────────────

	/** Completa o reabre. Encola, pinta "Enviando…" y relee cuando la cola acaba. */
	private async toggleDone(task: LumbreTask, done: boolean): Promise<void> {
		const file = this.file;
		await this.host.queue.enqueueStatus(task.id, done, {
			notePath: file?.path ?? '',
			label: file?.basename ?? 'Sin nota',
			excerpt: null,
		});
		this.render();

		await this.host.queue.flush();
		await this.refreshLinks();
		await this.loadProject(true);
		this.render();
	}

	private async retry(operationId: string): Promise<void> {
		await this.host.queue.retry(operationId);
		this.render();
		await this.host.queue.flush();
		await this.refreshLinks();
		this.render();
	}

	private async unlink(linkId: string): Promise<void> {
		await this.host.links.unlink(linkId);
		this.confirmingUnlink = null;
		this.render();
	}

	private async search(): Promise<void> {
		if (this.searching || this.file === null) return;
		this.searching = true;
		this.render();

		// Una sola petición y el filtro en cliente: la API no busca por texto y
		// `notes=none` evita traer el cuerpo de cada tarea para nada.
		const read = await this.host.client.listTasks({
			scope: 'all',
			includeDone: false,
			notes: 'none',
		});
		this.searching = false;

		if (!read.ok) {
			new Notice(`No se pudo buscar en Lumbre. ${describeFailure(read.reason, read.status)}`);
			this.searchResults = [];
			this.render();
			return;
		}

		this.searchResults = filterTasks(read.value, this.searchQuery).slice(0, MAX_SEARCH_RESULTS);
		this.render();
	}

	/** Vincula una tarea que YA existe: no se encola nada, solo se guarda el mapa. */
	private async linkExisting(task: LumbreTask): Promise<void> {
		const file = this.file;
		if (file === null) return;
		await this.host.links.link(file.path, task, { label: file.basename, excerpt: null });
		new Notice('Tarea vinculada a esta nota');
		this.searchResults = null;
		this.render();
	}

	private openInLumbre(task: LumbreTask): void {
		const links = taskDeepLinks(task, this.host.webOrigin());
		// En escritorio el esquema nativo abre la app de Lumbre; en móvil no hay app
		// que lo atienda, así que va la web.
		window.open(Platform.isDesktopApp ? links.native : links.web);
	}

	/** Carga las tareas de la lista de la nota, si la nota tiene `lumbre-list`. */
	private async loadProject(force = false): Promise<void> {
		const file = this.file;
		if (file === null) {
			this.project = null;
			return;
		}
		const listId = this.host.noteListId(file);
		if (listId === null) {
			this.project = null;
			return;
		}
		if (this.project !== null && this.project.loading && !force) return;

		this.project = { name: null, tasks: [], loading: true, error: null };
		this.render();

		await this.host.lists.get();
		const ref = this.host.lists.refFor(listId);
		if (!this.stillOn(file)) return;
		if (ref === null) {
			this.project = {
				name: null,
				tasks: [],
				loading: false,
				error: 'No se ha podido resolver la lista de la nota; comprueba la conexión y el token.',
			};
			this.render();
			return;
		}

		// `?list=` sin `scope` ya vale por "todas las de esa lista" en la API.
		const read = await this.host.client.listTasks({
			list: ref.name,
			includeDone: false,
			notes: 'none',
		});
		if (!this.stillOn(file)) return;

		this.project = read.ok
			? { name: ref.name, tasks: read.value, loading: false, error: null }
			: {
					name: ref.name,
					tasks: [],
					loading: false,
					error: describeFailure(read.reason, read.status),
				};
		this.render();
	}

	// ── Trozos de interfaz reutilizados ──────────────────────────────────────

	private section(root: HTMLElement, title: string): HTMLElement {
		const section = root.createDiv({ cls: 'lumbre-section' });
		section.createEl('h3', { cls: 'lumbre-section__title', text: title });
		return section;
	}

	private button(
		parent: HTMLElement,
		options: { text: string; cls?: string; icon?: string; onClick: () => void },
	): HTMLButtonElement {
		const button = parent.createEl('button', {
			cls: options.cls === undefined ? 'lumbre-button' : `lumbre-button ${options.cls}`,
		});
		if (options.icon !== undefined) {
			const icon = button.createSpan({ cls: 'lumbre-button__icon' });
			setIcon(icon, options.icon);
		}
		button.createSpan({ text: options.text });
		button.addEventListener('click', options.onClick);
		return button;
	}
}
