/**
 * Limpieza de lo que se va a registrar.
 *
 * Regla del plugin: el token NUNCA entra en un log, ni en un informe, ni en un
 * Notice. Aquí se cumple en el único sitio por el que pasa todo lo que se
 * apunta, en vez de confiar en que cada llamador se acuerde.
 *
 * Tres cosas hace `redact`:
 *
 * - Sustituye cualquier aparición de un secreto (el token, y lo que se le pase
 *   en `secrets`) por `«token»`, dentro de un texto, de una clave o de un valor
 *   anidado.
 * - Tapa el VALOR de cualquier clave prohibida (`Authorization` y compañía) sin
 *   mirar lo que lleva dentro: una cabecera de autenticación no se registra
 *   aunque el token todavía no esté en `secrets`.
 * - Recorta las cadenas a 200 caracteres, para que un evento no se lleve por
 *   delante media nota.
 *
 * Módulo puro: no importa `obsidian` y no hace red.
 */

/** Con lo que se sustituye un secreto. */
export const REDACTED = '«token»';

/** Tope de caracteres de una cadena ya limpia, contando el marcador de corte. */
export const MAX_STRING_LENGTH = 200;

/** Profundidad máxima que se recorre. Más abajo se resume como `[…]`. */
const MAX_DEPTH = 6;

/** Tope de elementos de un array. Lo que sobra se cuenta, no se pinta. */
const MAX_ARRAY_LENGTH = 50;

/**
 * Un secreto más corto que esto no se busca: sustituir una cadena de dos o tres
 * letras dejaría el registro ilegible sin tapar nada que importe.
 */
const MIN_SECRET_LENGTH = 6;

/**
 * Palabras que, si TERMINAN el nombre de una clave, tapan su valor entero: se
 * llame como se llame el secreto que lleve dentro. La comparación es sin
 * mayúsculas ni guiones, así que `x-lumbre-token` y `accessToken` casan igual.
 */
const FORBIDDEN_KEY_ENDINGS: readonly string[] = [
	'authorization',
	'token',
	'apikey',
	'bearer',
	'password',
	'secret',
];

/**
 * El valor listo para registrar. `secrets` son las cadenas que hay que tapar,
 * hoy el token personal; las vacías o muy cortas se ignoran.
 */
export function redact(value: unknown, secrets: readonly string[] = []): unknown {
	const needles = secrets.filter((secret) => secret.length >= MIN_SECRET_LENGTH);
	return clean(value, needles, 0, new Set());
}

/** Como `redact`, pero para un texto suelto (un mensaje de evento). */
export function redactText(value: string, secrets: readonly string[] = []): string {
	const cleaned = redact(value, secrets);
	return typeof cleaned === 'string' ? cleaned : '';
}

/**
 * Solo la sustitución de secretos, SIN recortar. Es lo que necesita el informe,
 * que es un texto largo a propósito y que no se puede cortar a 200 caracteres.
 */
export function stripSecrets(value: string, secrets: readonly string[] = []): string {
	let out = value;
	for (const secret of secrets) {
		if (secret.length < MIN_SECRET_LENGTH) continue;
		out = out.split(secret).join(REDACTED);
	}
	return out;
}

/** `true` si esa clave tapa su valor entero. */
export function isForbiddenKey(key: string): boolean {
	const normalized = normalizeKey(key);
	return FORBIDDEN_KEY_ENDINGS.some((ending) => normalized.endsWith(ending));
}

function normalizeKey(key: string): string {
	return key.toLowerCase().replace(/[\s_-]/g, '');
}

function clean(
	value: unknown,
	secrets: readonly string[],
	depth: number,
	seen: Set<object>,
): unknown {
	if (value === null || value === undefined) return null;

	switch (typeof value) {
		case 'string':
			return cleanString(value, secrets);
		case 'number':
			return Number.isFinite(value) ? value : String(value);
		case 'boolean':
			return value;
		case 'bigint':
			return String(value);
		case 'function':
			return '[función]';
		case 'symbol':
			return String(value);
		default:
			break;
	}

	// Aquí ya solo queda un objeto: los primitivos salieron por el switch.
	const object = value;
	// Una referencia circular no se recorre dos veces: un evento con un ciclo
	// dentro colgaría el registro, que es justo lo que no puede pasar.
	if (seen.has(object)) return '[circular]';
	if (depth >= MAX_DEPTH) return '[…]';
	seen.add(object);

	try {
		if (value instanceof Date) return value.toISOString();
		if (value instanceof Error) {
			return {
				name: cleanString(value.name, secrets),
				message: cleanString(value.message, secrets),
			};
		}
		if (Array.isArray(value)) {
			const items = value
				.slice(0, MAX_ARRAY_LENGTH)
				.map((item) => clean(item, secrets, depth + 1, seen));
			if (value.length > MAX_ARRAY_LENGTH) {
				items.push(`[+${value.length - MAX_ARRAY_LENGTH} más]`);
			}
			return items;
		}
		return cleanObject(value as Record<string, unknown>, secrets, depth, seen);
	} finally {
		seen.delete(object);
	}
}

function cleanObject(
	row: Record<string, unknown>,
	secrets: readonly string[],
	depth: number,
	seen: Set<object>,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(row)) {
		const safeKey = cleanString(key, secrets);
		// La clave prohibida se queda, con su valor tapado: saber que iba una
		// cabecera `Authorization` es útil; su contenido no se registra jamás.
		out[safeKey] = isForbiddenKey(key) ? REDACTED : clean(item, secrets, depth + 1, seen);
	}
	return out;
}

function cleanString(value: string, secrets: readonly string[]): string {
	let out = value;
	for (const secret of secrets) out = out.split(secret).join(REDACTED);
	if (out.length <= MAX_STRING_LENGTH) return out;
	return `${out.slice(0, MAX_STRING_LENGTH - 1)}…`;
}
