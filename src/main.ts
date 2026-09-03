import { Plugin, requestUrl, type TAbstractFile } from 'obsidian';

import { LinkStore } from './links/link-store';
import { LumbreClient } from './lumbre/client';
import { OperationQueue } from './lumbre/queue';
import { taskDeepLinks } from './lumbre/types';
import {
	DEFAULT_SETTINGS,
	LumbreSettingTab,
	type LumbreSettings,
	type LumbreSettingsHost,
} from './settings';
import { PluginStore, type DeviceIdStore } from './storage/plugin-store';
import { PluginDataTokenStore, type TokenStore } from './token-store';

/** Clave del id de dispositivo en el almacenamiento LOCAL de Obsidian. */
const DEVICE_ID_KEY = 'lumbre:device-id';

/**
 * Superficie que el plugin expone a otras piezas del vault. **Todavía no es la
 * API pública**: la superficie que verán Dataview y js-engine se fija en el lote
 * de la API, y hasta entonces esto puede cambiar de forma sin aviso.
 */
export interface LumbreApi {
	client: LumbreClient;
	queue: OperationQueue;
	links: LinkStore;
	taskDeepLinks: typeof taskDeepLinks;
}

export default class LumbrePlugin extends Plugin implements LumbreSettingsHost {
	/** Ver el comentario de `LumbreSettingsHost.config`: el nombre evita `Plugin.settings` de 1.13. */
	config: LumbreSettings = { ...DEFAULT_SETTINGS };

	store!: PluginStore;
	tokenStore!: TokenStore;
	client!: LumbreClient;
	queue!: OperationQueue;
	links!: LinkStore;

	/**
	 * API del plugin, alcanzable como `app.plugins.plugins.lumbre.api`. La
	 * superficie PÚBLICA (la que se promete a Dataview y js-engine, y que ya no se
	 * puede romper) se fija en el lote de la API: hasta entonces esto es lo que
	 * hay montado, no un contrato.
	 */
	api!: LumbreApi;

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
		this.queue = new OperationQueue({ client: this.client, storage: this.store });
		this.links = new LinkStore({ storage: this.store });
		this.api = {
			client: this.client,
			queue: this.queue,
			links: this.links,
			taskDeepLinks,
		};

		this.addSettingTab(new LumbreSettingTab(this.app, this));

		// La nota se identifica por RUTA, así que un renombrado hay que seguirlo o
		// el enlace se pierde. Vale igual para carpetas: `renamePath` casa el
		// prefijo.
		this.registerEvent(
			this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
				void this.links.renamePath(oldPath, file.path);
			}),
		);
		this.registerEvent(
			this.app.vault.on('delete', (file: TAbstractFile) => {
				void this.links.markDeleted(file.path);
			}),
		);

		// Al volver la red hay que drenar lo que se encoló sin conexión.
		this.registerDomEvent(window, 'online', () => {
			void this.flushIfConnected();
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

	/** Drena la cola, pero solo si hay token: sin él no hay nada que intentar. */
	private async flushIfConnected(): Promise<void> {
		const token = await this.tokenStore.get();
		if (token === null) return;
		await this.queue.flush();
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
