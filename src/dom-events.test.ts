import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Test de FORMA: en el código del plugin no puede quedar ningún
 * `addEventListener` a pelo. Los listeners de una pieza de Obsidian se registran
 * con `registerDomEvent`, que es lo que los suelta al descargar el plugin (o al
 * desmontar el bloque, el modal o la vista). Uno a pelo sobrevive a su dueño.
 *
 * `diagnostics/unhandled.ts` está fuera a propósito: ahí no hay ningún
 * `Component` de Obsidian, es la ayuda pura que envuelve callbacks.
 */
const SOURCE_ROOT = new URL('.', import.meta.url).pathname;

/** Los ficheros de código del plugin: `src/**\/*.ts` sin los tests. */
function sourceFiles(directory: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			found.push(...sourceFiles(path));
			continue;
		}
		if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
		found.push(path);
	}
	return found;
}

/** Rutas relativas a `src/` que pueden llamar a `addEventListener`. */
const ALLOWED = ['diagnostics/unhandled.ts', 'test/obsidian-mock.ts'];

describe('listeners del DOM', () => {
	it('nadie llama a addEventListener a pelo: se registra con registerDomEvent', () => {
		const offenders = sourceFiles(SOURCE_ROOT)
			.map((path) => ({ path: path.slice(SOURCE_ROOT.length), body: readFileSync(path, 'utf8') }))
			.filter((file) => !ALLOWED.includes(file.path))
			.filter((file) => file.body.includes('addEventListener('))
			.map((file) => file.path);

		expect(offenders).toEqual([]);
	});

	it('la sonda ve los ficheros de verdad (si no, el test de arriba pasa en vacío)', () => {
		const files = sourceFiles(SOURCE_ROOT);
		expect(files.length).toBeGreaterThan(30);
		expect(files.some((path) => path.endsWith('main.ts'))).toBe(true);
	});
});
