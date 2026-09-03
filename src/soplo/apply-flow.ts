/**
 * Qué le queda al modal de Soplo cuando termina de aplicar.
 *
 * Existe porque `apply` puede LANZAR (la cola escribe en `data.json`, y eso
 * falla), y sin recoger esa excepción el modal se quedaba en «Aplicando…» con
 * los dos botones deshabilitados para siempre: ni se aplica, ni se reintenta, ni
 * se cancela. Lo único que quedaba era el Esc.
 *
 * Módulo puro: no importa `obsidian`, así que el camino de fallo se puede probar
 * sin montar un modal.
 */

import { describeError } from '../diagnostics/errors';

export interface ApplyOutcome {
	/** `applied` cierra el modal; `error` lo deja abierto con su mensaje. */
	state: 'applied' | 'error';
	/** El fallo ya descrito (sin el token, que `describeError` no lo saca). */
	error: string | null;
	/**
	 * Qué tiene que hacer el botón de reintentar. Tras un fallo al APLICAR se
	 * vuelve a aplicar, no se vuelve a preguntar a Soplo: el plan ya está
	 * aprobado y volver a preguntar mandaría el texto de la nota otra vez.
	 */
	retry: 'apply' | null;
}

/** Aplica y devuelve el desenlace. Nunca lanza. */
export async function runApply(apply: () => Promise<void>): Promise<ApplyOutcome> {
	try {
		await apply();
		return { state: 'applied', error: null, retry: null };
	} catch (error) {
		return { state: 'error', error: describeError(error).message, retry: 'apply' };
	}
}
