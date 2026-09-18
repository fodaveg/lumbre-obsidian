/**
 * El nombre de un hábito tal y como lo escribe el usuario, para «Registrar
 * hábito» y para la lista de nombres guardados en Ajustes.
 *
 * El plugin no puede LISTAR los hábitos de la cuenta: no salen en ningún
 * endpoint que acepte un token personal (`GET /api/tasks` es la tabla de
 * tareas del CRDT y no los trae; `/api/today` y `/api/upcoming`, que sí
 * calculan sus ocurrencias, dan 401 con un token personal y solo aceptan la
 * cookie de sesión). Así que aquí no hay nada que resolver contra un
 * catálogo, solo limpiar lo que se ha escrito.
 *
 * Módulo puro: no importa `obsidian`.
 */

/** El nombre recortado, o `null` si queda vacío tras quitar espacios de los extremos. */
export function normalizeHabitName(raw: string): string | null {
	const trimmed = raw.trim();
	return trimmed.length > 0 ? trimmed : null;
}
