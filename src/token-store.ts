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

/**
 * Lo que el store necesita del almacén del plugin. Lo cumple `PluginStore`, que
 * es quien escribe `data.json` entero.
 */
export interface TokenHost {
	readToken(): string | null;
	writeToken(token: string | null): Promise<void>;
}

/**
 * PROVISIONAL. data.json viaja por Obsidian Sync; la decisión de dónde vive el
 * token (fichero fuera del vault o safeStorage de Electron) está abierta en la
 * lista lumbre-obsidian de Lumbre, tarea "Decidir: dónde se guarda el token".
 * Cambiar de almacén es cambiar esta implementación, no sus consumidores.
 */
export class PluginDataTokenStore implements TokenStore {
	constructor(private readonly host: TokenHost) {}

	get(): Promise<string | null> {
		const token = this.host.readToken();
		return Promise.resolve(token !== null && token.length > 0 ? token : null);
	}

	async set(token: string | null): Promise<void> {
		await this.host.writeToken(token !== null && token.length > 0 ? token : null);
	}
}
