import { describe, expect, it } from 'vitest';

import {
	CONTEXT_SUBTASK_TASK_CAP,
	contextStateLabel,
	noteExcerpt,
	subtaskGlyph,
	subtaskItems,
	TASK_CONTEXT_NOTE_MAX_CHARS,
	TASK_CONTEXT_NOTE_MAX_LINES,
} from './task-context';

describe('noteExcerpt', () => {
	it('sin notas, no hay extracto', () => {
		expect(noteExcerpt(null)).toBeNull();
	});

	it('unas notas en blanco tampoco pintan nada', () => {
		expect(noteExcerpt('   \n  ')).toBeNull();
	});

	it('un texto corto sale entero, sin puntos suspensivos', () => {
		expect(noteExcerpt('Llamar antes de las 10')).toBe('Llamar antes de las 10');
	});

	it('recorta por caracteres y avisa con «…»', () => {
		const long = 'a'.repeat(TASK_CONTEXT_NOTE_MAX_CHARS + 50);
		const excerpt = noteExcerpt(long);
		expect(excerpt).toHaveLength(TASK_CONTEXT_NOTE_MAX_CHARS + 1);
		expect(excerpt?.endsWith('…')).toBe(true);
	});

	it('recorta por PUNTOS DE CÓDIGO: un emoji justo en el borde no se parte', () => {
		// `'😀'` es un par sustituto: 2 unidades UTF-16, 1 punto de código. Puesto
		// justo en la posición del corte, un `String.slice` crudo se llevaría solo
		// la primera mitad (un carácter inválido) y dejaría la segunda suelta.
		const emoji = '😀';
		const long = 'a'.repeat(TASK_CONTEXT_NOTE_MAX_CHARS - 1) + emoji + 'b'.repeat(10);
		const excerpt = noteExcerpt(long);

		expect(excerpt).toBe('a'.repeat(TASK_CONTEXT_NOTE_MAX_CHARS - 1) + emoji + '…');
		// Ningún punto de código roto: el emoji entero sigue siendo UN elemento.
		expect(Array.from(excerpt ?? '')).toHaveLength(TASK_CONTEXT_NOTE_MAX_CHARS + 1);
	});

	it('recorta por líneas aunque cada línea sea corta', () => {
		const lines = Array.from({ length: TASK_CONTEXT_NOTE_MAX_LINES + 2 }, (_, i) => `Línea ${i}`);
		const excerpt = noteExcerpt(lines.join('\n'));
		expect(excerpt?.split('\n')).toHaveLength(TASK_CONTEXT_NOTE_MAX_LINES);
		expect(excerpt?.endsWith('…')).toBe(true);
	});

	it('exactamente en el tope de líneas no recorta', () => {
		const lines = Array.from({ length: TASK_CONTEXT_NOTE_MAX_LINES }, (_, i) => `Línea ${i}`);
		const excerpt = noteExcerpt(lines.join('\n'));
		expect(excerpt?.endsWith('…')).toBe(false);
	});
});

describe('contextStateLabel', () => {
	function task(overrides: { done?: boolean; cancelledAt?: string | null; archivedAt?: string | null }) {
		return { done: false, cancelledAt: null, archivedAt: null, ...overrides };
	}

	it('una pendiente no lleva chip: sería ruido', () => {
		expect(contextStateLabel(task({}))).toBeNull();
	});

	it('una completada dice Completada', () => {
		expect(contextStateLabel(task({ done: true }))).toBe('Completada');
	});

	it('una cancelada dice Cancelada aunque viaje con done: true', () => {
		expect(contextStateLabel(task({ done: true, cancelledAt: '2026-09-01T10:00:00.000Z' }))).toBe(
			'Cancelada',
		);
	});

	it('una archivada dice Archivada', () => {
		expect(contextStateLabel(task({ archivedAt: '2026-09-01T10:00:00.000Z' }))).toBe('Archivada');
	});

	it('cancelada Y archivada: cancelada manda, mismo orden que taskStateLabels', () => {
		expect(
			contextStateLabel(
				task({ cancelledAt: '2026-09-01T10:00:00.000Z', archivedAt: '2026-09-02T10:00:00.000Z' }),
			),
		).toBe('Cancelada');
	});
});

describe('subtaskGlyph', () => {
	it('un carácter distinto para hecha y pendiente', () => {
		expect(subtaskGlyph({ done: true })).toBe('✓');
		expect(subtaskGlyph({ done: false })).toBe('○');
	});
});

describe('subtaskItems', () => {
	it('sin subtasks (undefined), no hay nada que pintar', () => {
		expect(subtaskItems({ subtasks: undefined })).toBeNull();
	});

	it('con un array vacío, tampoco', () => {
		expect(subtaskItems({ subtasks: [] })).toBeNull();
	});

	it('con subtareas, las devuelve EN EL MISMO ORDEN', () => {
		const subtasks = [
			{ id: 's1', content: 'Uno', done: false },
			{ id: 's2', content: 'Dos', done: true },
		];
		expect(subtaskItems({ subtasks })).toEqual(subtasks);
	});
});

describe('CONTEXT_SUBTASK_TASK_CAP', () => {
	it('es un tope pequeño y positivo, no un valor accidental de 0 o negativo', () => {
		expect(CONTEXT_SUBTASK_TASK_CAP).toBeGreaterThan(0);
		expect(CONTEXT_SUBTASK_TASK_CAP).toBeLessThanOrEqual(50);
	});
});
