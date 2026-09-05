import { describe, expect, it } from 'vitest';

import {
	buildObsidianDeepLink,
	MAX_LABEL_LENGTH,
	noteLinkLabel,
	notePathWithoutExtension,
} from './deep-link';

describe('notePathWithoutExtension', () => {
	it('quita la extensión .md', () => {
		expect(notePathWithoutExtension('Proyectos/Cocina.md')).toBe('Proyectos/Cocina');
	});

	it('deja la ruta tal cual si no acaba en .md', () => {
		expect(notePathWithoutExtension('Proyectos/Cocina.canvas')).toBe('Proyectos/Cocina.canvas');
	});
});

describe('buildObsidianDeepLink', () => {
	it('compone open?vault=&file= con la extensión quitada', () => {
		const url = buildObsidianDeepLink('Mi vault', 'Proyectos/Cocina.md');
		expect(url).toBe('obsidian://open?vault=Mi%20vault&file=Proyectos%2FCocina');
	});

	it('codifica el espacio como %20, nunca como +', () => {
		const url = buildObsidianDeepLink('vault', 'Notas con espacios.md');
		expect(url).toContain('Notas%20con%20espacios');
		expect(url).not.toContain('+');
	});

	it('escapa caracteres reservados de la ruta (barras y almohadillas)', () => {
		const url = buildObsidianDeepLink('vault', 'Área/Nota #1.md');
		expect(url).toBe('obsidian://open?vault=vault&file=%C3%81rea%2FNota%20%231');
	});
});

describe('noteLinkLabel', () => {
	it('deja el nombre tal cual si no pasa del tope', () => {
		expect(noteLinkLabel('Cocina')).toBe('Cocina');
	});

	it('recorta a MAX_LABEL_LENGTH', () => {
		const long = 'a'.repeat(MAX_LABEL_LENGTH + 50);
		const label = noteLinkLabel(long);
		expect(label).toHaveLength(MAX_LABEL_LENGTH);
		expect(label).toBe('a'.repeat(MAX_LABEL_LENGTH));
	});
});
