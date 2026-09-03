import { Notice, Plugin, PluginSettingTab, Setting, type App } from 'obsidian';

import {
	DEFAULT_LOG_LEVEL,
	LOG_LEVEL_LABELS,
	LOG_LEVELS,
	type LogLevel,
	type Logger,
} from './diagnostics/logger';
import { describeFailure, type LumbreClient } from './lumbre/client';
import type { TokenStore } from './token-store';

export interface LumbreSettings {
	/** Origen de la API de Lumbre, normalizado (esquema + host + puerto, sin ruta). */
	apiOrigin: string;
	/**
	 * Nivel del registro que llega a la CONSOLA. El buffer en memoria se llena
	 * igual con todo, así que subir esto solo cambia lo que se ve en vivo.
	 */
	logLevel: LogLevel;
	/**
	 * Escribir además cada `warn` y cada `error` en un fichero del vault. Apagado
	 * por defecto: solo hace falta para cazar el fallo que ocurre cuando no estás
	 * delante.
	 */
	liveLog: boolean;
}

export const DEFAULT_SETTINGS: LumbreSettings = {
	apiOrigin: 'https://app.lumbre.pro',
	logLevel: DEFAULT_LOG_LEVEL,
	liveLog: false,
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
	/** Registro de diagnóstico del plugin. La pestaña se etiqueta sola. */
	logger: Logger;
	/** Aplica el nivel del registro y lo guarda. */
	setLogLevel(level: LogLevel): Promise<void>;
	/** Enciende o apaga el registro en fichero y lo guarda. */
	setLiveLog(enabled: boolean): Promise<void>;
	/** El informe de diagnóstico en texto plano, listo para pegar. */
	buildReport(): string;
	/** Guarda el informe en el vault y devuelve la ruta escrita. */
	saveReport(): Promise<string>;
	/** Dos líneas de estado: conexión y cola. Se leen al abrir la pestaña. */
	statusLines(): string[];
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
	/** El registro de esta pestaña, etiquetado como `settings`. */
	private readonly log: Logger;

	constructor(
		app: App,
		private readonly host: Plugin & LumbreSettingsHost,
	) {
		super(app, host);
		this.log = host.logger.child('settings');
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
							this.log.warn('Origen escrito no válido, no se guarda');
							return;
						}
						this.host.config.apiOrigin = origin;
						await this.host.saveSettings();
						// El origen SÍ se apunta: es una dirección de servidor, no un secreto,
						// y apuntar contra qué se está hablando es media diagnosis.
						this.log.info('Origen de la API cambiado', { origin });
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
					// Del token solo se apunta que ha cambiado. Nunca su valor, ni su
					// longitud, ni un trozo: de ahí no sale nada que sirva a nadie.
					this.log.info(
						trimmed.length > 0 ? 'Token cambiado' : 'Token borrado',
					);
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
						this.log.info('Prueba de conexión', {
							ok: result.ok,
							...(result.ok ? {} : { reason: result.reason, status: result.status }),
						});
						new Notice(
							result.ok ? 'Conectado a Lumbre' : describeFailure(result.reason, result.status),
						);
					} finally {
						button.setDisabled(false);
						button.setButtonText('Probar conexión');
					}
				}),
			);

		this.renderDiagnostics(containerEl);
	}

	/**
	 * La sección de diagnóstico: el nivel del registro, los dos botones que
	 * sacan el informe (al portapapeles y al vault), el interruptor del registro
	 * en fichero y un resumen de estado de dos líneas.
	 *
	 * El resumen se calcula al ABRIR la pestaña y no se refresca solo: un panel
	 * que se repinta cada segundo dentro de los ajustes es ruido, y para verlo al
	 * día está el comando «Mostrar diagnóstico».
	 */
	private renderDiagnostics(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Diagnóstico').setHeading();

		const status = containerEl.createDiv({ cls: 'lumbre-settings__status' });
		status.setAttribute('aria-live', 'polite');
		for (const line of this.host.statusLines()) status.createDiv({ text: line });

		new Setting(containerEl)
			.setName('Nivel del registro')
			.setDesc(
				'Lo que se escribe en la consola. El registro que se copia guarda siempre los últimos 1000 eventos, con independencia de esto.',
			)
			.addDropdown((dropdown) => {
				for (const level of LOG_LEVELS) dropdown.addOption(level, LOG_LEVEL_LABELS[level]);
				dropdown.setValue(this.host.config.logLevel);
				dropdown.onChange(async (value) => {
					const level = LOG_LEVELS.find((candidate) => candidate === value);
					if (level === undefined) return;
					await this.host.setLogLevel(level);
				});
			});

		new Setting(containerEl)
			.setName('Copiar registro')
			.setDesc('Copia el informe al portapapeles, sin el token ni el texto de tus notas.')
			.addButton((button) =>
				button.setButtonText('Copiar registro').onClick(async () => {
					// Se apunta ANTES de componerlo: así la línea sale dentro del propio
					// informe y se ve desde dónde se pidió.
					this.log.info('Acción del usuario', { action: 'copiar el registro' });
					try {
						await navigator.clipboard.writeText(this.host.buildReport());
						new Notice('Registro copiado');
					} catch {
						// En móvil el portapapeles puede estar denegado. Ahí queda el otro botón.
						this.log.warn('El portapapeles denegó la copia del registro');
						new Notice('No se pudo copiar; prueba a guardarlo en el vault.');
					}
				}),
			);

		new Setting(containerEl)
			.setName('Guardar registro en el vault')
			.setDesc('Escribe el informe en la carpeta del plugin. Se conservan los 10 últimos.')
			.addButton((button) =>
				button.setButtonText('Guardar registro').onClick(async () => {
					try {
						const path = await this.host.saveReport();
						new Notice(`Registro guardado en ${path}`);
					} catch {
						this.log.error('No se pudo escribir el registro en el vault');
						new Notice('No se pudo escribir el registro en el vault.');
					}
				}),
			);

		new Setting(containerEl)
			.setName('Registrar también en fichero en vivo')
			.setDesc(
				'Añade cada aviso y cada error a un fichero según pasan, para cazar fallos que ocurren cuando no estás mirando. Rota al llegar a 1 MB.',
			)
			.addToggle((toggle) =>
				toggle.setValue(this.host.config.liveLog).onChange(async (value) => {
					await this.host.setLiveLog(value);
				}),
			);
	}
}
