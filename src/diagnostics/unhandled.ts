/**
 * Errores que se escapan: los de un callback del plugin y los que caen en la
 * ventana sin que nadie los recoja.
 *
 * `guarded` envuelve lo que el plugin REGISTRA en Obsidian (comandos,
 * procesadores de bloque, eventos del vault y del workspace, botones). Sin él,
 * una excepción dentro de un handler se pierde en la consola de Obsidian con un
 * stack de `plugin:lumbre` y sin ningún contexto: ni qué comando era, ni con qué
 * nota. Con él queda un evento `error` con su módulo y su acción, y el error NO
 * se relanza, porque relanzarlo desde un handler de Obsidian no lo arregla, solo
 * se lleva por delante lo que viniera detrás.
 *
 * La firma es `guarded(logger, accion, fn)` y no `guarded(modulo, fn)`: el
 * módulo ya viaja dentro del logger (`logger.child('main')`), y lo que de verdad
 * falta al leer el registro es QUÉ se estaba haciendo.
 *
 * Módulo puro: no importa `obsidian`. Los oyentes de `window` los engancha
 * `main.ts` con `registerDomEvent`, que es quien sabe darlos de baja.
 */

import { describeError, stackOf } from './errors';
import type { Logger } from './logger';

/**
 * Marca que Obsidian pone en el stack de lo que corre dentro de un plugin. Es
 * lo único que permite distinguir un error NUESTRO de uno de otro plugin.
 */
export const PLUGIN_STACK_MARK = 'plugin:lumbre';

/**
 * Envuelve un callback para que su excepción quede registrada con contexto.
 *
 * Vale para funciones que devuelven una promesa: si la promesa se rompe, el
 * fallo se apunta igual y la promesa devuelta NO queda rechazada, para no
 * generar además un `unhandledrejection` por lo mismo.
 */
export function guarded<Args extends unknown[], Result>(
	logger: Logger,
	action: string,
	fn: (...args: Args) => Result,
): (...args: Args) => Result | undefined {
	return (...args: Args): Result | undefined => {
		try {
			const result = fn(...args);
			if (isPromise(result)) {
				const caught = result.catch((error: unknown) => {
					report(logger, action, error, true);
					return undefined;
				});
				return caught as Result;
			}
			return result;
		} catch (error) {
			report(logger, action, error, false);
			return undefined;
		}
	};
}

/**
 * `true` si el stack viene de este plugin. Cuando no hay stack, o no lleva la
 * marca, solo se registra en `debug`: la consola de Obsidian es de todos, y
 * apuntar los errores de otros plugins como si fueran nuestros llenaría el
 * informe de pistas falsas.
 */
export function isFromPlugin(stack: string | undefined): boolean {
	return stack !== undefined && stack.includes(PLUGIN_STACK_MARK);
}

/** Lo que hay que apuntar de un error no gestionado, o `null` si no toca. */
export function unhandledEvent(
	error: unknown,
	options: { asynchronous: boolean; debug: boolean; source?: string },
): { message: string; data: Record<string, unknown> } | null {
	const stack = stackOf(error);
	const ours = isFromPlugin(stack);
	// En `debug` se apunta todo: si el fallo no trae stack, esa es justo la
	// única forma de verlo.
	if (!ours && !options.debug) return null;

	const data: Record<string, unknown> = {
		...describeError(error, options.debug),
		fromPlugin: ours,
	};
	if (options.source !== undefined) data['source'] = options.source;

	return {
		message: options.asynchronous
			? 'Promesa rechazada sin recoger'
			: 'Error no gestionado en la ventana',
		data,
	};
}

function report(logger: Logger, action: string, error: unknown, asynchronous: boolean): void {
	logger.error('Fallo dentro de un callback del plugin', {
		action,
		asynchronous,
		...describeError(error, logger.enabled('debug')),
	});
}

function isPromise(value: unknown): value is Promise<unknown> {
	return (
		value !== null &&
		typeof value === 'object' &&
		typeof (value as { then?: unknown }).then === 'function' &&
		typeof (value as { catch?: unknown }).catch === 'function'
	);
}
