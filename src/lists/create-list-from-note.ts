/**
 * «Crear lista en Lumbre con el nombre de esta nota y vincularla».
 *
 * Crea la lista (`op: 'createList'`, id fijado AQUÍ con `crypto.randomUUID()`,
 * igual que un `clientTaskId`) y espera su confirmación ANTES de vincular:
 * vincular una lista que Lumbre todavía no ha aceptado dejaría un `POST
 * /api/list-links` apuntando a un id que el servidor no conoce. La
 * confirmación llega normalmente SIN relectura: `/api/mutations` drena en la
 * misma petición (ver el JSDoc de `MutationCheck` en `queue.ts`), así que el
 * `outcome` de la propia respuesta (`applied`, o `noop` si ya existía una
 * lista con ese id) ya materializa la operación dentro del mismo `flush()`.
 *
 * Vincular de verdad (escribir `lumbre-list` en la nota y encolar el
 * `listLink`) sigue siendo cosa de `main.ts` (`applyListLink`, que ya sabe
 * sustituir una lista anterior): este módulo solo decide el nombre y crea la
 * lista, sin tocar el vault ni la caché de listas.
 *
 * Módulo puro: no importa `obsidian`.
 */

import type { LinkTarget, MutationCheck, OperationQueue } from '../lumbre/queue';

export interface CreateListDeps {
	queue: Pick<OperationQueue, 'enqueueMutation' | 'flush' | 'snapshot'>;
}

export type CreateListOutcome =
	/**
	 * La nota ya tenía `lumbre-list`. Este comando NO crea una lista de más ni
	 * sustituye la que hay: eso es una decisión de "vincular a otra lista", que
	 * ya tiene su propio comando (`link-note-to-list`).
	 */
	| { ok: false; reason: 'already-linked' }
	/**
	 * Lumbre aceptó el envío pero no lo ha confirmado dentro de este
	 * `flush()` (rechazado, o todavía sin confirmar). `error` es el motivo del
	 * servidor, si lo hay.
	 */
	| { ok: false; reason: 'not-confirmed'; error: string | null }
	| { ok: true; listId: string; name: string };

/**
 * El nombre que se manda: el NOMBRE LITERAL de la nota (`basename`, sin
 * extensión), con su prefijo Johnny.Decimal si lo lleva.
 *
 * Decisión: el comando se llama «...con el nombre de esta nota», así que se
 * manda el nombre tal cual lo ve el usuario en el explorador, sin adivinar
 * qué parte es "el número" y qué parte es "el título". El filtro `list` de
 * `GET /api/tasks` ya ignora ese prefijo al comparar (medido en el repo de
 * Lumbre), así que quitarlo aquí no gana nada para buscar tareas y sí pierde
 * la trazabilidad con el nombre real de la nota que originó la lista.
 */
export function listNameFromNote(basename: string): string {
	return basename;
}

/**
 * Crea la lista y, si se confirma dentro de este `flush()`, devuelve su id.
 * `existingListId` es lo que ya tenga la nota en `lumbre-list` (ver
 * `readNoteListId` en `links/note-list.ts`): con algo ahí, no se crea nada.
 */
export async function createListFromNote(
	deps: CreateListDeps,
	basename: string,
	existingListId: string | null,
	target: LinkTarget,
): Promise<CreateListOutcome> {
	if (existingListId !== null) return { ok: false, reason: 'already-linked' };

	const listId = crypto.randomUUID();
	const name = listNameFromNote(basename);
	const check: MutationCheck = { check: 'listExists', listId };
	const operation = await deps.queue.enqueueMutation({ op: 'createList', listId, name }, check, target);

	await deps.queue.flush();
	const after = deps.queue.snapshot().find((candidate) => candidate.id === operation.id);
	if (after?.state === 'materialized') return { ok: true, listId, name };
	return { ok: false, reason: 'not-confirmed', error: after?.error ?? null };
}
