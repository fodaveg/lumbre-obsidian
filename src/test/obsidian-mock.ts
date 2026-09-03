/**
 * Mock del módulo `obsidian` para Vitest, recortado a lo que usa este plugin.
 * El alias lo monta vitest.config.mts.
 */

export class Plugin {}
export class PluginSettingTab {}
export class Notice {}
export class Setting {}

export async function requestUrl(): Promise<{ status: number }> {
	return { status: 200 };
}
