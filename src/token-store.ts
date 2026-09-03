/**
 * Dónde vive el token personal de Lumbre.
 *
 * El token NUNCA se escribe en logs, en Notices, en frontmatter ni en el
 * Markdown del vault: solo se lee para construir la cabecera Authorization.
 */
export interface TokenStore {
	get(): Promise<string | null>;
	set(token: string | null): Promise<void>;
}

/** Lo que el store necesita del plugin: leer y escribir su data.json. */
export interface PluginDataHost {
	loadData(): Promise<unknown>;
	saveData(data: unknown): Promise<void>;
}

/**
 * PROVISIONAL. data.json viaja por Obsidian Sync; la decisión de dónde vive el
 * token (fichero fuera del vault o safeStorage de Electron) está abierta en la
 * lista lumbre-obsidian de Lumbre, tarea "Decidir: dónde se guarda el token".
 * Cambiar de almacén es cambiar esta implementación, no sus consumidores.
 */
export class PluginDataTokenStore implements TokenStore {
	constructor(private readonly host: PluginDataHost) {}

	async get(): Promise<string | null> {
		const data = await this.readData();
		const token = data['token'];
		return typeof token === 'string' && token.length > 0 ? token : null;
	}

	async set(token: string | null): Promise<void> {
		const data = await this.readData();
		if (token === null || token.length === 0) {
			delete data['token'];
		} else {
			data['token'] = token;
		}
		await this.host.saveData(data);
	}

	private async readData(): Promise<Record<string, unknown>> {
		const raw = await this.host.loadData();
		return raw !== null && typeof raw === 'object' ? { ...(raw as Record<string, unknown>) } : {};
	}
}
