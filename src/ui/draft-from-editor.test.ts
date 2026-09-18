import { describe, expect, it } from 'vitest';

import {
	MAX_EXCERPT_LENGTH,
	MAX_TITLE_LENGTH,
	draftFromEditor,
	linesFromSelection,
	stripListMarker,
	truncate,
} from './draft-from-editor';

describe('stripListMarker', () => {
	it('quita la viñeta y el checkbox, marcado o sin marcar', () => {
		expect(stripListMarker('- Comprar pan')).toBe('Comprar pan');
		expect(stripListMarker('  * [ ] Comprar pan')).toBe('Comprar pan');
		expect(stripListMarker('\t- [x] Comprar pan')).toBe('Comprar pan');
		expect(stripListMarker('- [/] Comprar pan')).toBe('Comprar pan');
		expect(stripListMarker('3) Comprar pan')).toBe('Comprar pan');
		expect(stripListMarker('12. Comprar pan')).toBe('Comprar pan');
	});

	it('no toca una línea normal ni un guion dentro del texto', () => {
		expect(stripListMarker('Comprar pan')).toBe('Comprar pan');
		expect(stripListMarker('Llamar a Ana - por lo del piso')).toBe('Llamar a Ana - por lo del piso');
	});
});

describe('truncate', () => {
	it('deja el texto corto tal cual', () => {
		expect(truncate('hola', 10)).toBe('hola');
	});

	it('nunca devuelve más caracteres que el tope, contando el de recorte', () => {
		const cut = truncate('a'.repeat(50), 10);
		expect(cut).toHaveLength(10);
		expect(cut.endsWith('…')).toBe(true);
	});
});

describe('draftFromEditor', () => {
	it('la selección manda sobre la línea', () => {
		const draft = draftFromEditor({ selection: 'lo seleccionado', line: '- la línea entera' });
		expect(draft.title).toBe('lo seleccionado');
		expect(draft.excerpt).toBe('lo seleccionado');
	});

	it('sin selección usa la línea sin su marcador', () => {
		const draft = draftFromEditor({ selection: '', line: '  - [ ] Llamar al fontanero' });
		expect(draft.title).toBe('Llamar al fontanero');
	});

	it('colapsa el blanco de una selección de varias líneas', () => {
		const draft = draftFromEditor({ selection: 'primera\n\n  segunda  ', line: '' });
		expect(draft.title).toBe('primera segunda');
	});

	it('recorta el título a 300 y el extracto a 240', () => {
		const long = 'x'.repeat(1000);
		const draft = draftFromEditor({ selection: long, line: '' });
		expect(draft.title).toHaveLength(MAX_TITLE_LENGTH);
		expect(draft.excerpt).toHaveLength(MAX_EXCERPT_LENGTH);
	});

	it('con el editor vacío no inventa extracto', () => {
		const draft = draftFromEditor({ selection: '', line: '   ' });
		expect(draft.title).toBe('');
		expect(draft.excerpt).toBeNull();
	});
});

describe('linesFromSelection', () => {
	it('una sola línea da un solo título', () => {
		expect(linesFromSelection('Comprar pan')).toEqual(['Comprar pan']);
	});

	it('varias líneas dan un título por línea, en orden', () => {
		expect(linesFromSelection('Comprar pan\nLlamar a Ana\nRegar las plantas')).toEqual([
			'Comprar pan',
			'Llamar a Ana',
			'Regar las plantas',
		]);
	});

	it('las líneas vacías intercaladas se saltan, sin generar un título vacío', () => {
		expect(linesFromSelection('Comprar pan\n\n  \nLlamar a Ana')).toEqual([
			'Comprar pan',
			'Llamar a Ana',
		]);
	});

	it('quita el marcador de viñeta y de checkbox de cada línea', () => {
		expect(linesFromSelection('- Comprar pan\n- [ ] Llamar a Ana\n* [x] Regar plantas')).toEqual([
			'Comprar pan',
			'Llamar a Ana',
			'Regar plantas',
		]);
	});

	it('recorta cada línea a MAX_TITLE_LENGTH por separado', () => {
		const long = 'x'.repeat(1000);
		const [first, second] = linesFromSelection(`${long}\nCorta`);
		expect(first).toHaveLength(MAX_TITLE_LENGTH);
		expect(second).toBe('Corta');
	});

	it('una selección de más de 200 líneas da un título por cada una', () => {
		const lines = Array.from({ length: 250 }, (_, index) => `Tarea ${index}`);
		expect(linesFromSelection(lines.join('\n'))).toHaveLength(250);
	});

	it('una selección que queda vacía del todo da un array vacío', () => {
		expect(linesFromSelection('\n  \n\t\n')).toEqual([]);
		expect(linesFromSelection('- [ ] \n*  ')).toEqual([]);
	});
});
