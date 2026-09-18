/**
 * «Registrar hábito»: apunta la ocurrencia de HOY de un hábito por su
 * nombre.
 *
 * MATIZ QUE RECORTA LA FUNCIÓN, medido: el plugin no puede resolver un
 * nombre a un id real de hábito (ver `habit-name.ts`), así que lo que
 * escribe el usuario viaja TAL CUAL como `habitId` de `registerHabit`. Es la
 * misma superficie mínima que ya expone la API (`MutationOp`, `client.ts`);
 * si el texto no casa con ningún hábito de la cuenta, Lumbre lo rechazará o
 * lo dejará sin aplicar, y la cola NUNCA lo da por bueno sin más: `check:
 * 'none'` no relee nada (no hay ninguna lectura de hábitos con un token
 * personal), así que solo el `outcome` de la propia respuesta
 * (`applied`/`noop`) materializa la operación; `queued` (o su ausencia)
 * aparca la operación para reintento A MANO (`parkUnverifiable` en
 * `queue.ts`), nunca la reenvía sola: reenviar apuntaría la ocurrencia dos
 * veces.
 *
 * Módulo puro: no importa `obsidian`.
 */

import type { LinkTarget, MutationQueuedOperation, OperationQueue } from '../lumbre/queue';
import { normalizeHabitName } from './habit-name';

export interface RegisterHabitDeps {
	queue: Pick<OperationQueue, 'enqueueMutation'>;
}

export type RegisterHabitOutcome =
	| { ok: false; reason: 'empty-name' }
	| { ok: true; operation: MutationQueuedOperation };

/** `YYYY-MM-DD` LOCAL: el mismo formato que pide `registerHabit`. */
export function todayDate(now: Date): string {
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function pad(value: number): string {
	return String(value).padStart(2, '0');
}

/**
 * Encola el registro. NO drena: el llamador (`main.ts`) decide cuándo
 * drenar y qué avisar según el estado tras el flush, igual que el resto de
 * comandos de la cola.
 */
export async function registerHabit(
	deps: RegisterHabitDeps,
	rawName: string,
	date: string,
	target: LinkTarget,
): Promise<RegisterHabitOutcome> {
	const name = normalizeHabitName(rawName);
	if (name === null) return { ok: false, reason: 'empty-name' };

	const operation = await deps.queue.enqueueMutation(
		{ op: 'registerHabit', habitId: name, date },
		{ check: 'none' },
		target,
	);
	return { ok: true, operation };
}
