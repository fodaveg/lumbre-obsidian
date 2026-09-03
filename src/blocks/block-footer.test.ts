import { describe, expect, it } from 'vitest';

import { describeFailure, MAX_TASKS_LIMIT } from '../lumbre/client';
import { partialNote, staleNote } from './block-footer';

describe('block-footer', () => {
	it('el pie de un token caducado NO dice «Sin conexión» y sí habla del token', () => {
		const text = staleNote(describeFailure('unauthorized', 401));
		expect(text).toContain('token');
		expect(text).not.toContain('Sin conexión');
	});

	it('el pie de un corte de red sigue diciendo que no se pudo conectar', () => {
		expect(staleNote(describeFailure('network'))).toContain('No se pudo conectar');
	});

	it('el pie dice siempre que lo que se enseña es la última lectura', () => {
		expect(staleNote(describeFailure('server', 500))).toContain('última lectura');
	});

	it('una lectura que llega justo al tope del servidor se declara parcial', () => {
		expect(partialNote(MAX_TASKS_LIMIT)).toContain(String(MAX_TASKS_LIMIT));
		expect(partialNote(MAX_TASKS_LIMIT)).toContain('parciales');
	});

	it('una lectura por debajo del tope no dice nada', () => {
		expect(partialNote(MAX_TASKS_LIMIT - 1)).toBeNull();
		expect(partialNote(0)).toBeNull();
	});
});
