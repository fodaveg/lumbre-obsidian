/**
 * «Guardar esta nota como notas de la lista»: el gemelo de «Guardar esta
 * nota en la tarea» para la lista vinculada por `lumbre-list`.
 *
 * La COMPOSICIÓN del texto (cabecera, unión con lo existente, recorte al
 * tope de Lumbre) es exactamente la misma tenga delante una tarea o una
 * lista, así que se reutiliza ENTERO `src/notes/note-snapshot.ts`: este
 * módulo no repite nada de eso, solo decide el payload de `setListNotes` y
 * cómo se manda.
 *
 * Lo que NO es reutilizable es `queue.enqueueNotes`: está atado a `taskId` y
 * a `client.getTask` (ver su JSDoc en `queue.ts`). Aquí va por
 * `enqueueMutation` con la op `setListNotes` y el check `listNotes`.
 *
 * Módulo puro: no importa `obsidian`.
 */

import type { MutationOp } from '../lumbre/client';
import type { LinkTarget, OperationQueue } from '../lumbre/queue';

export interface ListNotesDeps {
	queue: Pick<OperationQueue, 'enqueueMutation' | 'flush' | 'snapshot'>;
}

/**
 * El cuerpo de `setListNotes`, con el `revive` que le corresponde.
 *
 * `revive: true` SOLO cuando se escribe contenido: es la única vía para
 * volver a encender una nota que se había borrado antes (ver el JSDoc de
 * `setListNotes` en `client.ts`: sin él, una nota apagada sigue leyéndose
 * `null` por mucho texto nuevo que se mande). Una foto siempre escribe
 * contenido, así que este flujo lo pide siempre que `notes` no esté vacío.
 * Al borrar (`notes: null` o cadena vacía, que este comando no usa hoy pero
 * `MutationOp` sí permite) no hace falta forzarlo: no hay tombstone que
 * limpiar sobre algo que se está apagando.
 */
export function setListNotesOp(listId: string, notes: string | null): MutationOp {
	const hasContent = notes !== null && notes.trim().length > 0;
	return { op: 'setListNotes', listId, notes, ...(hasContent ? { revive: true } : {}) };
}

export interface ListNotesOutcome {
	/** `true` si Lumbre rechazó la operación dentro de este `flush()`. */
	rejected: boolean;
	error: string | null;
}

/**
 * Encola la foto por la cola durable y drena. `header` es la cabecera de
 * ESTA foto (`snapshotHeader` de `note-snapshot.ts`): es lo que confirma la
 * relectura, igual que el `kind` `notes` de una tarea confirma por la
 * cabecera dentro de `notes`.
 */
export async function saveListNotesSnapshot(
	deps: ListNotesDeps,
	listId: string,
	notes: string,
	header: string,
	target: LinkTarget,
): Promise<ListNotesOutcome> {
	const operation = await deps.queue.enqueueMutation(
		setListNotesOp(listId, notes),
		{ check: 'listNotes', listId, header },
		target,
	);

	await deps.queue.flush();
	const after = deps.queue.snapshot().find((candidate) => candidate.id === operation.id);
	return { rejected: after?.state === 'rejected', error: after?.error ?? null };
}
