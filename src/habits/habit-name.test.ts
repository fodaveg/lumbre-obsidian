import { describe, expect, it } from 'vitest';

import { normalizeHabitName } from './habit-name';

describe('normalizeHabitName', () => {
	it('recorta espacios de los extremos', () => {
		expect(normalizeHabitName('  Correr  ')).toBe('Correr');
	});

	it('vacío da null', () => {
		expect(normalizeHabitName('')).toBeNull();
	});

	it('solo espacios da null', () => {
		expect(normalizeHabitName('   ')).toBeNull();
	});

	it('un nombre sin espacios de sobra se conserva tal cual', () => {
		expect(normalizeHabitName('Leer')).toBe('Leer');
	});
});
