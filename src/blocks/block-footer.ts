/**
 * Los avisos del pie de un bloque. Módulo puro: ni `obsidian` ni red.
 *
 * Vive aparte porque el pie es lo único que el usuario lee cuando algo va mal, y
 * decía siempre lo mismo: «Sin conexión, mostrando la última lectura», también
 * con un token caducado o con un 500 del servidor. El motivo real ya venía en el
 * snapshot (`describeFailure`) y se tiraba, así que la única pista de un token
 * que ha dejado de valer era ir a los ajustes a probar la conexión.
 */

import { isPartialRead, MAX_TASKS_LIMIT } from '../lumbre/client';

/**
 * El aviso de que lo que se enseña es la ÚLTIMA lectura buena, con el motivo de
 * verdad delante. `error` viene ya en castellano y sin el token.
 */
export function staleNote(error: string): string {
	return `${error} Se enseña la última lectura.`;
}

/**
 * El aviso de que la lectura pudo quedarse corta por el tope del servidor, o
 * `null` si no llegó a él. Se dice cuántas tareas se leyeron: sin ese número,
 * «parcial» no le dice a nadie qué recortar.
 */
export function partialNote(count: number): string | null {
	return isPartialRead(count)
		? `Resultados parciales (${MAX_TASKS_LIMIT} tareas leídas)`
		: null;
}
