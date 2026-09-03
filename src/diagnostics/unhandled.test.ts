import { describe, expect, it } from 'vitest';

import { Logger } from './logger';
import { guarded, isFromPlugin, PLUGIN_STACK_MARK, unhandledEvent } from './unhandled';

function silentLogger(level: 'info' | 'debug' = 'info'): Logger {
	return Logger.create({ console: null, level, now: () => new Date(0) });
}

/** Un error con un stack de este plugin, como el que da Obsidian. */
function pluginError(message = 'se rompió'): Error {
	const error = new Error(message);
	error.stack = `Error: ${message}\n    at LumbrePlugin.onload (${PLUGIN_STACK_MARK}:120:5)`;
	return error;
}

describe('guarded', () => {
	it('registra el fallo y NO lo relanza', () => {
		const logger = silentLogger();
		const wrapped = guarded(logger, 'comando send-task', () => {
			throw new Error('se rompió');
		});

		expect(() => wrapped()).not.toThrow();

		const [event] = logger.recent();
		expect(event?.level).toBe('error');
		expect(event?.data).toMatchObject({
			action: 'comando send-task',
			asynchronous: false,
			name: 'Error',
			message: 'se rompió',
		});
	});

	it('devuelve `undefined` cuando el callback se cae', () => {
		const wrapped = guarded(silentLogger(), 'acción', (): number => {
			throw new Error('no');
		});

		expect(wrapped()).toBeUndefined();
	});

	it('deja pasar el valor y los argumentos cuando todo va bien', () => {
		const logger = silentLogger();
		const wrapped = guarded(logger, 'acción', (a: number, b: number) => a + b);

		expect(wrapped(2, 3)).toBe(5);
		expect(logger.recent()).toHaveLength(0);
	});

	it('caza también una promesa rechazada, y la promesa devuelta no queda rota', async () => {
		const logger = silentLogger();
		const wrapped = guarded(logger, 'acción asíncrona', async () => {
			await Promise.resolve();
			throw new Error('falló tarde');
		});

		await expect(wrapped()).resolves.toBeUndefined();

		expect(logger.recent()[0]?.data).toMatchObject({
			action: 'acción asíncrona',
			asynchronous: true,
			message: 'falló tarde',
		});
	});

	it('no apunta el stack salvo en `debug`', () => {
		const normal = silentLogger('info');
		const verbose = silentLogger('debug');

		guarded(normal, 'acción', () => {
			throw pluginError();
		})();
		guarded(verbose, 'acción', () => {
			throw pluginError();
		})();

		expect(normal.recent()[0]?.data).not.toHaveProperty('stack');
		expect(verbose.recent()[0]?.data).toHaveProperty('stack');
	});
});

describe('isFromPlugin', () => {
	it('reconoce el stack de este plugin', () => {
		expect(isFromPlugin(pluginError().stack)).toBe(true);
	});

	it('no reconoce el de otro plugin ni la falta de stack', () => {
		expect(isFromPlugin('at OtroPlugin (plugin:dataview:10:2)')).toBe(false);
		expect(isFromPlugin(undefined)).toBe(false);
	});
});

describe('unhandledEvent', () => {
	it('apunta lo que viene de este plugin', () => {
		const entry = unhandledEvent(pluginError(), { asynchronous: true, debug: false });

		expect(entry?.message).toBe('Promesa rechazada sin recoger');
		expect(entry?.data).toMatchObject({ fromPlugin: true, message: 'se rompió' });
	});

	it('descarta lo ajeno cuando el nivel no es `debug`', () => {
		const ajeno = new Error('de otro');
		ajeno.stack = 'Error: de otro\n    at Otro (plugin:dataview:1:1)';

		expect(unhandledEvent(ajeno, { asynchronous: false, debug: false })).toBeNull();
	});

	it('en `debug` apunta todo, también lo que no trae stack', () => {
		const entry = unhandledEvent('un texto suelto', { asynchronous: false, debug: true });

		expect(entry?.message).toBe('Error no gestionado en la ventana');
		expect(entry?.data).toMatchObject({ fromPlugin: false, message: 'un texto suelto' });
	});

	it('guarda el fichero de origen cuando lo hay', () => {
		const entry = unhandledEvent(pluginError(), {
			asynchronous: false,
			debug: false,
			source: 'app://obsidian.md/plugin.js',
		});

		expect(entry?.data).toMatchObject({ source: 'app://obsidian.md/plugin.js' });
	});
});
