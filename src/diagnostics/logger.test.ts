import { describe, expect, it, vi } from 'vitest';

import {
	formatEvent,
	isLogLevel,
	Logger,
	shortTitle,
	type LogConsole,
	type LogEvent,
	type LogLevel,
} from './logger';
import { REDACTED } from './redact';

/** Consola espiable, para poder afirmar qué llega y qué se filtra. */
function fakeConsole(): LogConsole & { calls: { level: LogLevel; args: unknown[] }[] } {
	const calls: { level: LogLevel; args: unknown[] }[] = [];
	const push =
		(level: LogLevel) =>
		(...args: unknown[]): void => {
			calls.push({ level, args });
		};
	return {
		calls,
		debug: push('debug'),
		info: push('info'),
		warn: push('warn'),
		error: push('error'),
	};
}

function loggerWith(options: Parameters<typeof Logger.create>[0] = {}): Logger {
	return Logger.create({ console: null, now: () => new Date(0), ...options });
}

describe('Logger: niveles', () => {
	it('la consola solo recibe lo que llega al nivel elegido', () => {
		const target = fakeConsole();
		const logger = loggerWith({ console: target, level: 'warn' });

		logger.debug('uno');
		logger.info('dos');
		logger.warn('tres');
		logger.error('cuatro');

		expect(target.calls.map((call) => call.level)).toEqual(['warn', 'error']);
	});

	it('el BUFFER se llena con todo, con independencia del nivel', () => {
		const logger = loggerWith({ level: 'error' });

		logger.debug('uno');
		logger.info('dos');
		logger.error('tres');

		expect(logger.recent().map((event) => event.message)).toEqual(['uno', 'dos', 'tres']);
	});

	it('cambiar el nivel cambia lo que ve la consola, no lo guardado', () => {
		const target = fakeConsole();
		const logger = loggerWith({ console: target, level: 'error' });

		logger.info('antes');
		logger.setLevel('debug');
		logger.info('después');

		expect(target.calls).toHaveLength(1);
		expect(logger.size()).toBe(2);
	});

	it('`enabled` dice si ese nivel llega a la consola', () => {
		const logger = loggerWith({ level: 'info' });

		expect(logger.enabled('debug')).toBe(false);
		expect(logger.enabled('info')).toBe(true);
		expect(logger.enabled('error')).toBe(true);
	});

	it('el prefijo de la consola lleva el módulo', () => {
		const target = fakeConsole();
		const logger = loggerWith({ console: target, level: 'debug' }).child('queue');

		logger.info('hola', { id: 'op-1' });

		expect(target.calls[0]?.args).toEqual(['[Lumbre][queue]', 'hola', { id: 'op-1' }]);
	});
});

describe('Logger: buffer circular', () => {
	it('conserva los últimos y tira los primeros', () => {
		const logger = loggerWith({ bufferSize: 3 });

		for (const message of ['a', 'b', 'c', 'd', 'e']) logger.info(message);

		expect(logger.recent().map((event) => event.message)).toEqual(['c', 'd', 'e']);
		expect(logger.size()).toBe(3);
	});

	it('`recent(n)` devuelve los n últimos, del más viejo al más nuevo', () => {
		const logger = loggerWith();

		for (const message of ['a', 'b', 'c']) logger.info(message);

		expect(logger.recent(2).map((event) => event.message)).toEqual(['b', 'c']);
	});

	it('el contador `seq` no se reinicia al desbordar el buffer', () => {
		const logger = loggerWith({ bufferSize: 2 });

		for (const message of ['a', 'b', 'c']) logger.info(message);

		expect(logger.recent().map((event) => event.seq)).toEqual([2, 3]);
	});

	it('`clear` vacía lo guardado', () => {
		const logger = loggerWith();
		logger.info('a');

		logger.clear();

		expect(logger.recent()).toEqual([]);
	});
});

