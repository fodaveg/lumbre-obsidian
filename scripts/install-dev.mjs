#!/usr/bin/env node
/**
 * Copia el plugin construido al vault de desarrollo.
 *
 *   OBSIDIAN_VAULT=/ruta/al/vault npm run install:dev
 *
 * Destino: $OBSIDIAN_VAULT/.obsidian/plugins/lumbre/
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const FILES = ['main.js', 'manifest.json', 'styles.css'];

const vault = process.env.OBSIDIAN_VAULT;
if (!vault) {
	console.error('install-dev: falta la variable OBSIDIAN_VAULT con la ruta del vault.');
	process.exit(1);
}

if (!existsSync(vault)) {
	console.error(`install-dev: el vault ${vault} no existe.`);
	process.exit(1);
}

const missing = FILES.filter((file) => !existsSync(file));
if (missing.length > 0) {
	console.error(
		`install-dev: falta ${missing.join(', ')}. Construye antes con "npm run build" o "npm run dev".`,
	);
	process.exit(1);
}

const target = join(vault, '.obsidian', 'plugins', 'lumbre');
mkdirSync(target, { recursive: true });

for (const file of FILES) {
	copyFileSync(file, join(target, file));
}

console.log(`install-dev: copiados ${FILES.join(', ')} a ${target}`);
