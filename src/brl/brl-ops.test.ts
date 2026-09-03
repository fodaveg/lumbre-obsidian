import { describe, expect, it } from 'vitest';

import type { BrlDay } from '../lumbre/client';
import {
	BRL_TODAY,
	brlCreateOp,
	brlEntryPresent,
	brlEntryText,
	brlMarker,
	MAX_BRL_ENTRY_LENGTH,
	parseBrlDate,
	parseBrlQuery,
} from './brl-ops';

function day(entries: BrlDay['entries']): BrlDay {
	return { date: '2026-09-03', entries };
}

describe('brlMarker y brlEntryText', () => {
	it('una nota lleva guion y un pensamiento igual', () => {
		expect(brlMarker('note')).toBe('-');
		expect(brlMarker('thought')).toBe('=');
	});

	it('pone el marcador del tipo elegido delante del texto', () => {
		expect(brlEntryText('Llamé al fontanero', 'note')).toBe('- Llamé al fontanero');
		expect(brlEntryText('No me apetece nada', 'thought')).toBe('= No me apetece nada');
	});

	it('el BOTÓN manda sobre el marcador tecleado, y no se acumulan', () => {
		expect(brlEntryText('- Llamé al fontanero', 'thought')).toBe('= Llamé al fontanero');
		expect(brlEntryText('=   Ya está', 'note')).toBe('- Ya está');
	});

	it('un texto vacío o solo con el marcador no da entrada', () => {
		expect(brlEntryText('   ', 'note')).toBeNull();
		expect(brlEntryText('=', 'thought')).toBeNull();
		expect(brlEntryText('-  ', 'note')).toBeNull();
	});

	it('recorta al tope del servidor', () => {
		const long = 'x'.repeat(MAX_BRL_ENTRY_LENGTH + 50);

		const entry = brlEntryText(long, 'note');

		expect(entry).toHaveLength(MAX_BRL_ENTRY_LENGTH + 2);
		expect(entry?.startsWith('- ')).toBe(true);
	});
});

describe('brlCreateOp', () => {
	it('por defecto apunta a today, que resuelve el servidor con la zona de la cuenta', () => {
		expect(brlCreateOp('Una nota', 'note')).toEqual({ date: BRL_TODAY, entry: '- Una nota' });
	});

	it('acepta un día explícito', () => {
		expect(brlCreateOp('Un pensamiento', 'thought', '2026-09-01')).toEqual({
			date: '2026-09-01',
			entry: '= Un pensamiento',
		});
	});

	it('sin texto no hay operación que encolar', () => {
		expect(brlCreateOp('  ', 'note')).toBeNull();
	});
});

describe('brlEntryPresent', () => {
	it('reconoce la entrada por su ID, no por su texto', () => {
		const releido = day([
			{ id: 'entry-1', time: '11:20', entry: '- Llamé al fontanero' },
			{ id: 'entry-2', time: '11:21', entry: '- Llamé al fontanero' },
		]);

		expect(brlEntryPresent(releido, 'entry-2')).toBe(true);
		expect(brlEntryPresent(releido, 'entry-9')).toBe(false);
	});

	it('un día vacío no confirma nada', () => {
		expect(brlEntryPresent(day([]), 'entry-1')).toBe(false);
	});
});

describe('parseBrlDate', () => {
	it('vacío, today y hoy son el mismo día del servidor', () => {
		expect(parseBrlDate('')).toEqual({ ok: true, date: BRL_TODAY });
		expect(parseBrlDate(' Today ')).toEqual({ ok: true, date: BRL_TODAY });
		expect(parseBrlDate('hoy')).toEqual({ ok: true, date: BRL_TODAY });
	});

	it('acepta una fecha ISO', () => {
		expect(parseBrlDate('2026-09-01')).toEqual({ ok: true, date: '2026-09-01' });
	});

	it('rechaza cualquier otra cosa con el problema en una línea', () => {
		const result = parseBrlDate('el lunes');

		expect(result.ok).toBe(false);
		expect(result.ok === false && result.error).toContain('el lunes');
	});
});

describe('parseBrlQuery', () => {
	it('un cuerpo vacío es el día de hoy', () => {
		expect(parseBrlQuery('')).toEqual({ ok: true, date: BRL_TODAY });
		expect(parseBrlQuery('\n  \n')).toEqual({ ok: true, date: BRL_TODAY });
	});

	it('lee date con cualquier caja', () => {
		expect(parseBrlQuery('Date: 2026-09-01')).toEqual({ ok: true, date: '2026-09-01' });
	});

	it('una clave desconocida es un error, no se ignora', () => {
		const result = parseBrlQuery('scope: today');

		expect(result.ok).toBe(false);
		expect(result.ok === false && result.error).toContain('scope');
	});

	it('una línea sin dos puntos es un error', () => {
		expect(parseBrlQuery('today').ok).toBe(false);
	});
});
