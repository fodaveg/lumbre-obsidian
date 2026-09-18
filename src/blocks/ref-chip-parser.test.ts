import { describe, expect, it } from 'vitest';

import { parseRefHref, uniqueTaskIds, type ParsedRef } from './ref-chip-parser';

const VALID_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';

describe('parseRefHref', () => {
	it('reconoce una referencia de tarea con etiqueta de título', () => {
		// `[[task:ID|Comprar pan]]`: Obsidian pinta `data-href` con SOLO el
		// target ("task:ID"); la etiqueta queda en el TEXTO del enlace, algo
		// ajeno a este parseo (confirmado contra `src/lib/markdown.ts` del repo
		// de Lumbre, `REF_TOKEN`).
		expect(parseRefHref(`task:${VALID_ID}`)).toEqual<ParsedRef>({
			kind: 'task',
			id: VALID_ID,
			validId: true,
		});
	});

	it('reconoce la misma referencia SIN etiqueta de título', () => {
		// `[[task:ID]]` sin `|Etiqueta` (la etiqueta es opcional al leer, ver
		// `taskReferenceId` en `src/lib/task-reference.ts`): Obsidian pinta el
		// MISMO `data-href`, solo cambia el texto visible del enlace (el propio
		// target). El parseo no distingue los dos casos, y no tiene por qué.
		expect(parseRefHref(`task:${VALID_ID}`)).toEqual<ParsedRef>({
			kind: 'task',
			id: VALID_ID,
			validId: true,
		});
	});

	it('reconoce la variante de lista', () => {
		expect(parseRefHref(`list:${VALID_ID}`)).toEqual<ParsedRef>({
			kind: 'list',
			id: VALID_ID,
			validId: true,
		});
	});

	it('marca un id sin forma de uuid como inválido, sin descartar la referencia', () => {
		// Inválido no es lo mismo que "no es una referencia": el enlace se
		// reconoce igual (el clic sigue funcionando), simplemente no se pide a
		// Lumbre con ese id.
		expect(parseRefHref('task:no-es-un-uuid')).toEqual<ParsedRef>({
			kind: 'task',
			id: 'no-es-un-uuid',
			validId: false,
		});
	});

	it('devuelve null para un enlace que no es una referencia de Lumbre', () => {
		expect(parseRefHref('Otra nota')).toBeNull();
		expect(parseRefHref('tasks:algo')).toBeNull(); // prefijo parecido, no exacto
		expect(parseRefHref('')).toBeNull();
	});
});

describe('uniqueTaskIds', () => {
	function ref(overrides: Partial<ParsedRef> = {}): ParsedRef {
		return { kind: 'task', id: VALID_ID, validId: true, ...overrides };
	}

	it('dedupa ids repetidos y conserva el orden de aparición', () => {
		const refs = [ref({ id: VALID_ID }), ref({ id: OTHER_ID }), ref({ id: VALID_ID })];
		expect(uniqueTaskIds(refs)).toEqual([VALID_ID, OTHER_ID]);
	});

	it('descarta la variante de lista: fuera de este paso', () => {
		expect(uniqueTaskIds([ref({ kind: 'list' })])).toEqual([]);
	});

	it('descarta ids sin forma de uuid: nunca se piden a Lumbre', () => {
		expect(uniqueTaskIds([ref({ validId: false })])).toEqual([]);
	});

	it('con más de 200 referencias en el mismo render, conserva TODOS los ids únicos', () => {
		// El tope de 200 de `GET /api/tasks?ids=` lo trocea `getTasksByIds` en el
		// cliente (ver `MAX_IDS_PER_REQUEST` en `lumbre/client.ts`); a este nivel
		// solo hace falta juntar los ids de UN render en una lista, sin recortar.
		const many = Array.from({ length: 250 }, (_, i) => ref({ id: `id-${i}` }));
		expect(uniqueTaskIds(many)).toHaveLength(250);
	});
});
