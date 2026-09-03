import { describe, expect, it } from 'vitest';

import { isForbiddenKey, MAX_STRING_LENGTH, redact, REDACTED, stripSecrets } from './redact';

const TOKEN = 'lum_tok_9f8e7d6c5b4a3210';

describe('redact: el token', () => {
	it('lo tapa en los TRES sitios de un objeto: clave, valor y anidado', () => {
		const value = {
			[`cabecera-${TOKEN}`]: 'inofensivo',
			mensaje: `falló con ${TOKEN} al final`,
			anidado: { lista: [{ profundo: TOKEN }] },
		};

		const cleaned = JSON.stringify(redact(value, [TOKEN]));

		expect(cleaned).not.toContain(TOKEN);
		expect(cleaned).toContain(REDACTED);
	});

	it('lo tapa en una cadena suelta y en un array', () => {
		expect(redact(`Bearer ${TOKEN}`, [TOKEN])).toBe(`Bearer ${REDACTED}`);
		expect(redact([TOKEN, 'otra'], [TOKEN])).toEqual([REDACTED, 'otra']);
	});

	it('lo tapa aunque aparezca varias veces en la misma cadena', () => {
		expect(redact(`${TOKEN} y ${TOKEN}`, [TOKEN])).toBe(`${REDACTED} y ${REDACTED}`);
	});

	it('ignora los secretos demasiado cortos, que dejarían el registro ilegible', () => {
		expect(redact('un texto con la', ['la'])).toBe('un texto con la');
	});
});

describe('redact: las claves prohibidas', () => {
	it('tapa Authorization aunque el token no esté en la lista de secretos', () => {
		const cleaned = redact({ Authorization: 'Bearer lo-que-sea' }, []);

		expect(cleaned).toEqual({ Authorization: REDACTED });
	});

	it.each(['authorization', 'Authorization', 'x-token', 'API_KEY', 'password'])(
		'«%s» es una clave prohibida',
		(key) => {
			expect(isForbiddenKey(key)).toBe(true);
		},
	);

	it('no tapa una clave normal', () => {
		expect(isForbiddenKey('notePath')).toBe(false);
		expect(redact({ notePath: 'Cocina.md' }, [])).toEqual({ notePath: 'Cocina.md' });
	});
});

describe('redact: la forma de lo que sale', () => {
	it('recorta las cadenas largas al tope', () => {
		const long = 'a'.repeat(500);

		const cleaned = redact(long, []) as string;

		expect(cleaned).toHaveLength(MAX_STRING_LENGTH);
		expect(cleaned.endsWith('…')).toBe(true);
	});

	it('recorta también las claves largas', () => {
		const cleaned = redact({ ['k'.repeat(500)]: 1 }, []) as Record<string, unknown>;

		expect(Object.keys(cleaned)[0]).toHaveLength(MAX_STRING_LENGTH);
	});

	it('no se cuelga con una referencia circular', () => {
		const value: Record<string, unknown> = { nombre: 'raíz' };
		value['yo'] = value;

		expect(redact(value, [])).toEqual({ nombre: 'raíz', yo: '[circular]' });
	});

	it('resume un array muy largo en vez de copiarlo entero', () => {
		const cleaned = redact(Array.from({ length: 70 }, (_v, index) => index), []) as unknown[];

		expect(cleaned).toHaveLength(51);
		expect(cleaned.at(-1)).toBe('[+20 más]');
	});

	it('convierte a texto lo que no es serializable', () => {
		expect(redact({ fn: (): void => undefined, fecha: new Date(0) }, [])).toEqual({
			fn: '[función]',
			fecha: '1970-01-01T00:00:00.000Z',
		});
	});

	it('un Error sale con nombre y mensaje, sin stack', () => {
		expect(redact(new Error('se rompió'), [])).toEqual({ name: 'Error', message: 'se rompió' });
	});
});

describe('stripSecrets', () => {
	it('tapa el secreto SIN recortar el texto, que es lo que necesita el informe', () => {
		const long = `${'x'.repeat(400)} ${TOKEN} ${'y'.repeat(400)}`;

		const cleaned = stripSecrets(long, [TOKEN]);

		expect(cleaned).not.toContain(TOKEN);
		expect(cleaned.length).toBeGreaterThan(MAX_STRING_LENGTH);
	});
});
