import { Notice, Plugin, PluginSettingTab, Setting, type App } from 'obsidian';

import { describeFailure, type LumbreClient } from './lumbre/client';
import type { TokenStore } from './token-store';

export interface LumbreSettings {
	/** Origen de la API de Lumbre, normalizado (esquema + host + puerto, sin ruta). */
	apiOrigin: string;
}

export const DEFAULT_SETTINGS: LumbreSettings = {
	apiOrigin: 'https://app.lumbre.pro',
};

/**
 * Lo que la pestaña de ajustes necesita del plugin. Se declara aquí como
 * interfaz para no importar `main.ts` y crear un ciclo entre los dos módulos.
 */
export interface LumbreSettingsHost {
	/**
	 * Se llama `config` y no `settings` porque Obsidian 1.13 añadió su propia
	 * `Plugin.settings` y este plugin declara minAppVersion 1.11.4: usar ese
	 * nombre aquí sería pisar una API que en la versión mínima no existe.
	 */
	config: LumbreSettings;
	saveSettings(): Promise<void>;
	tokenStore: TokenStore;
	/** Construye un cliente con el origen y el token que hay AHORA mismo. */
	createClient(): LumbreClient;
}

/**
 * Normaliza una URL escrita a mano a su origen. Devuelve `null` si no es una
 * URL válida, y el llamador decide qué hacer con ello.
 */
export function normalizeOrigin(raw: string): string | null {
	try {
		return new URL(raw.trim()).origin;
	} catch {
		return null;
	}
}

export class LumbreSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly host: Plugin & LumbreSettingsHost,
	) {
		super(app, host);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Origen de Lumbre')
			.setDesc('Dirección del servidor, sin ruta. Por defecto, https://app.lumbre.pro')
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.apiOrigin)
					.setValue(this.host.config.apiOrigin)
					.onChange(async (value) => {
						const origin = normalizeOrigin(value);
						if (origin === null) {
							new Notice('Esa dirección no es válida, no se ha guardado.');
							return;
						}
						this.host.config.apiOrigin = origin;
						await this.host.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Token personal')
			.setDesc('Token de acceso a Lumbre. Se guarda en el plugin y no se muestra en ningún sitio.')
			.addText((text) => {
				text.inputEl.type = 'password';
				text.setPlaceholder('Pega aquí tu token');
				void this.host.tokenStore.get().then((token) => {
					if (token !== null) text.setValue(token);
				});
				text.onChange(async (value) => {
					const trimmed = value.trim();
					await this.host.tokenStore.set(trimmed.length > 0 ? trimmed : null);
				});
			});

		new Setting(containerEl)
			.setName('Probar conexión')
			.setDesc('Pide una tarea a Lumbre para comprobar el origen y el token.')
			.addButton((button) =>
				button.setButtonText('Probar conexión').onClick(async () => {
					button.setDisabled(true);
					button.setButtonText('Probando…');
					try {
						const result = await this.host.createClient().ping();
						new Notice(
							result.ok ? 'Conectado a Lumbre' : describeFailure(result.reason, result.status),
						);
					} finally {
						button.setDisabled(false);
						button.setButtonText('Probar conexión');
					}
				}),
			);
	}
}
