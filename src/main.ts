import { Plugin, requestUrl } from 'obsidian';

import { LumbreClient } from './lumbre/client';
import {
	DEFAULT_SETTINGS,
	LumbreSettingTab,
	type LumbreSettings,
	type LumbreSettingsHost,
} from './settings';
import { PluginDataTokenStore, type TokenStore } from './token-store';

export default class LumbrePlugin extends Plugin implements LumbreSettingsHost {
	/** Ver el comentario de `LumbreSettingsHost.config`: el nombre evita `Plugin.settings` de 1.13. */
	config: LumbreSettings = { ...DEFAULT_SETTINGS };

	tokenStore: TokenStore = new PluginDataTokenStore(this);

	/**
	 * API pública del plugin, alcanzable desde Dataview y js-engine como
	 * `app.plugins.plugins.lumbre.api`. Vacía en esta base: aquí irán las
	 * funciones que las notas puedan llamar para consultar Lumbre.
	 */
	api: Record<string, never> = {};

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new LumbreSettingTab(this.app, this));
	}

	/**
	 * Construye un cliente con el origen guardado en ese momento. Se crea uno por
	 * llamada a propósito: así cambiar el origen en los ajustes no deja un cliente
	 * viejo apuntando al servidor anterior.
	 */
	createClient(): LumbreClient {
		return new LumbreClient({
			apiOrigin: this.config.apiOrigin,
			getToken: () => this.tokenStore.get(),
			request: (init) => requestUrl(init),
		});
	}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<LumbreSettings> | null;
		this.config = { ...DEFAULT_SETTINGS, ...(data ?? {}) };
	}

	/**
	 * Escribe los ajustes preservando el resto de data.json, que es donde el
	 * TokenStore provisional guarda el token: un saveData con solo los ajustes
	 * lo borraría.
	 */
	async saveSettings(): Promise<void> {
		const current = (await this.loadData()) as Record<string, unknown> | null;
		await this.saveData({ ...(current ?? {}), ...this.config });
	}
}
