/**
 * Cliente HTTP mínimo contra la API de Lumbre.
 *
 * Este módulo NO importa `obsidian` a propósito: recibe la función de red por
 * inyección (`request`), y es `main.ts` quien le pasa `requestUrl`. Así el
 * cliente se puede probar con Vitest sin cargar la API de Obsidian.
 */

/** Motivo por el que una llamada no ha salido bien, ya traducido a algo mostrable. */
export type FailureReason = 'no_token' | 'unauthorized' | 'network' | 'server';

export type PingResult = { ok: true } | { ok: false; reason: FailureReason; status?: number };

/** Subconjunto de las opciones de `requestUrl` que usa este cliente. */
export interface LumbreRequestInit {
	url: string;
	method: string;
	headers: Record<string, string>;
	/** Con `false`, un status de error vuelve como respuesta en vez de como excepción. */
	throw: false;
}

/** Subconjunto de la respuesta de `requestUrl` que usa este cliente. */
export interface LumbreResponse {
	status: number;
}

export type LumbreRequestFn = (init: LumbreRequestInit) => Promise<LumbreResponse>;

export interface LumbreClientOptions {
	/** Origen de la API, por ejemplo `https://app.lumbre.pro`. Sin ruta. */
	apiOrigin: string;
	/** Devuelve el token personal, o `null` si todavía no hay ninguno guardado. */
	getToken: () => Promise<string | null>;
	request: LumbreRequestFn;
}

export class LumbreClient {
	constructor(private readonly options: LumbreClientOptions) {}

	/**
	 * Comprueba que el origen y el token valen: pide una tarea y descarta el cuerpo.
	 * Nunca lanza; todo fallo sale como `{ ok: false, reason }`.
	 */
	async ping(): Promise<PingResult> {
		const token = await this.options.getToken();
		if (!token) return { ok: false, reason: 'no_token' };

		let response: LumbreResponse;
		try {
			response = await this.options.request({
				url: `${trimTrailingSlashes(this.options.apiOrigin)}/api/tasks?limit=1&notes=none`,
				method: 'GET',
				headers: { Authorization: `Bearer ${token}` },
				throw: false,
			});
		} catch {
			// El error de red se traga a propósito: puede llevar la URL y no aporta
			// nada que el usuario pueda accionar más allá de "no se pudo conectar".
			return { ok: false, reason: 'network' };
		}

		return classifyStatus(response.status);
	}
}

function trimTrailingSlashes(origin: string): string {
	return origin.replace(/\/+$/, '');
}

/**
 * Traduce el status HTTP a un motivo. El conjunto de motivos es cerrado, así que
 * cualquier respuesta que no sea 2xx ni 401/403 (un 404 de una ruta que no
 * existe, por ejemplo) cae en `server`, que es donde el usuario mira el status.
 */
function classifyStatus(status: number): PingResult {
	if (status >= 200 && status < 300) return { ok: true };
	if (status === 401 || status === 403) return { ok: false, reason: 'unauthorized', status };
	return { ok: false, reason: 'server', status };
}

/** Texto en castellano para cada motivo de fallo, listo para un Notice. */
export function describeFailure(reason: FailureReason, status?: number): string {
	switch (reason) {
		case 'no_token':
			return 'Falta el token personal.';
		case 'unauthorized':
			return 'El token no vale o ha caducado.';
		case 'network':
			return 'No se pudo conectar con Lumbre.';
		case 'server':
			return status === undefined
				? 'Lumbre respondió con un error.'
				: `Lumbre respondió con un error (${status}).`;
	}
}
