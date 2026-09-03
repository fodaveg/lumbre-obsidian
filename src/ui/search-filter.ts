/**
 * Filtro del buscador del panel.
 *
 * Módulo puro: no importa `obsidian` y no hace red. El buscador pide las tareas
 * a Lumbre UNA vez (`listTasks`) y filtra aquí, en cliente: la API no tiene
 * búsqueda por texto y encadenar peticiones por cada tecla gastaría el límite
 * de 120 llamadas por minuto sin comprar nada.
 */

/** Lo que hace falta de una tarea para filtrarla. Lo cumple `LumbreTask`. */
export interface SearchableTask {
	content: string;
	list: { name: string } | null;
}

/**
 * Minúsculas y sin tildes: "Camión" y "camion" son la misma búsqueda. La eñe se
 * pliega a `n` por el mismo camino (`NFD` la parte en `n` + tilde), y se acepta:
 * en un buscador escribir "manana" y encontrar "mañana" es lo que se espera.
 */
export function normalizeForSearch(text: string): string {
	return text
		.normalize('NFD')
		.replace(/\p{Diacritic}/gu, '')
		.toLowerCase()
		.trim();
}

/**
 * Tareas que casan con el texto. Si el texto es el nombre EXACTO de una lista
 * (ya normalizado), se devuelven las tareas de esa lista; si no, las que llevan
 * el texto en el título. Una consulta vacía devuelve todo.
 */
export function filterTasks<T extends SearchableTask>(tasks: readonly T[], query: string): T[] {
	const needle = normalizeForSearch(query);
	if (needle.length === 0) return [...tasks];

	const byList = tasks.filter(
		(task) => task.list !== null && normalizeForSearch(task.list.name) === needle,
	);
	if (byList.length > 0) return byList;

	return tasks.filter((task) => normalizeForSearch(task.content).includes(needle));
}
