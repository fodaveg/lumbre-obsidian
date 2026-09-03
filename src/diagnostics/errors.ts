/**
 * Un error cualquiera a algo que se puede apuntar en el registro.
 *
 * Lo que llega a un `catch` en un plugin de Obsidian puede ser un `Error`, un
 * objeto de la API, una cadena o cualquier otra cosa. Aquí sale siempre con la
 * misma forma, y el STACK solo cuando se pide: en el uso normal ocupa medio
 * informe y no dice nada que el mensaje no diga.
 *
 * Módulo puro: no importa `obsidian` y no hace red.
 */

export interface DescribedError {
	name: string;
	message: string;
	/** Status HTTP, cuando lo que falló era una petición. */
	status?: number;
	/**
	 * Motivo ya clasificado, cuando lo que se cazó lo traía. Es un `FailureReason`
	 * del cliente cuando viene de una petición, pero se declara como texto: aquí
	 * llega lo que sea que estuviera en el `catch`, no solo lo nuestro.
	 */
	reason?: string;
	/** Solo con `withStack`, o sea solo en nivel `debug`. */
	stack?: string;
}

/**
 * Describe lo que sea que se haya cazado. `withStack` lo pone el llamador a
 * partir del nivel del logger: en `debug` va el stack, en el resto no.
 */
export function describeError(error: unknown, withStack = false): DescribedError {
	if (error instanceof Error) {
		const described: DescribedError = { name: error.name, message: error.message };
		const extra = asRow(error);
		const status = extra?.['status'];
		if (typeof status === 'number') described.status = status;
		const reason = extra?.['reason'];
		if (typeof reason === 'string') described.reason = reason;
		if (withStack && typeof error.stack === 'string') described.stack = error.stack;
		return described;
	}

	const row = asRow(error);
	if (row !== null) {
		const message = row['message'];
		const described: DescribedError = {
			name: typeof row['name'] === 'string' ? row['name'] : 'Object',
			message: typeof message === 'string' ? message : safeText(error),
		};
		if (typeof row['status'] === 'number') described.status = row['status'];
		if (typeof row['reason'] === 'string') described.reason = row['reason'];
		return described;
	}

	return { name: typeof error, message: safeText(error) };
}

/** El stack de lo cazado, o `undefined`. Lo usa el filtro de errores no gestionados. */
export function stackOf(error: unknown): string | undefined {
	if (error instanceof Error && typeof error.stack === 'string') return error.stack;
	const row = asRow(error);
	const stack = row?.['stack'];
	return typeof stack === 'string' ? stack : undefined;
}

function asRow(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/** El valor como texto, sin que un `toString` roto tumbe el registro. */
function safeText(value: unknown): string {
	try {
		return String(value);
	} catch {
		return '[valor no legible]';
	}
}
