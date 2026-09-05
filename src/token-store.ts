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
 * DECIDIDO (5 sep 2026): el token vive en data.json en TODAS las plataformas.
 * data.json viaja por Obsidian Sync y un dispositivo comprometido lo expone; se
 * acepta porque en móvil no hay safeStorage ni fichero fuera del vault, así que
 * cualquier otra vía acababa igual en cuanto el usuario tuviera un móvil. La
 * mitigación es regenerar el token en Lumbre. Cambiar de almacén (por ejemplo
 * al emparejamiento por dispositivo, hoy parado) es cambiar esta implementación,
 * no sus consumidores.
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
