import { describe, expect, it } from 'vitest';

import { exportFileName, exportFilePath } from './export-path';

const NOW = new Date('2026-09-05T13:20:00.000Z');

describe('exportFileName', () => {
	it('lleva la fecha local con dos dígitos y sin dos puntos', () => {
		expect(exportFileName(NOW)).toBe('lumbre-export-2026-09-05.json');
	});

	it('pad de mes y día a dos dígitos', () => {
		expect(exportFileName(new Date('2026-01-03T00:00:00.000Z'))).toBe(
			'lumbre-export-2026-01-03.json',
		);
	});

	it('nunca lleva : ni otro carácter fuera de lo que admite un fichero del vault', () => {
		expect(exportFileName(NOW)).toMatch(/^[a-zA-Z0-9._-]+$/);
	});
});

describe('exportFilePath', () => {
	it('une la carpeta y el nombre del día con una sola barra', () => {
		expect(exportFilePath('Lumbre/exportaciones', NOW)).toBe(
			'Lumbre/exportaciones/lumbre-export-2026-09-05.json',
		);
	});

	it('una carpeta con barra final no duplica la separación', () => {
		expect(exportFilePath('Lumbre/exportaciones/', NOW)).toBe(
			'Lumbre/exportaciones/lumbre-export-2026-09-05.json',
		);
	});

	it('una carpeta vacía deja la ruta en la raíz del vault', () => {
		expect(exportFilePath('', NOW)).toBe('/lumbre-export-2026-09-05.json');
	});
});
