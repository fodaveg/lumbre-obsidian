import { fileURLToPath, URL } from 'node:url';

import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// Un worktree de agente bajo .claude/ es una segunda copia completa de src/.
		// Sin esto, `vitest run` desde la raíz recoge las dos copias y da el doble
		// de tests en verde.
		exclude: [...configDefaults.exclude, '.claude/**'],
	},
	resolve: {
		alias: {
			obsidian: fileURLToPath(new URL('./src/test/obsidian-mock.ts', import.meta.url)),
		},
	},
});
