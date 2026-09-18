/**
 * Enrutado de `obsidian://lumbre/…`, para poder disparar el plugin desde
 * Atajos de iOS sin pasar por la paleta de comandos.
 *
 * `registerObsidianProtocolHandler` no admite comodines: cada ruta se registra
 * como una acción EXACTA. Hay dos:
 *
 * - `lumbre/send` (`obsidian://lumbre/send?title=…`): abre el modal de enviar
 *   con el título ya puesto.
 * - `lumbre/open` (`obsidian://lumbre/open`): abre el panel de tareas.
 *
 * `main.ts` registra ADEMÁS la acción `lumbre` a secas, sin sufijo: es la ruta
 * de un Atajo viejo o mal escrito que llame directo a `obsidian://lumbre`. Las
 * tres pasan por `routeForAction`, así que la de aquí abajo sí es alcanzable:
 * cae en `unknown` y `main.ts` la apunta y la ignora, nunca lanza.
 *
 * EL TÍTULO QUE LLEGA POR LA URL ES TEXTO EXTERNO, tecleado en un Atajo fuera
 * de Obsidian: `parseSendTitle` lo recorta a `MAX_TITLE_LENGTH` (el mismo tope
 * del modal de enviar, `ui/draft-from-editor.ts`) ANTES de que llegue a
 * ninguna parte. Apuntarlo al registro es cosa de `main.ts`, que ya sabe
 * hacerlo bien: solo en `debug` y recortado a 80 con `shortTitle`
 * (`diagnostics/logger.ts`), igual que el título de cualquier tarea.
 *
 * Módulo puro: no importa `obsidian`. Los parámetros llegan como
 * `Record<string, string>`, la forma mínima de `ObsidianProtocolData` sin la
 * clave `action` (que ya se sabe por qué handler se está llamando).
 */

import { collapseWhitespace, MAX_TITLE_LENGTH, truncate } from '../ui/draft-from-editor';

export type ProtocolParams = Record<string, string>;

export type ProtocolRoute =
	| { kind: 'send'; title: string }
	| { kind: 'open' }
	| { kind: 'unknown'; action: string };

/**
 * El título de `?title=…`, listo para el campo del modal: sin espacios de
 * sobra, de una sola línea y recortado al tope. Ausente o vacío da cadena
 * vacía, nunca `null`: el modal se abre igual, solo que sin nada escrito.
 */
export function parseSendTitle(params: ProtocolParams): string {
	const raw = params['title'] ?? '';
	return truncate(collapseWhitespace(raw), MAX_TITLE_LENGTH);
}

/** A qué ruta corresponde una acción de Obsidian ya registrada por `main.ts`. */
export function routeForAction(action: string, params: ProtocolParams): ProtocolRoute {
	switch (action) {
		case 'lumbre/send':
			return { kind: 'send', title: parseSendTitle(params) };
		case 'lumbre/open':
			return { kind: 'open' };
		default:
			return { kind: 'unknown', action };
	}
}
