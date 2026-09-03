#!/usr/bin/env node
/**
 * Comprueba que la versión es coherente en los tres sitios y, cuando se le pasa,
 * que el tag y la release publicada son los que BRAT espera.
 *
 * Sin flags (lo que corre `npm run check`): manifest.json, package.json y
 * versions.json dicen la misma versión.
 *
 *   --tag <tag>                el tag es EXACTAMENTE la versión, sin prefijo "v".
 *   --published <fichero.json> salida de `gh api .../releases/tags/<tag>`: no es
 *                              borrador y trae los tres assets con tamaño > 0.
 */

import { readFileSync } from 'node:fs';
import process from 'node:process';

const REQUIRED_ASSETS = ['main.js', 'manifest.json', 'styles.css'];

const errors = [];

function fail(message) {
	errors.push(message);
}

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch (error) {
		fail(`no se pudo leer ${path}: ${error instanceof Error ? error.message : String(error)}`);
		return null;
	}
}

function parseArgs(argv) {
	const args = { tag: null, published: null };
	for (let i = 0; i < argv.length; i += 1) {
		const flag = argv[i];
		if (flag === '--tag' || flag === '--published') {
			const value = argv[i + 1];
			if (value === undefined || value.startsWith('--')) {
				fail(`${flag} necesita un valor`);
				return args;
			}
			args[flag === '--tag' ? 'tag' : 'published'] = value;
			i += 1;
			continue;
		}
		fail(`argumento desconocido: ${flag}`);
	}
	return args;
}

const args = parseArgs(process.argv.slice(2));

const manifest = readJson('manifest.json');
const pkg = readJson('package.json');
const versions = readJson('versions.json');

const version = manifest?.version;

if (manifest !== null && typeof version !== 'string') {
	fail('manifest.json no declara una versión');
}

if (pkg !== null && manifest !== null && pkg.version !== version) {
	fail(`package.json dice ${pkg.version} y manifest.json dice ${version}`);
}

if (versions !== null && typeof version === 'string' && !(version in versions)) {
	fail(`versions.json no tiene una entrada para ${version}`);
}

if (args.tag !== null) {
	if (args.tag !== version) {
		fail(
			`el tag "${args.tag}" no es la versión "${version}". El tag tiene que ser la versión ` +
				'exacta, sin prefijo "v": es lo que buscan BRAT y el instalador de Obsidian.',
		);
	}
}

if (args.published !== null) {
	const release = readJson(args.published);
	if (release !== null) {
		if (release.draft === true) {
			fail('la release publicada sigue siendo borrador (draft)');
		}
		const assets = Array.isArray(release.assets) ? release.assets : [];
		for (const name of REQUIRED_ASSETS) {
			const asset = assets.find((candidate) => candidate?.name === name);
			if (asset === undefined) {
				fail(`falta el asset ${name} en la release publicada`);
				continue;
			}
			if (!(typeof asset.size === 'number' && asset.size > 0)) {
				fail(`el asset ${name} está vacío (size = ${asset.size})`);
			}
		}
	}
}

if (errors.length > 0) {
	for (const error of errors) {
		console.error(`verify-release: ${error}`);
	}
	process.exit(1);
}

const scope = [
	`versión ${version} coherente en manifest, package y versions`,
	args.tag !== null ? `tag "${args.tag}" correcto` : null,
	args.published !== null ? `release publicada con sus ${REQUIRED_ASSETS.length} assets` : null,
]
	.filter((line) => line !== null)
	.join('; ');

console.log(`verify-release: ${scope}`);
