import { describe, expect, it } from 'vitest';

import {
	composeSnapshot,
	countSnapshots,
	joinSnapshot,
	MAX_NOTES_LEN,
	snapshotHeader,
	TRUNCATION_MARK,
} from './note-snapshot';

const AT = new Date('2026-09-05T13:20:00.000Z');

describe('snapshotHeader', () => {
	it('lleva la ruta de la nota y la fecha y hora locales, sin guiones largos', () => {
		const header = snapshotHeader('Proyectos/Cocina.md', AT);

		expect(header).toContain('Proyectos/Cocina.md');
		expect(header.startsWith('=== Foto de la nota ')).toBe(true);
		expect(header.endsWith(' ===')).toBe(true);
		expect(header).not.toContain('—');
	});
});

describe('countSnapshots', () => {
	it('sin notas previas son cero fotos', () => {
		expect(countSnapshots(null)).toBe(0);
		expect(countSnapshots('')).toBe(0);
	});

	it('un texto sin cabecera tampoco es una foto', () => {
		expect(countSnapshots('Notas normales, sin fotos.')).toBe(0);
	});

	it('cuenta las cabeceras, no las líneas', () => {
		const notes = [
			'Notas de David.',
			'',
			snapshotHeader('Casa.md', AT),
			'',
			'Texto de la primera foto.',
			'',
			snapshotHeader('Casa.md', new Date('2026-09-05T18:00:00.000Z')),
			'',
			'Texto de la segunda foto.',
		].join('\n');

		expect(countSnapshots(notes)).toBe(2);
	});
});

describe('joinSnapshot', () => {
	it('sin notas existentes, la foto empieza directa por la cabecera', () => {
		const header = snapshotHeader('Casa.md', AT);
		expect(joinSnapshot(null, header, 'Texto de la nota')).toBe(`${header}\n\nTexto de la nota`);
	});

	it('con notas existentes, se AÑADEN debajo con una línea en blanco de por medio', () => {
		const header = snapshotHeader('Casa.md', AT);
		const result = joinSnapshot('Lo que David escribió desde Lumbre.', header, 'Texto de la nota');

		expect(result).toBe(
			`Lo que David escribió desde Lumbre.\n\n${header}\n\nTexto de la nota`,
		);
		// Lo existente sigue ahí ENTERO: esto AÑADE, nunca sustituye.
		expect(result).toContain('Lo que David escribió desde Lumbre.');
	});
});

describe('composeSnapshot', () => {
	it('cuando cabe, devuelve el texto entero sin recortar', () => {
		const result = composeSnapshot('Nota vieja.', 'Casa.md', 'Un párrafo cualquiera.', AT);

		expect(result?.truncated).toBe(false);
		expect(result?.notes).toContain('Nota vieja.');
		expect(result?.notes).toContain('Un párrafo cualquiera.');
	});

	it('sin permiso para recortar, si no cabe devuelve null: es la señal para preguntar', () => {
		const largo = 'x'.repeat(MAX_NOTES_LEN);

		const result = composeSnapshot(null, 'Casa.md', largo, AT, { allowTruncate: false });

		expect(result).toBeNull();
	});

	it('con permiso, recorta el TEXTO y añade la marca, pero conserva la cabecera entera', () => {
		const largo = 'x'.repeat(MAX_NOTES_LEN);

		const result = composeSnapshot(null, 'Casa.md', largo, AT, { allowTruncate: true });

		expect(result).not.toBeNull();
		expect(result?.truncated).toBe(true);
		expect(result?.notes.length).toBeLessThanOrEqual(MAX_NOTES_LEN);
		expect(result?.notes).toContain(snapshotHeader('Casa.md', AT));
		expect(result?.notes.endsWith(TRUNCATION_MARK)).toBe(true);
	});

	it('recortando, NUNCA toca lo existente: solo el texto nuevo cede espacio', () => {
		const existente = 'Lo que ya había, que no se toca.';
		const largo = 'x'.repeat(MAX_NOTES_LEN);

		const result = composeSnapshot(existente, 'Casa.md', largo, AT, {
			allowTruncate: true,
			maxLen: existente.length + 200,
		});

		expect(result?.notes.startsWith(existente)).toBe(true);
	});

	it('si ni la cabecera cabe detrás de lo existente, ni recortando hay hueco: null', () => {
		const existente = 'x'.repeat(MAX_NOTES_LEN - 10);

		const result = composeSnapshot(existente, 'Casa.md', 'Algo', AT, {
			allowTruncate: true,
			maxLen: MAX_NOTES_LEN,
		});

		expect(result).toBeNull();
	});

	it('respeta un maxLen inyectado, para poder probar el recorte sin generar 10000 caracteres', () => {
		const maxLen = 150;
		const result = composeSnapshot(null, 'Casa.md', 'Un texto bastante largo de verdad'.repeat(5), AT, {
			allowTruncate: true,
			maxLen,
		});

		expect(result?.truncated).toBe(true);
		expect(result?.notes.length).toBeLessThanOrEqual(maxLen);
	});
});
