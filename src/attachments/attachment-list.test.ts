import { describe, expect, it } from 'vitest';

import {
	attachmentsSectionFor,
	attachmentsToggleLabel,
	deleteButtonLabel,
} from './attachment-list';

const ATTACHMENT_A = { id: 'att-1', filename: 'plano.pdf', mime: 'application/pdf', size: 1024 };
const ATTACHMENT_B = { id: 'att-2', filename: 'foto.png', mime: 'image/png', size: 2048 };

describe('attachmentsSectionFor', () => {
	it('AUSENTE: el servidor no dice nada de los adjuntos', () => {
		expect(attachmentsSectionFor({ attachments: undefined })).toEqual({ kind: 'unknown' });
	});

	it('presente y vacío: la tarea no tiene ningún adjunto', () => {
		expect(attachmentsSectionFor({ attachments: [] })).toEqual({ kind: 'empty' });
	});

	it('presente con varios: se enseñan tal cual, en el mismo orden', () => {
		expect(attachmentsSectionFor({ attachments: [ATTACHMENT_A, ATTACHMENT_B] })).toEqual({
			kind: 'list',
			attachments: [ATTACHMENT_A, ATTACHMENT_B],
		});
	});
});

describe('attachmentsToggleLabel', () => {
	it('singular con uno', () => {
		expect(attachmentsToggleLabel(1)).toBe('1 adjunto');
	});

	it('plural con varios o con cero', () => {
		expect(attachmentsToggleLabel(3)).toBe('3 adjuntos');
		expect(attachmentsToggleLabel(0)).toBe('0 adjuntos');
	});
});

describe('deleteButtonLabel', () => {
	it('en reposo dice Borrar', () => {
		expect(deleteButtonLabel(false)).toBe('Borrar');
	});

	it('con la petición en curso dice Borrando…', () => {
		expect(deleteButtonLabel(true)).toBe('Borrando…');
	});
});
