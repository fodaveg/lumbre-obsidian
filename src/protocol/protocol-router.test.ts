import { describe, expect, it } from 'vitest';

import { MAX_TITLE_LENGTH } from '../ui/draft-from-editor';
import { parseSendTitle, routeForAction } from './protocol-router';

describe('parseSendTitle', () => {
	it('título ausente: cadena vacía', () => {
		expect(parseSendTitle({})).toBe('');
	});

	it('título vacío: cadena vacía', () => {
		expect(parseSendTitle({ title: '' })).toBe('');
	});

	it('título con espacios de sobra: colapsados a uno', () => {
		expect(parseSendTitle({ title: '  Comprar   pan  ' })).toBe('Comprar pan');
	});

	it('título más largo que el tope: se recorta con el marcador de corte', () => {
		const largo = 'x'.repeat(MAX_TITLE_LENGTH + 50);
		const título = parseSendTitle({ title: largo });
		expect(título.length).toBe(MAX_TITLE_LENGTH);
		expect(título.endsWith('…')).toBe(true);
	});

	it('título exactamente en el tope: no se toca', () => {
		const exacto = 'x'.repeat(MAX_TITLE_LENGTH);
		expect(parseSendTitle({ title: exacto })).toBe(exacto);
	});
});

describe('routeForAction', () => {
	it('lumbre/send: abre el modal de enviar con el título parseado', () => {
		expect(routeForAction('lumbre/send', { title: 'Comprar pan' })).toEqual({
			kind: 'send',
			title: 'Comprar pan',
		});
	});

	it('lumbre/send sin título: modal igual, título vacío', () => {
		expect(routeForAction('lumbre/send', {})).toEqual({ kind: 'send', title: '' });
	});

	it('lumbre/open: abre el panel, sin mirar los parámetros', () => {
		expect(routeForAction('lumbre/open', { title: 'esto no pinta nada aquí' })).toEqual({
			kind: 'open',
		});
	});

	it('una ruta desconocida no lanza: se devuelve como tal, con la acción tal cual llegó', () => {
		expect(routeForAction('lumbre', {})).toEqual({ kind: 'unknown', action: 'lumbre' });
		expect(routeForAction('lumbre/lo-que-sea', {})).toEqual({
			kind: 'unknown',
			action: 'lumbre/lo-que-sea',
		});
	});
});
