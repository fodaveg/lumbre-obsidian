import {
	Notice,
	Platform,
	Plugin,
	requestUrl,
	type Editor,
	type MarkdownFileInfo,
	type MarkdownPostProcessorContext,
	type MarkdownView,
	type Menu,
	type TAbstractFile,
	type TFile,
	type WorkspaceLeaf,
} from 'obsidian';

import { LumbreApi } from './api/lumbre-api';
import { FileSuggestModal } from './attachments/file-suggest-modal';
import { checkUploadSize, formatBytes, mimeForExtension } from './attachments/upload';
import { BrlCache } from './blocks/brl-cache';
import {
	LUMBRE_BRL_BLOCK_LANGUAGE,
	LumbreBrlBlock,
	type BrlBlockHost,
} from './blocks/brl-block';
import { QueryCache } from './blocks/query-cache';
import { LUMBRE_BLOCK_LANGUAGE, LumbreTaskBlock, type TaskBlockHost } from './blocks/task-block';
import { BrlEntryModal } from './brl/brl-modal';
import { BRL_TODAY, brlCreateOp, type BrlKind } from './brl/brl-ops';
import { LinkStore } from './links/link-store';
import { NOTE_LIST_PROPERTY, readNoteListId, writeNoteListId } from './links/note-list';
import {
	describeFailure,
	LumbreClient,
	MAX_AGENT_PROMPT_LENGTH,
	type AgentPlan,
	type LumbreResult,
} from './lumbre/client';
import { ListCache } from './lumbre/list-cache';
import { OperationQueue, type LinkTarget } from './lumbre/queue';
import { planToOps } from './soplo/plan-to-ops';
import { SoploModal } from './soplo/soplo-modal';
import { taskFromDraft, type LumbreTask, type TaskDraft } from './lumbre/types';
import {
	DEFAULT_SETTINGS,
	LumbreSettingTab,
	type LumbreSettings,
	type LumbreSettingsHost,
} from './settings';
import { PluginStore, type DeviceIdStore } from './storage/plugin-store';
import { PluginDataTokenStore, type TokenStore } from './token-store';
import { draftFromEditor, type EditorContext } from './ui/draft-from-editor';
import { ListSuggestModal } from './ui/list-suggest-modal';
import {
	NOTE_TASKS_ICON,
	NOTE_TASKS_VIEW_TYPE,
	NoteTasksView,
	type NoteTasksHost,
} from './ui/note-tasks-view';
import { SendTaskModal } from './ui/send-modal';

/** Clave del id de dispositivo en el almacenamiento LOCAL de Obsidian. */
const DEVICE_ID_KEY = 'lumbre:device-id';

/**
 * `app.setting` no está en los tipos públicos de Obsidian, pero es la única vía
 * de abrir la pestaña de ajustes del plugin desde un botón. Se declara aquí la
 * forma mínima y se comprueba en tiempo de ejecución: si un día deja de existir,
 * el botón avisa en vez de romper el panel.
 */
interface SettingsOpener {
	setting?: { open(): void; openTabById(id: string): void };
}

export default class LumbrePlugin extends Plugin implements LumbreSettingsHost {
	/** Ver el comentario de `LumbreSettingsHost.config`: el nombre evita `Plugin.settings` de 1.13. */
	config: LumbreSettings = { ...DEFAULT_SETTINGS };

	store!: PluginStore;
	tokenStore!: TokenStore;
	client!: LumbreClient;
	queue!: OperationQueue;
	links!: LinkStore;
	lists!: ListCache;
	queries!: QueryCache;
	brl!: BrlCache;

	/**
	 * API PÚBLICA del plugin, alcanzable como `app.plugins.plugins.lumbre.api` y
	 * documentada en `docs/API.md`. Es lo que se promete a Dataview y a js-engine:
	 * la superficie no se rompe sin subir `version`.
	 */
	api!: LumbreApi;

