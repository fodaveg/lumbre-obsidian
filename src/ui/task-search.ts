/**
 * La búsqueda de tareas del panel: UNA lectura y el filtro por texto en cliente.
 *
 * Vive fuera de la vista porque lo que hay que poder comprobar es lo que se le
 * PIDE al servidor. `GET /api/tasks` sirve 200 tareas por defecto, así que la
 * búsqueda miraba las 200 primeras y el registro apuntaba ese `scanned` como si
 * hubiera mirado todo el vault de tareas. Ahora se pide el tope (500) y, si la
 * respuesta llega justo a él, se dice que la lectura puede estar recortada.
 *
 * No importa `obsidian`: recibe el cliente por inyección.
 */

import { isPartialRead, MAX_TASKS_LIMIT, type LumbreClient, type LumbreResult } from '../lumbre/client';
import type { LumbreTask } from '../lumbre/types';
import { filterTasks } from './search-filter';

export interface TaskSearchOutcome {
	/** Las que casan con el texto, ya recortadas al tope de filas del panel. */
	tasks: LumbreTask[];
	/** Cuántas tareas se leyeron de Lumbre. Es lo que se apunta en el registro. */
	scanned: number;
	/** La lectura llegó al tope del servidor: puede faltar lo que no cupo. */
	partial: boolean;
}

/**
 * Busca por texto entre las tareas abiertas. El fallo de la lectura sale TAL
 * CUAL, para que el panel lo cuente con su motivo en vez de enseñar cero
 * resultados, que se leería como «no hay ninguna».
 */
export async function searchTasks(
	client: Pick<LumbreClient, 'listTasks'>,
	text: string,
	max: number,
): Promise<LumbreResult<TaskSearchOutcome>> {
	const read = await client.listTasks({
		scope: 'all',
		includeDone: false,
		notes: 'none',
		limit: MAX_TASKS_LIMIT,
	});
	if (!read.ok) return read;

	return {
		ok: true,
		value: {
			tasks: filterTasks(read.value, text).slice(0, max),
			scanned: read.value.length,
			partial: isPartialRead(read.value.length),
		},
	};
}
