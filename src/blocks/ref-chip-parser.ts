/**
 * Parseo de la referencia a tarea o lista que Lumbre copia al portapapeles.
 *
 * La app copia `[[task:ID|Etiqueta]]` (o `[[list:ID|Etiqueta]]`, la etiqueta
 * es opcional al leer, ver `src/lib/task-reference.ts` y `REF_TOKEN` en
 * `src/lib/markdown.ts` del repo de Lumbre). Obsidian no conoce esa sintaxis:
 * la pinta como un enlace interno SIN RESOLVER, `a.internal-link.is-unresolved`
 * con `data-href` igual al prefijo más el id (`task:ID` / `list:ID`).
 *
 * Módulo puro: no importa `obsidian`.
 */

/** El id se valida contra el mismo formato que exige el servidor
 *  (`GET /api/tasks?ids=`, `UUID_RE` en `validation.ts` del repo de Lumbre):
 *  un id que NO case nunca se manda a Lumbre, porque un solo id inválido en
 *  el lote tira la petición ENTERA con 400 y se perderían también las
 *  referencias válidas del mismo render. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TASK_PREFIX = 'task:';
const LIST_PREFIX = 'list:';

export type RefKind = 'task' | 'list';

export interface ParsedRef {
	kind: RefKind;
	id: string;
	/** `true` si `id` tiene forma de UUID. Solo entonces se pide a Lumbre. */
	validId: boolean;
}

/** `null` si `href` no es una referencia de Lumbre (cualquier otro enlace). */
export function parseRefHref(href: string): ParsedRef | null {
	if (href.startsWith(TASK_PREFIX)) {
		const id = href.slice(TASK_PREFIX.length);
		return { kind: 'task', id, validId: UUID_RE.test(id) };
	}
	if (href.startsWith(LIST_PREFIX)) {
		const id = href.slice(LIST_PREFIX.length);
		return { kind: 'list', id, validId: UUID_RE.test(id) };
	}
	return null;
}

/**
 * Ids de TAREA únicos y con forma válida, en el orden en que aparecen, listos
 * para UNA sola lectura en lote (`GET /api/tasks?ids=`). Ni la variante de
 * lista (fuera de este paso, ver `ref-chip-postprocessor.ts`) ni los ids
 * inválidos entran aquí: esos enlaces se quedan con su texto de referencia
 * sin más, pero su clic sigue funcionando (el clic no necesita esta lista).
 */
export function uniqueTaskIds(refs: readonly ParsedRef[]): string[] {
	const seen = new Set<string>();
	const ids: string[] = [];
	for (const ref of refs) {
		if (ref.kind !== 'task' || !ref.validId) continue;
		if (seen.has(ref.id)) continue;
		seen.add(ref.id);
		ids.push(ref.id);
	}
	return ids;
}
