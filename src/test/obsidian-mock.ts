/**
 * Mock del módulo `obsidian` para Vitest, recortado a lo que usa este plugin.
 * El alias lo monta vitest.config.mts.
 *
 * Aquí solo hay lo justo para que un módulo que importe `obsidian` se pueda
 * cargar: la interfaz de Obsidian no se prueba, se prueban los módulos puros de
 * `src/ui/`, que no la importan.
 */

export class Plugin {}
export class PluginSettingTab {}
export class Notice {}
export class Setting {}
export class Modal {}
export class SuggestModal {}
export class ItemView {}
export class Component {}

/** En los tests no hay app de escritorio ni móvil: todo a `false`. */
export const Platform = {
	isDesktop: false,
	isDesktopApp: false,
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
