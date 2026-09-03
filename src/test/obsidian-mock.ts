/**
 * Mock del módulo `obsidian` para Vitest, recortado a lo que usa este plugin.
 * El alias lo monta vitest.config.mts.
 *
 * Aquí solo hay lo justo para que un módulo que importe `obsidian` se pueda
 * cargar: la interfaz de Obsidian no se prueba, se prueban los módulos puros de
 * `src/ui/`, que no la importan. La excepción es `Plugin`, que sí se construye
 * en `main.test.ts` para comprobar que la DESCARGA aguanta una carga fallida.
 */

/** Lo mínimo de `Component` para que las piezas que registran listeners carguen. */
export class Component {
	load(): void {
		// Sin DOM real no hay nada que cargar.
	}
	unload(): void {
		// Ni que descargar.
	}
	registerDomEvent(): void {
		// En los tests no hay elementos a los que engancharse.
	}
	register(): void {
		// Ni limpiezas que apuntar.
	}
}

export class Plugin extends Component {
	constructor(
		public app: unknown = {},
		public manifest: { id: string; version: string } = { id: 'lumbre', version: '0.0.0-test' },
	) {
		super();
	}

	async loadData(): Promise<unknown> {
		return Promise.resolve(null);
	}

	async saveData(_data: unknown): Promise<void> {
		await Promise.resolve();
	}

	addSettingTab(): void {
		// La pestaña de ajustes no se pinta en los tests.
	}
}

export class PluginSettingTab {}
export class Notice {}
export class Setting {}
export class Modal {}
export class SuggestModal {}
export class ItemView {}
export class MarkdownRenderChild extends Component {}

export const MarkdownRenderer = {
	async render(): Promise<void> {
		await Promise.resolve();
	},
};

/** La versión de Obsidian que dice estar corriendo. */
export const apiVersion = '1.11.4';

/**
 * En los tests no hay app de escritorio ni móvil: todo a `false`. Es un objeto
 * mutable a propósito, para que un test pueda ponerse en la plataforma que
 * quiera probar (ver `open-in-lumbre.test.ts`).
 */
export const Platform = {
	isDesktop: false,
	isDesktopApp: false,
	isMacOS: false,
	isMobile: false,
};

export function setIcon(): void {
	// Sin DOM real no hay icono que pintar.
}

export function normalizePath(path: string): string {
	return path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

export async function requestUrl(): Promise<{ status: number }> {
	return { status: 200 };
}
