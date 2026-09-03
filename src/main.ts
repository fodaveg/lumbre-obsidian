import {
	apiVersion,
	normalizePath,
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
import { DiagnosticsModal } from './diagnostics/diagnostics-modal';
import {
	LiveLog,
	logsFolder,
	saveReport as writeReportFile,
	type LogFileAdapter,
} from './diagnostics/log-files';
import { formatEvent, Logger, shortTitle, type LogEvent, type LogLevel } from './diagnostics/logger';
import { buildReport, DEFAULT_REPORT_EVENTS, type CacheStats } from './diagnostics/report';
import { guarded, unhandledEvent } from './diagnostics/unhandled';
import { LinkStore } from './links/link-store';
import { NOTE_LIST_PROPERTY, readNoteListId, writeNoteListId } from './links/note-list';
import {
	describeFailure,
	LumbreClient,
	MAX_AGENT_PROMPT_LENGTH,
	type AgentConsentState,
	type AgentPlan,
	type LumbreResult,
} from './lumbre/client';
import { ListCache } from './lumbre/list-cache';
import { OperationQueue, type LinkTarget } from './lumbre/queue';
import {
	collectWeeklySnapshot,
	type WeeklySnapshotDeps,
	type WeeklySnapshotOptions,
} from './review/weekly-snapshot';
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
	 * El registro de diagnóstico del plugin entero. Se crea LO PRIMERO de
	 * `onload`, antes que el almacén: si algo falla al cargar `data.json`, ese
	 * fallo tiene que quedar apuntado igual.
	 */
	logger!: Logger;

	/**
	 * Quién quiere enterarse de que han cambiado la cola o los vínculos. El panel
	 * se apunta aquí en vez de que el plugin guarde una referencia a la vista:
	 * las vistas van y vienen con los leaves, y una referencia guardada sobrevive
	 * a la vista que la creó.
	 */
	private readonly dataListeners = new Set<() => void>();

	/** El logger de `main`, que es el que usa esta clase. */
	private log!: Logger;

	/**
	 * Lo que hay que tapar en todo lo que se registre: hoy, el token. Se guarda
	 * aquí en memoria porque `redact` es SÍNCRONO y `tokenStore.get()` no, y
	 * porque comparar es la única forma de no dejarlo salir por un camino nuevo.
	 */
	private secrets: string[] = [];

	/** El registro en fichero, solo si está encendido en Ajustes. */
	private liveLog: LiveLog | null = null;
	private stopLiveLog: (() => void) | null = null;

	async onload(): Promise<void> {
		const startedAt = Date.now();
		this.logger = Logger.create({ secrets: () => this.secrets });
		this.log = this.logger.child('main');
		this.log.info('Cargando el plugin', {
			version: this.manifest.version,
			obsidian: apiVersion,
			mobile: Platform.isMobile,
			desktop: Platform.isDesktop,
		});

		this.store = new PluginStore(this, this.deviceIdStore());
		await this.store.load();
		this.config = this.store.data.settings;
		// El nivel guardado manda desde aquí: lo de arriba se apuntó con el de
		// fábrica, que es `info` y por tanto nunca se pierde.
		this.logger.setLevel(this.config.logLevel);
		this.tokenStore = this.watchedTokenStore(new PluginDataTokenStore(this.store));
		await this.refreshSecrets();
		this.log.info('Almacén cargado', {
			migratedFrom: this.store.migratedFrom,
			version: this.store.data.version,
			links: this.store.data.links.length,
			queued: this.store.data.queue.length,
			hasToken: this.secrets.length > 0,
			logLevel: this.config.logLevel,
			liveLog: this.config.liveLog,
		});
		if (this.config.liveLog) this.startLiveLog();

		this.client = new LumbreClient({
			// Como función: así cambiar el origen en los ajustes no deja al cliente
			// apuntando al servidor anterior.
			apiOrigin: () => this.config.apiOrigin,
			getToken: () => this.tokenStore.get(),
			request: (init) => requestUrl(init),
			logger: this.logger.child('http'),
		});
		this.queue = new OperationQueue({
			client: this.client,
			storage: this.store,
			// Materializar es el único momento en que un cambio deja de ser una
			// promesa: ahí caducan los bloques y se asientan sus casillas.
			onMaterialized: () => {
				void this.refreshBlocks();
			},
			logger: this.logger.child('queue'),
		});
		this.links = new LinkStore({ storage: this.store, logger: this.logger.child('links') });
		this.lists = new ListCache({ client: this.client });
		this.queries = new QueryCache({
			client: this.client,
			onRefresh: () => {
				this.api.notifyTasksChanged();
			},
			logger: this.logger.child('cache'),
		});
		this.brl = new BrlCache({ client: this.client, logger: this.logger.child('cache') });
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
			logger: this.logger.child('api'),
			buildReport: () => this.buildReport(),
			weeklySnapshot: (options?: WeeklySnapshotOptions) =>
				this.weeklySnapshot(options).then((snapshot) => snapshot.markdown),
		});

		this.addSettingTab(new LumbreSettingTab(this.app, this));
		this.registerMarkdownCodeBlockProcessor(
			LUMBRE_BLOCK_LANGUAGE,
			guarded(
				this.log,
				'procesador del bloque lumbre',
				(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
					ctx.addChild(new LumbreTaskBlock(el, source, ctx.sourcePath, this.taskBlockHost()));
				},
			),
		);
		this.registerMarkdownCodeBlockProcessor(
			LUMBRE_BRL_BLOCK_LANGUAGE,
			guarded(
				this.log,
				'procesador del bloque lumbre-brl',
				(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
					ctx.addChild(new LumbreBrlBlock(el, source, ctx.sourcePath, this.brlBlockHost()));
				},
			),
		);
		this.registerView(
			NOTE_TASKS_VIEW_TYPE,
			(leaf: WorkspaceLeaf) => new NoteTasksView(leaf, this.noteTasksHost()),
		);
		this.addRibbonIcon(
			NOTE_TASKS_ICON,
			'Tareas de esta nota',
			guarded(this.log, 'icono de la barra lateral', () => {
				this.log.info('Acción del usuario', { action: 'abrir el panel desde la barra' });
				void this.openNoteTasksView();
			}),
		);
		this.registerCommands();

		// La nota se identifica por RUTA, así que un renombrado hay que seguirlo o
		// el enlace se pierde. Vale igual para carpetas: `renamePath` casa el
		// prefijo.
		this.registerEvent(
			this.app.vault.on(
				'rename',
				guarded(this.logger.child('vault'), 'renombrado', (file: TAbstractFile, oldPath: string) => {
					void this.links.renamePath(oldPath, file.path).then(() => {
						this.notifyDataChange();
					});
				}),
			),
		);
		this.registerEvent(
			this.app.vault.on(
				'delete',
				guarded(this.logger.child('vault'), 'borrado', (file: TAbstractFile) => {
					void this.links.markDeleted(file.path).then(() => {
						this.notifyDataChange();
					});
				}),
			),
		);
		this.registerEvent(
			this.app.workspace.on(
				'editor-menu',
				guarded(
					this.logger.child('vault'),
					'menú contextual del editor',
					(menu: Menu, editor: Editor, info: MarkdownView | MarkdownFileInfo) => {
						menu.addItem((item) =>
							item
								.setTitle('Enviar a Lumbre')
								.setIcon(NOTE_TASKS_ICON)
								.onClick(() => {
									this.log.info('Acción del usuario', { action: 'enviar a Lumbre (menú)' });
									void this.openSendModal(info.file ?? null, editorContext(editor));
								}),
						);
						menu.addItem((item) =>
							item
								.setTitle('Soplo con la selección')
								.setIcon('sparkles')
								.onClick(() => {
									this.log.info('Acción del usuario', { action: 'Soplo (menú)' });
									this.openSoploModal(info.file ?? null, soploSource(editor));
								}),
						);
					},
				),
			),
		);

		// Al volver la red hay que drenar lo que se encoló sin conexión.
		this.registerDomEvent(window, 'online', () => {
			this.log.info('La red ha vuelto');
			this.api.notifyConnectionChanged(true);
			void this.flushIfConnected();
		});
		this.registerDomEvent(window, 'offline', () => {
			this.log.warn('Sin conexión');
			this.api.notifyConnectionChanged(false);
		});
		this.registerUnhandled();

		this.log.info('Plugin cargado', {
			ms: Date.now() - startedAt,
			links: this.links.all().length,
			pending: this.queue.pending().length,
		});
		void this.flushIfConnected();
	}

	onunload(): void {
		this.log.info('Plugin descargado', { pending: this.queue.pending().length });
		this.stopLiveLog?.();
		this.stopLiveLog = null;
		void this.liveLog?.flush();
		this.liveLog = null;
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
		await this.refreshSecrets();
	}

	// ── Diagnóstico ──────────────────────────────────────────────────────────

	/**
	 * Relee el token para poder taparlo en el registro. Es la ÚNICA copia del
	 * token que el plugin tiene fuera del almacén, y existe solo porque `redact`
	 * es síncrono: sin ella no se podría comprobar que un evento no lo lleva.
	 */
	private async refreshSecrets(): Promise<void> {
		const token = await this.tokenStore.get();
		this.secrets = token === null ? [] : [token];
	}

	/**
	 * El almacén del token, envuelto para que CADA cambio actualice lo que hay
	 * que tapar en el registro. Sin esto, pegar un token nuevo en los ajustes
	 * dejaría al redactor buscando el anterior.
	 */
	private watchedTokenStore(store: TokenStore): TokenStore {
		return {
			get: () => store.get(),
			set: async (token: string | null): Promise<void> => {
				await store.set(token);
				await this.refreshSecrets();
			},
		};
	}

	/** Cambia el nivel del registro, lo guarda y lo deja apuntado. */
	async setLogLevel(level: LogLevel): Promise<void> {
		this.config.logLevel = level;
		this.logger.setLevel(level);
		await this.saveSettings();
		// Se apunta como `warn` a propósito: así la línea entra en el registro en
		// vivo aunque el nivel nuevo sea `error`, y se ve desde cuándo falta lo demás.
		this.logger.child('settings').warn('Nivel del registro cambiado', { level });
	}

	/** Enciende o apaga el registro en fichero y lo guarda. */
	async setLiveLog(enabled: boolean): Promise<void> {
		this.config.liveLog = enabled;
		await this.saveSettings();
		if (enabled) this.startLiveLog();
		else this.stopLiveLogging();
		this.logger.child('settings').info('Registro en fichero', { enabled });
	}

	/**
	 * Engancha el registro en fichero. Solo se escriben `warn` y `error`: el
	 * fichero es para el fallo que ocurre cuando nadie mira, y un `debug` por
	 * repintado lo llenaría en minutos.
	 */
	private startLiveLog(): void {
		if (this.liveLog !== null) return;
		const live = new LiveLog(this.logAdapter(), this.logsFolder());
		this.liveLog = live;
		this.stopLiveLog = this.logger.onEvent((event: LogEvent) => {
			if (event.level !== 'warn' && event.level !== 'error') return;
			void live.append(formatEvent(event));
		});
	}

	private stopLiveLogging(): void {
		this.stopLiveLog?.();
		this.stopLiveLog = null;
		void this.liveLog?.flush();
		this.liveLog = null;
	}

	/** El informe entero, ya limpio. Es lo que copian los dos botones y la API. */
	buildReport(events = DEFAULT_REPORT_EVENTS): string {
		const caches: CacheStats[] = [
			{ name: 'consultas de bloques', ...this.queries.stats() },
			{ name: 'registro del día', ...this.brl.stats() },
		];
		return buildReport({
			pluginVersion: this.manifest.version,
			obsidianVersion: apiVersion,
			platform: { mobile: Platform.isMobile, desktop: Platform.isDesktop },
			apiOrigin: this.config.apiOrigin,
			hasToken: this.secrets.length > 0,
			connection: this.client.lastPing,
			queue: this.queue.snapshot(),
			links: this.links.all(),
			caches,
			events: this.logger.recent(events),
			droppedEvents: this.logger.droppedEvents + (this.liveLog?.dropped ?? 0),
			generatedAt: new Date(),
			now: Date.now(),
			secrets: this.secrets,
		});
	}

	/** Guarda el informe en la carpeta del plugin y devuelve la ruta escrita. */
	async saveReport(): Promise<string> {
		const path = await writeReportFile(
			this.logAdapter(),
			this.logsFolder(),
			this.buildReport(),
			new Date(),
		);
		this.log.info('Informe de diagnóstico guardado', { path });
		return path;
	}

	/** Dos líneas de estado: la conexión y la cola. */
	statusLines(): string[] {
		const ping = this.client.lastPing;
		const connection =
			ping === null
				? 'Conexión: sin probar todavía.'
				: ping.ok
					? `Conexión: correcta (${ping.at}).`
					: `Conexión: falló (${ping.reason ?? 'desconocido'}${
							ping.status === undefined ? '' : ` ${ping.status}`
						}).`;

		const pending = this.queue.pending();
		const failing = pending.filter(
			(operation) => operation.state === 'rejected' || operation.state === 'recoverable_error',
		).length;
		const queue =
			pending.length === 0
				? 'Cola: vacía, todo confirmado.'
				: `Cola: ${pending.length} sin materializar, ${failing} con error.`;

		return [connection, queue];
	}

	/** La carpeta de registros dentro de la configuración del vault. */
	private logsFolder(): string {
		return normalizePath(logsFolder(this.app.vault.configDir, this.manifest.id));
	}

	/**
	 * El adaptador del vault, con la forma recortada que usan los ficheros de
	 * registro. `app.vault.adapter` la cumple entera.
	 */
	private logAdapter(): LogFileAdapter {
		return this.app.vault.adapter;
	}

	/**
	 * Los errores que se escapan de la ventana. Se filtran por el stack: sin la
	 * marca `plugin:lumbre` no son nuestros y solo se apuntan en `debug`, porque
	 * la consola de Obsidian es de todos los plugins.
	 */
	private registerUnhandled(): void {
		const logger = this.logger.child('main');
		this.registerDomEvent(window, 'error', (event: ErrorEvent) => {
			const entry = unhandledEvent(event.error ?? event.message, {
				asynchronous: false,
				debug: logger.enabled('debug'),
				source: event.filename,
			});
			if (entry !== null) logger.error(entry.message, entry.data);
		});
		this.registerDomEvent(window, 'unhandledrejection', (event: PromiseRejectionEvent) => {
			const entry = unhandledEvent(event.reason, {
				asynchronous: true,
				debug: logger.enabled('debug'),
			});
			if (entry !== null) logger.error(entry.message, entry.data);
		});
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
			editorCallback: this.command(
				'send-task',
				(editor: Editor, context: MarkdownView | MarkdownFileInfo) => {
					void this.openSendModal(context.file ?? null, editorContext(editor));
				},
			),
		});

		this.addCommand({
			id: 'open-note-tasks',
			name: 'Abrir las tareas de esta nota',
			callback: this.command('open-note-tasks', () => {
				void this.openNoteTasksView();
			}),
		});

		this.addCommand({
			id: 'link-note-to-list',
			name: 'Vincular esta nota a una lista',
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (file === null) return false;
				if (!checking) this.command('link-note-to-list', () => this.linkNoteToList(file))();
				return true;
			},
		});

		this.addCommand({
			id: 'unlink-note-from-list',
			name: 'Quitar el vínculo con la lista',
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (file === null || readNoteListId(this.app, file) === null) return false;
				if (!checking) this.command('unlink-note-from-list', () => this.unlinkNoteFromList(file))();
				return true;
			},
		});

		this.addCommand({
			id: 'brl-entry',
			name: 'Anotar en el BRL',
			editorCallback: this.command('brl-entry', (editor: Editor) => {
				new BrlEntryModal(this.app, {
					defaultText: editor.getSelection(),
					onSubmit: (text: string, kind: BrlKind) => this.sendBrlEntry(text, kind),
				}).open();
			}),
		});

		this.addCommand({
			id: 'insert-brl-today',
			name: 'Insertar el BRL de hoy como texto',
			editorCallback: this.command('insert-brl-today', (editor: Editor) => {
				void this.insertBrlToday(editor);
			}),
		});

		this.addCommand({
			id: 'insert-weekly-snapshot',
			name: 'Insertar la foto semanal',
			editorCallback: this.command('insert-weekly-snapshot', (editor: Editor) => {
				void this.insertWeeklySnapshot(editor);
			}),
		});

		this.addCommand({
			id: 'soplo-selection',
			name: 'Soplo con la selección',
			editorCallback: this.command(
				'soplo-selection',
				(editor: Editor, context: MarkdownView | MarkdownFileInfo) => {
					this.openSoploModal(context.file ?? null, soploSource(editor));
				},
			),
		});

		this.addCommand({
			id: 'show-diagnostics',
			name: 'Mostrar diagnóstico',
			callback: this.command('show-diagnostics', () => {
				new DiagnosticsModal(this.app, {
					statusLines: () => this.statusLines(),
					events: (count: number) => this.logger.recent(count),
					buildReport: () => this.buildReport(),
					saveReport: () => this.saveReport(),
				}).open();
			}),
		});
	}

	/**
	 * Un comando: se apunta que se ha ejecutado y su excepción no se escapa sin
	 * registro. UN evento por comando, que es el trato del nivel `info`.
	 */
	private command<Args extends unknown[]>(
		id: string,
		run: (...args: Args) => unknown,
	): (...args: Args) => void {
		const wrapped = guarded(this.log, `comando ${id}`, (...args: Args) => {
			this.log.info('Comando ejecutado', { command: id });
			return run(...args);
		});
		return (...args: Args): void => {
			wrapped(...args);
		};
	}

	// ── BRL ──────────────────────────────────────────────────────────────────

	/**
	 * Encola una entrada del registro del día y avisa. El texto de la nota NO se
	 * toca: el BRL vive en Lumbre, igual que las tareas.
	 */
	private async sendBrlEntry(text: string, kind: BrlKind): Promise<void> {
		const operation = brlCreateOp(text, kind);
		if (operation === null) {
			this.log.warn('Entrada del BRL vacía, no se encola');
			new Notice('La entrada necesita un texto.');
			return;
		}
		// El TEXTO no se apunta: es lo que el usuario ha escrito. Solo el tipo y
		// cuánto ocupa, que es lo que hace falta para seguir el rastro.
		this.log.info('Acción del usuario', { action: 'anotar en el BRL', kind, length: text.length });

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
			this.log.error('Lumbre rechazó la entrada del BRL', { id: queued.id, error: after.error });
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
			this.log.warn('No se pega el BRL: la lectura falló', { error: read.error });
			new Notice(read.error ?? 'No se pudo leer el BRL de hoy.');
			return;
		}
		if (read.markdown.trim().length === 0) {
			this.log.info('El registro de hoy está vacío, no se pega nada');
			new Notice('El registro de hoy está vacío.');
			return;
		}
		editor.replaceSelection(read.markdown.trimEnd().concat('\n'));
		this.log.info('BRL de hoy pegado en la nota', { chars: read.markdown.length });
		new Notice('BRL de hoy insertado en la nota');
	}

	// ── La foto semanal ──────────────────────────────────────────────────────

	/**
	 * Compone la foto semanal. Es la mitad de LEER de la revisión: texto de solo
	 * lectura, sin estadística y sin estado nuevo. Lo llaman el comando y la API
	 * pública (`api.weeklySnapshot()`), y por eso vive aquí y no en cada uno.
	 */
	private weeklySnapshot(options?: WeeklySnapshotOptions): ReturnType<typeof collectWeeklySnapshot> {
		const deps: WeeklySnapshotDeps = {
			client: this.client,
			// El intervalo entre las peticiones por lista. `window.setTimeout` y no
			// `setInterval` registrado: es una espera de una vez, no un latido.
			wait: (ms: number) =>
				new Promise<void>((done) => {
					window.setTimeout(done, ms);
				}),
			logger: this.logger.child('main'),
		};
		return collectWeeklySnapshot(deps, options ?? {});
	}

	/**
	 * Pega la foto semanal en el cursor. Foto FIJA, igual que la del BRL: desde
	 * que se pega, el texto es del usuario y el plugin no vuelve a tocarlo.
	 *
	 * Con los TRES apartados en rojo no se pega nada, por lo mismo que el BRL: lo
	 * que quedaría en la nota serían tres líneas de error, y eso no es una foto de
	 * la semana. Con uno o dos sí se pega: la línea dice cuál falló, así que el
	 * texto no miente sobre lo que no se pudo leer.
	 */
	private async insertWeeklySnapshot(editor: Editor): Promise<void> {
		new Notice('Componiendo la foto semanal…');
		const snapshot = await this.weeklySnapshot();

		if (snapshot.failures === snapshot.sections) {
			this.log.warn('No se pega la foto semanal: no se ha podido leer nada', {
				sections: snapshot.sections,
			});
			new Notice('No se ha podido leer nada de Lumbre; no se pega nada.');
			return;
		}

		editor.replaceSelection(snapshot.markdown);
		this.log.info('Foto semanal pegada en la nota', {
			chars: snapshot.markdown.length,
			failures: snapshot.failures,
		});
		new Notice(
			snapshot.failures === 0
				? 'Foto semanal insertada'
				: `Foto semanal insertada, con ${snapshot.failures} ${
						snapshot.failures === 1 ? 'apartado' : 'apartados'
					} sin leer`,
		);
	}

	// ── Soplo ────────────────────────────────────────────────────────────────

	/**
	 * Abre el preview de Soplo sobre un texto. La IA propone y el usuario
	 * confirma: aquí no se aplica nada, solo se pregunta.
	 */
	private openSoploModal(file: TFile | null, source: string): void {
		const text = source.trim();
		if (text.length === 0) {
			this.log.info('Soplo sin texto que mandar');
			new Notice('Selecciona un texto, o pon el cursor en un párrafo.');
			return;
		}

		const truncated = text.length > MAX_AGENT_PROMPT_LENGTH;
		const prompt = truncated ? text.slice(0, MAX_AGENT_PROMPT_LENGTH) : text;
		// El texto que se manda a Soplo es contenido de la nota: se apunta cuánto
		// ocupa y si hubo que recortarlo, nunca qué dice.
		this.logger.child('modal').info('Soplo abierto', {
			notePath: file?.path ?? null,
			length: prompt.length,
			truncated,
		});

		new SoploModal(this.app, {
			text: prompt,
			truncated,
			consent: (): Promise<AgentConsentState> => this.client.agentConsent(),
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
		this.logger.child('modal').info('Plan de Soplo aplicado', {
			notePath: file?.path ?? null,
			proposed: plan.plan.length,
			checked: checked.filter((flag) => flag).length,
			ops: ops.length,
			creates: createdTaskIds.length,
			skipped,
		});
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
			this.log.error('Lumbre rechazó parte del plan', { id: operation.id, error: after.error });
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
		const panel = this.logger.child('panel');
		const size = checkUploadSize(file.stat.size);
		if (!size.ok) {
			panel.warn('Adjunto rechazado por tamaño', { taskId: task.id, bytes: file.stat.size });
			new Notice(size.message);
			return;
		}

		panel.info('Acción del usuario', {
			action: 'adjuntar fichero',
			taskId: task.id,
			bytes: file.stat.size,
			extension: file.extension,
		});
		new Notice(`Subiendo ${file.name} (${formatBytes(file.stat.size)})…`);
		const bytes = await this.app.vault.readBinary(file);
		const result = await this.client.uploadAttachment(
			task.id,
			file.name,
			mimeForExtension(file.extension),
			bytes,
		);

		if (result.ok) {
			panel.info('Adjunto subido', { taskId: task.id, attachmentId: result.value.id });
			new Notice(`${file.name} adjuntado a «${task.content}»`);
			// El recuento de adjuntos sale de la tarea, así que hay que releerla.
			for (const notePath of this.links.notesForTask(task.id)) {
				await this.links.refresh(notePath, this.client);
			}
			this.notifyDataChange();
			return;
		}

		panel.error('No se pudo subir el adjunto', {
			taskId: task.id,
			reason: result.reason,
			status: result.status,
		});

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
		this.logger.child('panel').info('Panel de tareas abierto');
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
		this.logger.child('modal').info('Acción del usuario', {
			action: 'enviar como tarea',
			notePath: target.notePath,
			listId: draft.listId ?? null,
			subtasks: draft.subtasks?.length ?? 0,
		});
		// El título lo escribe el usuario: solo en `debug` y recortado a 80.
		if (this.logger.enabled('debug')) {
			this.logger.child('modal').debug('Tarea enviada', { title: shortTitle(draft.title) });
		}
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
			this.log.error('Lumbre rechazó la tarea', { id: operation.id, error: after.error });
			new Notice(after.error ?? 'Lumbre rechazó la tarea.');
		}
		if (file !== null && navigator.onLine) await this.links.refresh(file.path, this.client);
		this.notifyDataChange();
	}

	/** Escribe `lumbre-list` en la nota. Es la ÚNICA escritura del plugin en el vault. */
	private async linkNoteToList(file: TFile): Promise<void> {
		const lists = await this.lists.get();
		if (lists.length === 0) {
			this.log.warn('No hay listas que enseñar para vincular la nota');
			new Notice('No se han podido leer las listas de Lumbre.');
			return;
		}
		new ListSuggestModal(this.app, lists, (list) => {
			void writeNoteListId(this.app, file, list.id).then(() => {
				this.logger.child('vault').info('Nota vinculada a una lista', {
					notePath: file.path,
					listId: list.id,
				});
				new Notice(`Nota vinculada a la lista ${list.name}`);
				this.notifyDataChange();
			});
		}).open();
	}

	private async unlinkNoteFromList(file: TFile): Promise<void> {
		await writeNoteListId(this.app, file, null);
		this.logger.child('vault').info('Quitado el vínculo de la nota con su lista', {
			notePath: file.path,
			property: NOTE_LIST_PROPERTY,
		});
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
			logger: this.logger.child('block'),
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
			logger: this.logger.child('block'),
		};
	}

	/**
	 * Completa o reabre desde un bloque. Encola, drena y solo avisa con un Notice
	 * si Lumbre RECHAZÓ la operación: un refresco normal no interrumpe a nadie.
	 */
	private async setTaskDone(task: LumbreTask, done: boolean, notePath: string): Promise<void> {
		const file = notePath.length === 0 ? null : this.app.vault.getFileByPath(notePath);
		this.logger.child('block').info('Acción del usuario', {
			action: done ? 'completar tarea' : 'reabrir tarea',
			taskId: task.id,
			notePath,
		});
		const operation = await this.queue.enqueueStatus(task.id, done, {
			notePath,
			label: file?.basename ?? 'Sin nota',
			excerpt: null,
		});
		this.notifyDataChange();

		await this.queue.flush();
		const after = this.queue.pending().find((candidate) => candidate.id === operation.id);
		if (after?.state === 'rejected') {
			this.log.error('Lumbre rechazó la operación', { id: operation.id, error: after.error });
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
			logger: this.logger.child('panel'),
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