describe('Logger: child', () => {
	it('etiqueta el módulo y comparte el MISMO buffer que el padre', () => {
		const root = loggerWith();
		const http = root.child('http');
		const queue = root.child('queue');

		http.info('petición');
		queue.info('encolada');

		expect(root.recent().map((event) => event.module)).toEqual(['http', 'queue']);
		expect(http.recent()).toHaveLength(2);
	});

	it('el nivel es común: cambiarlo en un hijo lo cambia para todos', () => {
		const root = loggerWith({ level: 'info' });
		const child = root.child('http');

		child.setLevel('error');

		expect(root.level).toBe('error');
	});
});

describe('Logger: el registro no puede romper el plugin', () => {
	it('una consola que lanza no propaga y se cuenta como descartado', () => {
		const target = fakeConsole();
		target.info = (): never => {
			throw new Error('consola rota');
		};
		const logger = loggerWith({ console: target, level: 'debug' });

		expect(() => logger.info('hola')).not.toThrow();
		expect(logger.droppedEvents).toBe(1);
	});

	it('un sink que lanza no propaga y se cuenta', () => {
		const logger = loggerWith();
		logger.onEvent(() => {
			throw new Error('sink roto');
		});

		expect(() => logger.info('hola')).not.toThrow();
		expect(logger.droppedEvents).toBe(1);
		// El evento SÍ se guarda: lo que falló fue el sink, no el apunte.
		expect(logger.size()).toBe(1);
	});

	it('un `secrets` que lanza descarta el evento sin tumbar nada', () => {
		const logger = loggerWith({
			secrets: (): never => {
				throw new Error('sin token');
			},
		});

		expect(() => logger.info('hola')).not.toThrow();
		expect(logger.droppedEvents).toBe(1);
		expect(logger.size()).toBe(0);
	});
});

describe('Logger: limpieza', () => {
	it('el token no entra ni en el mensaje ni en los datos', () => {
		const token = 'lum_tok_9f8e7d6c5b4a3210';
		const logger = loggerWith({ secrets: () => [token] });

		logger.info(`falló con ${token}`, { headers: { Authorization: `Bearer ${token}` } });

		const dumped = JSON.stringify(logger.recent());
		expect(dumped).not.toContain(token);
		expect(dumped).toContain(REDACTED);
	});
});

describe('Logger: sinks', () => {
	it('el sink recibe cada evento y la baja lo desengancha', () => {
		const logger = loggerWith();
		const seen: LogEvent[] = [];
		const off = logger.onEvent((event) => seen.push(event));

		logger.warn('uno');
		off();
		logger.warn('dos');

		expect(seen.map((event) => event.message)).toEqual(['uno']);
	});
});

describe('Ayudas del registro', () => {
	it('`formatEvent` pone la marca de tiempo, el nivel, el módulo y los datos', () => {
		const logger = loggerWith().child('http');
		logger.warn('Petición lenta', { ms: 4000 });
		const [event] = logger.recent();

		expect(formatEvent(event as LogEvent)).toBe(
			'1970-01-01T00:00:00.000Z WARN  [http] Petición lenta {"ms":4000}',
		);
	});

	it('`shortTitle` recorta a 80 caracteres', () => {
		expect(shortTitle('corto')).toBe('corto');
		expect(shortTitle('t'.repeat(200))).toHaveLength(80);
	});

	it('`isLogLevel` acepta los cuatro y rechaza lo demás', () => {
		expect(isLogLevel('debug')).toBe(true);
		expect(isLogLevel('verbose')).toBe(false);
		expect(isLogLevel(undefined)).toBe(false);
	});

	it('el reloj es inyectable', () => {
		const now = vi.fn(() => new Date('2026-09-03T10:00:00.000Z'));
		const logger = loggerWith({ now });

		logger.info('hola');

		expect(logger.recent()[0]?.ts).toBe('2026-09-03T10:00:00.000Z');
	});
});
