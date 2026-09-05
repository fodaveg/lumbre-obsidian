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
		// Los scripts de scripts/ y la config de vitest no son código del plugin:
		// corren en Node, dentro del gate o de CI, y su salida por consola es
		// justamente su producto. `no-nodejs-modules` existe porque el plugin corre
		// también en móvil (isDesktopOnly: false) y ahí no hay Node; estos ficheros
		// no se empaquetan en main.js, así que la regla no les aplica.
		files: ['scripts/**/*.mjs', '*.config.mts'],
		rules: {
			'obsidianmd/rule-custom-message': 'off',
			'obsidianmd/hardcoded-config-path': 'off',
			'obsidianmd/no-nodejs-modules': 'off',
		},
	},
	{
		// Los tests de `src/` corren en Node bajo Vitest y NO entran en `main.js`
		// (el bundle sale solo de `src/main.ts`), así que la prohibición de los
		// módulos de Node no les aplica: un test de forma que lee los ficheros del
		// plugin necesita `node:fs` por definición.
		files: ['src/**/*.test.ts'],
		rules: {
			'obsidianmd/no-nodejs-modules': 'off',
		},
	},
	{
		// `src/test/` es el DOM de mentira y el mock de `obsidian` para los tests
		// (`fake-dom.ts`, `obsidian-mock.ts`), no código que corra dentro de la
		// app: bajo Vitest/Node no existe `window` (`prefer-window-timers` pide
		// algo que no está), y `globalThis` es justo cómo se instala un global de
		// mentira (`no-global-this` protege la compatibilidad con una ventana
		// emergente de Obsidian, que aquí no aplica).
		files: ['src/test/**/*.ts', 'src/**/*.test.ts'],
		rules: {
			'obsidianmd/prefer-window-timers': 'off',
			'obsidianmd/no-global-this': 'off',
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
