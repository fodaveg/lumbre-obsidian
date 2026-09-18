import { describe, expect, it } from 'vitest';

import type { LumbreTask } from '../lumbre/types';
import { refChipText } from './ref-chip-format';

function task(overrides: Partial<LumbreTask> = {}): LumbreTask {
	return {
		id: '1',
		content: 'Comprar pan',
		notes: null,
		date: null,
		someday: false,
		deadline: null,
		time: null,
		priority: 'p4',
		done: false,
		cancelledAt: null,
		archivedAt: null,
		list: null,
		section: null,
		rolloverCount: 0,
		parentId: null,
		...overrides,
	};
}

describe('refChipText', () => {
	it('sin fecha y abierta, no hay nada que añadir: null, el chip no se pinta', () => {
		expect(refChipText(task())).toBeNull();
	});

	it('con fecha, la enseña', () => {
		expect(refChipText(task({ date: '2026-09-20' }))).toBe('2026-09-20');
	});

	it('con fecha y hora, las junta', () => {
		expect(refChipText(task({ date: '2026-09-20', time: '09:30' }))).toBe('2026-09-20 09:30');
	});

	it('aparcada en Algún día, lo dice aunque tenga fecha (no debería, pero "someday" manda)', () => {
		expect(refChipText(task({ someday: true }))).toBe('Algún día');
	});

	it('completada sin cancelar: "Hecha"', () => {
		expect(refChipText(task({ done: true }))).toBe('Hecha');
	});

	it('completada y cancelada: "Cancelada", no "Hecha"', () => {
		expect(refChipText(task({ done: true, cancelledAt: '2026-09-18T10:00:00.000Z' }))).toBe(
			'Cancelada',
		);
	});

	it('archivada: lo dice', () => {
		expect(refChipText(task({ archivedAt: '2026-09-18T10:00:00.000Z' }))).toBe('Archivada');
	});

	it('completada y archivada: las dos, Hecha primero', () => {
		expect(
			refChipText(task({ done: true, archivedAt: '2026-09-18T10:00:00.000Z' })),
		).toBe('Hecha · Archivada');
	});

	it('junta estado y fecha con el separador " · "', () => {
		expect(refChipText(task({ done: true, date: '2026-09-20' }))).toBe('Hecha · 2026-09-20');
	});
});