	/**
	 * Quién quiere enterarse de que han cambiado la cola o los vínculos. El panel
	 * se apunta aquí en vez de que el plugin guarde una referencia a la vista:
	 * las vistas van y vienen con los leaves, y una referencia guardada sobrevive
	 * a la vista que la creó.
	 */
	private readonly dataListeners = new Set<() => void>();

	async onload(): Promise<void> {
		this.store = new PluginStore(this, this.deviceIdStore());
		await this.store.load();
		this.config = this.store.data.settings;
		this.tokenStore = new PluginDataTokenStore(this.store);

		this.client = new LumbreClient({
			// Como función: así cambiar el origen en los ajustes no deja al cliente
			// apuntando al servidor anterior.
			apiOrigin: () => this.config.apiOrigin,
			getToken: () => this.tokenStore.get(),
			request: (init) => requestUrl(init),
		});
		this.queue = new OperationQueue({
			client: this.client,
			storage: this.store,
			// Materializar es el único momento en que un cambio deja de ser una
			// promesa: ahí caducan los bloques y se asientan sus casillas.
			onMaterialized: () => {
				void this.refreshBlocks();
			},
		});
		this.links = new LinkStore({ storage: this.store });
		this.lists = new ListCache({ client: this.client });
		this.queries = new QueryCache({
			client: this.client,
			onRefresh: () => {
				this.api.notifyTasksChanged();
			},
		});
		this.brl = new BrlCache({ client: this.client });
		this.api = new LumbreApi({
			version: this.manifest.version,
			client: this.client,
			queue: this.queue,
			links: this.links,
			cache: this.queries,
			lists: this.lists,
			openUrl: (url: string) => {
				window.open(url);
			},
			webOrigin: () => this.config.apiOrigin,
			isDesktopApp: () => Platform.isDesktopApp,
			triggerWorkspace: (event: string) => {
				this.app.workspace.trigger(event);
			},
		});

		this.addSettingTab(new LumbreSettingTab(this.app, this));
		this.registerMarkdownCodeBlockProcessor(
			LUMBRE_BLOCK_LANGUAGE,
			(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
				ctx.addChild(new LumbreTaskBlock(el, source, ctx.sourcePath, this.taskBlockHost()));
			},
		);
		this.registerMarkdownCodeBlockProcessor(
			LUMBRE_BRL_BLOCK_LANGUAGE,
			(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
				ctx.addChild(new LumbreBrlBlock(el, source, ctx.sourcePath, this.brlBlockHost()));
			},
		);
		this.registerView(
			NOTE_TASKS_VIEW_TYPE,
			(leaf: WorkspaceLeaf) => new NoteTasksView(leaf, this.noteTasksHost()),
		);
		this.addRibbonIcon(NOTE_TASKS_ICON, 'Tareas de esta nota', () => {
			void this.openNoteTasksView();
		});
		this.registerCommands();

		// La nota se identifica por RUTA, así que un renombrado hay que seguirlo o
		// el enlace se pierde. Vale igual para carpetas: `renamePath` casa el
		// prefijo.
		this.registerEvent(
			this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
				void this.links.renamePath(oldPath, file.path).then(() => {
					this.notifyDataChange();
				});
			}),
		);
		this.registerEvent(
			this.app.vault.on('delete', (file: TAbstractFile) => {
				void this.links.markDeleted(file.path).then(() => {
					this.notifyDataChange();
				});
			}),
		);
		this.registerEvent(
			this.app.workspace.on(
				'editor-menu',
				(menu: Menu, editor: Editor, info: MarkdownView | MarkdownFileInfo) => {
					menu.addItem((item) =>
						item
							.setTitle('Enviar a Lumbre')
							.setIcon(NOTE_TASKS_ICON)
							.onClick(() => {
								void this.openSendModal(info.file ?? null, editorContext(editor));
							}),
					);
					menu.addItem((item) =>
						item
							.setTitle('Soplo con la selección')
							.setIcon('sparkles')
							.onClick(() => {
								this.openSoploModal(info.file ?? null, soploSource(editor));
							}),
					);
				},
			),
		);

		// Al volver la red hay que drenar lo que se encoló sin conexión.
		this.registerDomEvent(window, 'online', () => {
			this.api.notifyConnectionChanged(true);
			void this.flushIfConnected();
		});
		this.registerDomEvent(window, 'offline', () => {
			this.api.notifyConnectionChanged(false);
		});

		void this.flushIfConnected();
	}

	/**
	 * Devuelve el cliente, con el origen y el token que hay AHORA mismo. Es una
	 * sola instancia a propósito: el origen se lee en cada llamada y el `flush()`
	 * compartido solo funciona si todos los llamadores usan el mismo cliente.
	 */
	createClient(): LumbreClient {
		return this.client;
	}

	/** Guarda los ajustes. `this.config` ES el objeto que vive dentro del almacén. */
	async saveSettings(): Promise<void> {
		this.store.data.settings = this.config;
		await this.store.save();
	}

	// ── Comandos ─────────────────────────────────────────────────────────────

	/**
	 * Los nombres van SIN "Lumbre:" delante: Obsidian ya antepone el nombre del
	 * plugin en la paleta, y escribirlo aquí sale duplicado.
	 */
	private registerCommands(): void {
		this.addCommand({
			id: 'send-task',
			// En la paleta sale como "Lumbre: Enviar como tarea": el nombre del plugin
			// lo antepone Obsidian, y repetirlo aquí lo prohíbe el linter de plugins.
			// En el menú contextual, que NO lleva prefijo, sí se escribe entero.
			name: 'Enviar como tarea',
			editorCallback: (editor: Editor, context: MarkdownView | MarkdownFileInfo) => {
				void this.openSendModal(context.file ?? null, editorContext(editor));
			},
		});

		this.addCommand({
			id: 'open-note-tasks',
			name: 'Abrir las tareas de esta nota',
			callback: () => {
				void this.openNoteTasksView();
			},
		});

		this.addCommand({
			id: 'link-note-to-list',
			name: 'Vincular esta nota a una lista',
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (file === null) return false;
				if (!checking) void this.linkNoteToList(file);
				return true;
			},
		});

		this.addCommand({
			id: 'unlink-note-from-list',
			name: 'Quitar el vínculo con la lista',
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (file === null || readNoteListId(this.app, file) === null) return false;
				if (!checking) void this.unlinkNoteFromList(file);
				return true;
			},
		});

		this.addCommand({
			id: 'brl-entry',
			name: 'Anotar en el BRL',
			editorCallback: (editor: Editor) => {
				new BrlEntryModal(this.app, {
					defaultText: editor.getSelection(),
					onSubmit: (text: string, kind: BrlKind) => this.sendBrlEntry(text, kind),
				}).open();
			},
		});

		this.addCommand({
			id: 'insert-brl-today',
			name: 'Insertar el BRL de hoy como texto',
			editorCallback: (editor: Editor) => {
				void this.insertBrlToday(editor);
			},
		});

		this.addCommand({
			id: 'soplo-selection',
			name: 'Soplo con la selección',
			editorCallback: (editor: Editor, context: MarkdownView | MarkdownFileInfo) => {
				this.openSoploModal(context.file ?? null, soploSource(editor));
			},
		});
	}

	// ── BRL ──────────────────────────────────────────────────────────────────

	/**
	 * Encola una entrada del registro del día y avisa. El texto de la nota NO se
	 * toca: el BRL vive en Lumbre, igual que las tareas.
	 */
	private async sendBrlEntry(text: string, kind: BrlKind): Promise<void> {
		const operation = brlCreateOp(text, kind);
		if (operation === null) {
			new Notice('La entrada necesita un texto.');
			return;
		}

		const file = this.app.workspace.getActiveFile();
		const queued = await this.queue.enqueueBrl(operation.date, operation.entry, {
			notePath: file?.path ?? '',
			label: file?.basename ?? 'Sin nota',
			excerpt: null,
		});
		new Notice(kind === 'thought' ? 'Pensamiento enviado al BRL' : 'Nota enviada al BRL');
		this.notifyDataChange();

		await this.queue.flush();
		const after = this.queue.pending().find((candidate) => candidate.id === queued.id);
		if (after?.state === 'rejected') {
			new Notice(after.error ?? 'Lumbre rechazó la entrada del BRL.');
		}
		await this.refreshBrl();
	}

	/**
	 * Pega el BRL de hoy en el cursor. Es la ÚNICA vez que el registro entra en un
	 * fichero del vault, y es una FOTO FIJA: lo pide el usuario a mano y desde ahí
	 * el texto es suyo, no se vuelve a tocar.
	 */
	private async insertBrlToday(editor: Editor): Promise<void> {
		const read = await this.brl.get(BRL_TODAY, true);
		// Aquí NO vale la última lectura buena, a diferencia del bloque: esto
		// ESCRIBE en la nota, y un texto de hace media hora pegado en el fichero ya
		// no se distingue del de ahora. Si la lectura falla, no se pega nada.
		if (read.error !== null || read.fetchedAt === null) {
			new Notice(read.error ?? 'No se pudo leer el BRL de hoy.');
			return;
		}
		if (read.markdown.trim().length === 0) {
			new Notice('El registro de hoy está vacío.');
			return;
		}
		editor.replaceSelection(read.markdown.trimEnd().concat('\n'));
		new Notice('BRL de hoy insertado en la nota');
	}

	// ── Soplo ────────────────────────────────────────────────────────────────

	/**
	 * Abre el preview de Soplo sobre un texto. La IA propone y el usuario
	 * confirma: aquí no se aplica nada, solo se pregunta.
	 */
	private openSoploModal(file: TFile | null, source: string): void {
		const text = source.trim();
		if (text.length === 0) {
			new Notice('Selecciona un texto, o pon el cursor en un párrafo.');
			return;
		}

		const truncated = text.length > MAX_AGENT_PROMPT_LENGTH;
		const prompt = truncated ? text.slice(0, MAX_AGENT_PROMPT_LENGTH) : text;

		new SoploModal(this.app, {
			text: prompt,
			truncated,
			ask: (): Promise<LumbreResult<AgentPlan>> => this.client.agent(prompt),
			apply: (plan: AgentPlan, checked: boolean[]) => this.applySoploPlan(plan, checked, file),
			openUrl: (url: string) => {
				window.open(url);
			},
			webOrigin: () => this.config.apiOrigin,
		}).open();
	}

	/**
	 * Aplica SOLO lo marcado, por la cola durable. Las tareas que nacen del plan
	 * se vinculan a la nota desde la que se pidió: sus ids los fija el plan, así
	 * que el vínculo ya puede apuntar a ellos antes de que Lumbre las materialice.
	 */
	private async applySoploPlan(
		plan: AgentPlan,
		checked: boolean[],
		file: TFile | null,
	): Promise<void> {
		const { ops, createdTaskIds, skipped } = planToOps(plan.plan, checked);
		if (ops.length === 0) {
			new Notice(
				skipped > 0
					? 'Nada que aplicar: lo marcado no son tareas.'
					: 'No has marcado ninguna acción.',
			);
			return;
		}

		const target: LinkTarget = {
			notePath: file?.path ?? '',
			label: file?.basename ?? 'Sin nota',
			excerpt: null,
		};
		const operation = await this.queue.enqueueBatch(ops, createdTaskIds, target);

		if (file !== null) {
			for (const op of ops) {
				if (op.type !== 'create') continue;
				await this.links.link(
					file.path,
					taskFromDraft(op.draft, op.clientTaskId, this.lists.refFor(op.draft.listId ?? null)),
					{ label: target.label, excerpt: null },
					'pending_local',
				);
			}
		}

		new Notice(
			skipped > 0
				? `${ops.length} acciones enviadas a Lumbre; ${skipped} no eran tareas y se han saltado.`
				: `${ops.length} ${ops.length === 1 ? 'acción enviada' : 'acciones enviadas'} a Lumbre`,
		);
		this.notifyDataChange();

		await this.queue.flush();
		const after = this.queue.pending().find((candidate) => candidate.id === operation.id);
		if (after?.state === 'rejected') {
			new Notice(after.error ?? 'Lumbre rechazó parte del plan.');
		}
		if (file !== null && navigator.onLine) await this.links.refresh(file.path, this.client);
		this.notifyDataChange();
	}

	// ── Adjuntos ─────────────────────────────────────────────────────────────

	/**
	 * Elige un fichero del vault y lo sube como adjunto de la tarea.
	 *
	 * Va DIRECTO, no por la cola: la cola persiste en `data.json`, que viaja por
	 * Obsidian Sync, y meter ahí los bytes de un fichero de 25 MB hincharía el
	 * fichero de datos del plugin. Si falla, se ofrece reintentar.
	 */
	private attachFileToTask(task: LumbreTask): void {
		new FileSuggestModal(this.app, (file: TFile) => {
			void this.uploadAttachment(task, file);
		}).open();
	}

	private async uploadAttachment(task: LumbreTask, file: TFile): Promise<void> {
		const size = checkUploadSize(file.stat.size);
		if (!size.ok) {
			new Notice(size.message);
			return;
		}

		new Notice(`Subiendo ${file.name} (${formatBytes(file.stat.size)})…`);
		const bytes = await this.app.vault.readBinary(file);
		const result = await this.client.uploadAttachment(
			task.id,
			file.name,
			mimeForExtension(file.extension),
			bytes,
		);

		if (result.ok) {
			new Notice(`${file.name} adjuntado a «${task.content}»`);
			// El recuento de adjuntos sale de la tarea, así que hay que releerla.
			for (const notePath of this.links.notesForTask(task.id)) {
				await this.links.refresh(notePath, this.client);
			}
			this.notifyDataChange();
			return;
		}

		// Un fallo de red se puede reintentar tal cual; un 404 significa que la
		// tarea ya no está viva en Lumbre y reintentar no arreglaría nada.
		const notice = new Notice(
			`No se pudo adjuntar ${file.name}. ${describeFailure(result.reason, result.status)}`,
			10_000,
		);
		if (result.reason !== 'network' && result.reason !== 'server') return;
		const retry = notice.messageEl.createEl('button', { cls: 'lumbre-button' });
		retry.setText('Reintentar');
		retry.addEventListener('click', () => {
			notice.hide();
			void this.uploadAttachment(task, file);
		});
	}

	/** Caduca el registro del día y refresca los bloques `lumbre-brl` montados. */
	private async refreshBrl(): Promise<void> {
		await this.brl.refreshAll();
		this.notifyDataChange();
	}

	/** Abre el panel en la barra lateral derecha y lo trae al frente. */
	private async openNoteTasksView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(NOTE_TASKS_VIEW_TYPE);
		const leaf = existing[0] ?? this.app.workspace.getRightLeaf(false);
		if (leaf === null) return;
		if (existing.length === 0) await leaf.setViewState({ type: NOTE_TASKS_VIEW_TYPE, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}

	/**
	 * Abre el modal de enviar. Las listas se piden ANTES para que el desplegable
	 * salga poblado; si no hay red se abre igual con lo cacheado.
	 */
	private async openSendModal(file: TFile | null, context?: EditorContext): Promise<void> {
		const draft = draftFromEditor(context ?? { selection: '', line: '' });
		const lists = await this.lists.get();
		new SendTaskModal(this.app, {
			lists,
			defaults: {
				title: draft.title,
				listId: file === null ? null : readNoteListId(this.app, file),
			},
			onSubmit: (submitted: TaskDraft) => this.sendDraft(submitted, file, draft.excerpt),
		}).open();
	}

	/**
	 * Encola la creación, deja el vínculo en pendiente y drena. El texto de la
	 * nota NO se toca: lo único que queda en el vault es el mapa de `data.json`.
	 */
	private async sendDraft(
		draft: TaskDraft,
		file: TFile | null,
		excerpt: string | null,
	): Promise<void> {
		const target: LinkTarget = {
			notePath: file?.path ?? '',
			label: file?.basename ?? 'Sin nota',
			excerpt,
		};
		const operation = await this.queue.enqueueCreate(draft, target);

		if (file !== null) {
			// El vínculo se crea YA, en pendiente: el id de la tarea es el
			// `clientTaskId`, así que la primera relectura buena lo confirma sola.
			await this.links.link(
				file.path,
				taskFromDraft(draft, operation.clientTaskId, this.lists.refFor(draft.listId ?? null)),
				{ label: target.label, excerpt },
				'pending_local',
			);
		}

		new Notice('Enviada a Lumbre');
		this.notifyDataChange();

		await this.queue.flush();
		const after = this.queue.pending().find((candidate) => candidate.id === operation.id);
		if (after?.state === 'rejected') {
			new Notice(after.error ?? 'Lumbre rechazó la tarea.');
		}
		if (file !== null && navigator.onLine) await this.links.refresh(file.path, this.client);
		this.notifyDataChange();
	}

	/** Escribe `lumbre-list` en la nota. Es la ÚNICA escritura del plugin en el vault. */
	private async linkNoteToList(file: TFile): Promise<void> {
		const lists = await this.lists.get();
		if (lists.length === 0) {
			new Notice('No se han podido leer las listas de Lumbre.');
			return;
		}
		new ListSuggestModal(this.app, lists, (list) => {
			void writeNoteListId(this.app, file, list.id).then(() => {
				new Notice(`Nota vinculada a la lista ${list.name}`);
				this.notifyDataChange();
			});
		}).open();
	}

	private async unlinkNoteFromList(file: TFile): Promise<void> {
		await writeNoteListId(this.app, file, null);
		new Notice(`Quitada la propiedad ${NOTE_LIST_PROPERTY} de la nota`);
		this.notifyDataChange();
	}

	// ── Cableado de los bloques ──────────────────────────────────────────────

	private taskBlockHost(): TaskBlockHost {
		return {
			cache: this.queries,
			lists: this.lists,
			queue: this.queue,
			setTaskDone: (task: LumbreTask, done: boolean, notePath: string) =>
				this.setTaskDone(task, done, notePath),
			noteListId: (notePath: string) => {
				const file = this.app.vault.getFileByPath(notePath);
				return file === null ? null : readNoteListId(this.app, file);
			},
			onDataChange: (listener: () => void) => {
				this.dataListeners.add(listener);
				return () => this.dataListeners.delete(listener);
			},
		};
	}

	private brlBlockHost(): BrlBlockHost {
		return {
			cache: this.brl,
			app: this.app,
			onDataChange: (listener: () => void) => {
				this.dataListeners.add(listener);
				return () => this.dataListeners.delete(listener);
			},
		};
	}

	/**
	 * Completa o reabre desde un bloque. Encola, drena y solo avisa con un Notice
	 * si Lumbre RECHAZÓ la operación: un refresco normal no interrumpe a nadie.
	 */
	private async setTaskDone(task: LumbreTask, done: boolean, notePath: string): Promise<void> {
		const file = notePath.length === 0 ? null : this.app.vault.getFileByPath(notePath);
		const operation = await this.queue.enqueueStatus(task.id, done, {
			notePath,
			label: file?.basename ?? 'Sin nota',
			excerpt: null,
		});
		this.notifyDataChange();

		await this.queue.flush();
		const after = this.queue.pending().find((candidate) => candidate.id === operation.id);
		if (after?.state === 'rejected') {
			new Notice(after.error ?? 'Lumbre rechazó la operación.');
		}
		this.notifyDataChange();
	}

	/** Caduca las consultas y refresca de golpe los bloques que estén montados. */
	private async refreshBlocks(): Promise<void> {
		await this.queries.refreshAll();
		this.notifyDataChange();
	}

	// ── Cableado del panel ───────────────────────────────────────────────────

	private noteTasksHost(): NoteTasksHost {
		return {
			links: this.links,
			queue: this.queue,
			client: this.client,
			lists: this.lists,
			webOrigin: () => this.config.apiOrigin,
			hasToken: async () => (await this.tokenStore.get()) !== null,
			openSettings: () => {
				const { setting } = this.app as unknown as SettingsOpener;
				if (setting === undefined) {
					new Notice('Abre los ajustes de Obsidian y busca Lumbre.');
					return;
				}
				setting.open();
				setting.openTabById(this.manifest.id);
			},
			openSendModal: (file: TFile | null) => {
				void this.openSendModal(file);
			},
			attachFile: (task: LumbreTask) => {
				this.attachFileToTask(task);
			},
			noteListId: (file: TFile) => readNoteListId(this.app, file),
			onDataChange: (listener: () => void) => {
				this.dataListeners.add(listener);
				return () => this.dataListeners.delete(listener);
			},
		};
	}

	/** Avisa al panel de que la cola o los vínculos han cambiado. */
	private notifyDataChange(): void {
		for (const listener of this.dataListeners) listener();
	}

	/** Drena la cola, pero solo si hay token: sin él no hay nada que intentar. */
	private async flushIfConnected(): Promise<void> {
		const token = await this.tokenStore.get();
		if (token === null) return;
		await this.queue.flush();
		this.notifyDataChange();
	}

	/**
	 * El id de dispositivo va al almacenamiento LOCAL de Obsidian, que no
	 * sincroniza: si viajara por Sync, dos dispositivos se creerían el mismo y
	 * enviarían las mismas operaciones encoladas.
	 *
	 * Devuelve `undefined` si esa API no existe en la versión que está corriendo
	 * (el manifest declara minAppVersion 1.11.4): entonces el id cae a `data.json`,
	 * que es peor pero funciona.
	 */
	private deviceIdStore(): DeviceIdStore | undefined {
		if (typeof this.app.loadLocalStorage !== 'function') return undefined;
		return {
			read: () => {
				const stored: unknown = this.app.loadLocalStorage(DEVICE_ID_KEY);
				return typeof stored === 'string' && stored.length > 0 ? stored : null;
			},
			write: (id: string) => {
				this.app.saveLocalStorage(DEVICE_ID_KEY, id);
			},
		};
	}
}

/** Lo que hay bajo el cursor, para prefijar el título de la tarea. */
function editorContext(editor: Editor): EditorContext {
	return { selection: editor.getSelection(), line: editor.getLine(editor.getCursor().line) };
}

/**
 * El texto que se le manda a Soplo: la selección, y sin selección el PÁRRAFO del
 * cursor, o sea las líneas seguidas alrededor hasta la primera en blanco. Una
 * sola línea suele ser media frase, y a Soplo hay que darle la parrafada entera
 * para que entienda de qué va.
 */
function soploSource(editor: Editor): string {
	const selection = editor.getSelection();
	if (selection.trim().length > 0) return selection;

	const cursor = editor.getCursor().line;
	if (editor.getLine(cursor).trim().length === 0) return '';

	let first = cursor;
	while (first > 0 && editor.getLine(first - 1).trim().length > 0) first -= 1;
	let last = cursor;
	const lastLine = editor.lastLine();
	while (last < lastLine && editor.getLine(last + 1).trim().length > 0) last += 1;

	const lines: string[] = [];
	for (let line = first; line <= last; line += 1) lines.push(editor.getLine(line));
	return lines.join('\n');
}
