import { describe, expect, it } from 'vitest';

import { unsupportedPreviewMessage, viewKindFor } from './attachment-viewer';

describe('viewKindFor', () => {
	it('los mimes de imagen conocidos se pintan como image', () => {
		for (const mime of [
			'image/png',
			'image/jpeg',
			'image/gif',
			'image/webp',
			'image/svg+xml',
			'image/avif',
			'image/bmp',
		]) {
			expect(viewKindFor(mime)).toBe('image');
		}
	});

	it('application/pdf se pinta como pdf', () => {
		expect(viewKindFor('application/pdf')).toBe('pdf');
	});

	it('cualquier text/* se pinta como texto, y también application/json', () => {
		expect(viewKindFor('text/plain')).toBe('text');
		expect(viewKindFor('text/csv')).toBe('text');
		expect(viewKindFor('text/markdown')).toBe('text');
		expect(viewKindFor('application/json')).toBe('text');
	});

	it('mayúsculas y espacios no cambian el resultado', () => {
		expect(viewKindFor('  IMAGE/PNG  ')).toBe('image');
	});

	it('un mime que no se sabe pintar devuelve null', () => {
		expect(viewKindFor('video/mp4')).toBeNull();
		expect(viewKindFor('application/zip')).toBeNull();
		expect(viewKindFor('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBeNull();
		expect(viewKindFor('')).toBeNull();
	});
});

describe('unsupportedPreviewMessage', () => {
	it('lleva el nombre, el mime y el tamaño legible', () => {
		const message = unsupportedPreviewMessage({
			filename: 'video.mp4',
			mime: 'video/mp4',
			size: 2 * 1024 * 1024,
		});
		expect(message).toBe('No se puede previsualizar «video.mp4» (video/mp4, 2.0 MB).');
	});

	it('un mime vacío se enseña como "tipo desconocido"', () => {
		const message = unsupportedPreviewMessage({ filename: 'raro.bin', mime: '', size: 10 });
		expect(message).toBe('No se puede previsualizar «raro.bin» (tipo desconocido, 10 B).');
	});
});
