import { describe, expect, it } from 'vitest';

import {
	MAX_EXCERPT_LENGTH,
	MAX_TITLE_LENGTH,
	draftFromEditor,
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
