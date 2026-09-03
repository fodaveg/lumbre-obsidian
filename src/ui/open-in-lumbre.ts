/**
 * Abrir una tarea en Lumbre desde el vault. UN solo sitio donde se decide.
 *
 * La app nativa de Lumbre existe SOLO en macOS, y `lumbre://` no lo atiende
 * nadie en Windows ni en Linux: ahí `window.open` de ese esquema no hace nada,
 * en silencio y sin error, y el usuario se queda sin ninguna forma de llegar a
 * la tarea. Por eso la regla es al revés de como parecía: la web es el camino
 * por defecto en TODAS partes, y el esquema nativo es la excepción de macOS,
 * con la web de repliegue si tampoco ahí se pudo abrir.
 *
 * El repliegue no es exacto: `window.open` de un esquema externo puede devolver
 * `null` aunque el sistema SÍ vaya a abrir la app, y entonces se abren las dos.
 * Es el error que se prefiere: abrir de más se ve y se cierra, no abrir nada no
 * se ve.
 */

import { Platform } from 'obsidian';

/** Abre una URL. En el plugin es `window.open`, que devuelve `null` si no pudo. */
export type UrlOpener = (url: string) => unknown;

/** Las dos formas de abrir una tarea, tal y como las devuelve `taskDeepLinks`. */
export interface TaskLinks {
	native: string;
	web: string;
}

/** `window.open` de la ventana en la que corre el plugin. */
function windowOpen(url: string): unknown {
	return window.open(url);
}

/**
 * Abre la tarea por donde se pueda. El `open` entra por inyección para poder
 * probar el repliegue sin una ventana de verdad.
 */
export function openTaskInLumbre(links: TaskLinks, open: UrlOpener = windowOpen): void {
	if (Platform.isMacOS && Platform.isDesktopApp) {
		const opened = open(links.native);
		if (opened !== null) return;
	}
	open(links.web);
}
