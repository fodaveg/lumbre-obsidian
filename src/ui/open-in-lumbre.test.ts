import { Platform } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { taskDeepLinks } from '../lumbre/types';
import { openTaskInLumbre } from './open-in-lumbre';

const LINKS = taskDeepLinks({ id: 'task-1' }, 'https://app.lumbre.pro');

/** Pone la plataforma que se quiera probar sobre el mock de `obsidian`. */
function onPlatform(flags: { isDesktopApp: boolean; isMacOS: boolean; isMobile: boolean }): void {
	Object.assign(Platform, flags);
}

afterEach(() => {
	onPlatform({ isDesktopApp: false, isMacOS: false, isMobile: false });
});

describe('openTaskInLumbre', () => {
	it('en el escritorio de Windows o Linux abre la WEB', () => {
		onPlatform({ isDesktopApp: true, isMacOS: false, isMobile: false });
		const open = vi.fn(() => ({}));

		openTaskInLumbre(LINKS, open);

		// `lumbre://` no lo atiende nadie fuera de macOS: sería un no-op mudo.
		expect(open).toHaveBeenCalledTimes(1);
		expect(open).toHaveBeenCalledWith(LINKS.web);
	});

	it('en macOS intenta la app nativa', () => {
		onPlatform({ isDesktopApp: true, isMacOS: true, isMobile: false });
		const open = vi.fn(() => ({}));

		openTaskInLumbre(LINKS, open);

		expect(open).toHaveBeenCalledTimes(1);
		expect(open).toHaveBeenCalledWith(LINKS.native);
	});

	it('en macOS sin la app instalada se repliega a la web', () => {
		onPlatform({ isDesktopApp: true, isMacOS: true, isMobile: false });
		const open = vi.fn(() => null);

		openTaskInLumbre(LINKS, open);

		expect(open).toHaveBeenNthCalledWith(1, LINKS.native);
		expect(open).toHaveBeenNthCalledWith(2, LINKS.web);
	});

	it('en móvil abre la web, que es lo único que hay', () => {
		onPlatform({ isDesktopApp: false, isMacOS: false, isMobile: true });
		const open = vi.fn(() => ({}));

		openTaskInLumbre(LINKS, open);

		expect(open).toHaveBeenCalledWith(LINKS.web);
	});
});
