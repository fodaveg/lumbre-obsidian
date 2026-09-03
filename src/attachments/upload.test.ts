import { describe, expect, it } from 'vitest';

import { MAX_ATTACHMENT_BYTES } from '../lumbre/client';
import {
	checkUploadSize,
	DEFAULT_MIME,
	formatBytes,
	mimeForExtension,
	uploadRequest,
} from './upload';

describe('checkUploadSize', () => {
	it('acepta un fichero normal', () => {
		expect(checkUploadSize(4096)).toEqual({ ok: true });
	});

	it('acepta justo el tope, 25 MB', () => {
		expect(checkUploadSize(MAX_ATTACHMENT_BYTES)).toEqual({ ok: true });
	});

	it('rechaza un byte por encima del tope y lo dice con el tamaño', () => {
		const result = checkUploadSize(MAX_ATTACHMENT_BYTES + 1);

		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toBe('too_large');
		expect(result.ok === false && result.message).toContain('25 MB');
	});

	it('rechaza un fichero vacío, que el servidor devolvería con un 400', () => {
		expect(checkUploadSize(0)).toMatchObject({ ok: false, reason: 'empty' });
	});
});

describe('uploadRequest', () => {
	const BYTES = new Uint8Array([1, 2, 3]).buffer;

	it('monta la ruta con taskId en la query y el nombre en la cabecera', () => {
		const request = uploadRequest('task-1', 'plano de la cocina.pdf', 'application/pdf', BYTES);

		expect(request.path).toBe('/api/attachments?taskId=task-1');
		expect(request.headers['x-lumbre-filename']).toBe('plano%20de%20la%20cocina.pdf');
		expect(request.body).toBe(BYTES);
	});

	it('el Content-Type es SIEMPRE octet-stream y el mime real va aparte', () => {
		// Con `Content-Type: text/plain`, SvelteKit rechaza con 403 antes de llegar
		// al handler: es uno de los cuatro mimes que trata como formulario.
		const request = uploadRequest('task-1', 'notas.txt', 'text/plain', BYTES);

		expect(request.headers['Content-Type']).toBe('application/octet-stream');
		expect(request.headers['x-lumbre-content-type']).toBe('text/plain');
	});

	it('sin mime, el real cae a octet-stream en vez de ir vacío', () => {
		expect(uploadRequest('t', 'raro.qqq', '   ', BYTES).headers['x-lumbre-content-type']).toBe(
			DEFAULT_MIME,
		);
	});

	it('escapa un nombre con caracteres que romperían la cabecera', () => {
		const request = uploadRequest('t', 'año “raro”.png', 'image/png', BYTES);

		expect(request.headers['x-lumbre-filename']).toBe(encodeURIComponent('año “raro”.png'));
		expect(request.headers['x-lumbre-filename']).not.toContain(' ');
	});
});

describe('mimeForExtension', () => {
	it('conoce las extensiones que guarda un vault', () => {
		expect(mimeForExtension('png')).toBe('image/png');
		expect(mimeForExtension('PDF')).toBe('application/pdf');
		expect(mimeForExtension('m4a')).toBe('audio/mp4');
	});

	it('lo que no conoce sube como octet-stream, no como un mime inventado', () => {
		expect(mimeForExtension('qqq')).toBe(DEFAULT_MIME);
		expect(mimeForExtension('')).toBe(DEFAULT_MIME);
	});
});

describe('formatBytes', () => {
	it('elige la unidad que se lee de un vistazo', () => {
		expect(formatBytes(512)).toBe('512 B');
		expect(formatBytes(2048)).toBe('2 kB');
		expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
	});
});
