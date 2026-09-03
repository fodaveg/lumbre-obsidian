import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { defineConfig, globalIgnores } from 'eslint/config';

// La config va en .mjs y no en .mts a propósito: ESLint solo carga una config
// TypeScript si `jiti` está instalado, y esa dependencia no compra nada aquí.

// Los .mjs de scripts/ no entran en tsconfig.json (no son fuentes del bundle),
// así que necesitan la vía por defecto del projectService para poder lintarse.
const defaultProjectFiles = [
	'eslint.config.mjs',
	'manifest.json',
	'scripts/verify-release.mjs',
	'scripts/install-dev.mjs',
];

export default defineConfig(
	globalIgnores([
		'.claude/**',
		'node_modules',
		'dist',
		'esbuild.config.mjs',
		'version-bump.mjs',
		'versions.json',
		'main.js',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
				...globals.node,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [...defaultProjectFiles],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// Los scripts de scripts/ no son código del plugin: corren en Node, dentro
		// del gate o de CI, y su salida por consola es justamente su producto.
		files: ['scripts/**/*.mjs'],
		rules: {
			'obsidianmd/rule-custom-message': 'off',
			'obsidianmd/hardcoded-config-path': 'off',
		},
	},
	{
		files: ['src/**/*.ts'],
		rules: {
			// La regla minusculiza "Lumbre", que es un nombre propio.
			'obsidianmd/ui/sentence-case': 'off',
			// La API declarativa de ajustes llegó en Obsidian 1.13 y este plugin
			// declara minAppVersion 1.11.4.
			'obsidianmd/settings-tab/prefer-setting-definitions': 'off',
		},
	},
);
