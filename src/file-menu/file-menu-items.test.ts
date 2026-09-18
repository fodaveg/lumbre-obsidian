import { describe, expect, it } from 'vitest';

import { fileMenuItems } from './file-menu-items';

describe('fileMenuItems', () => {
	it('una nota Markdown lleva las dos entradas, vincular primero', () => {
		expect(fileMenuItems({ extension: 'md' })).toEqual(['linkToList', 'attachToTask']);
	});

	it('la extensión se compara sin mirar mayúsculas', () => {
		expect(fileMenuItems({ extension: 'MD' })).toEqual(['linkToList', 'attachToTask']);
	});

	it('un fichero que no es nota solo lleva adjuntar', () => {
		expect(fileMenuItems({ extension: 'pdf' })).toEqual(['attachToTask']);
		expect(fileMenuItems({ extension: 'png' })).toEqual(['attachToTask']);
	});

	it('un fichero sin extensión también lleva adjuntar', () => {
		expect(fileMenuItems({ extension: '' })).toEqual(['attachToTask']);
	});
});
