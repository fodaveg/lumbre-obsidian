import { describe, expect, it } from 'vitest';

import { Logger, type LogLevel } from '../diagnostics/logger';
import { logInvalidBlock } from './block-log';

const SOURCE = 'scope: hoy\nlo que escribí sin querer dentro del bloque';

function loggerAt(level: LogLevel): Logger {
	return Logger.create({ console: null, level });
}

describe('logInvalidBlock', () => {
	it('en info no se lleva el texto del bloque, solo cuánto ocupa', () => {
		const logger = loggerAt('info');

		logInvalidBlock(logger.child('block'), 'Consulta del bloque no válida', {
			notePath: 'Proyectos/Cocina.md',
			error: 'scope desconocido',
			source: SOURCE,
		});

		const [event] = logger.recent();
		expect(JSON.stringify(logger.recent())).not.toContain('sin querer');
		expect(event?.data).toMatchObject({
			notePath: 'Proyectos/Cocina.md',
			error: 'scope desconocido',
			sourceLength: SOURCE.length,
		});
	});

	it('en debug sí, que es cuando se está reproduciendo el fallo a propósito', () => {
		const logger = loggerAt('debug');

		logInvalidBlock(logger.child('block'), 'Consulta del bloque no válida', {
			notePath: 'Proyectos/Cocina.md',
			error: 'scope desconocido',
			source: SOURCE,
		});

		expect(logger.recent()[0]?.data).toMatchObject({ source: SOURCE });
	});
});
