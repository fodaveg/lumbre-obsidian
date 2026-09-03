/**
 * Registro de diagnóstico del plugin.
 *
 * Para qué existe: cuando algo falla en el Obsidian de alguien, lo único que se
 * puede pedir es que copie un texto y lo pegue. Ese texto tiene que decir QUÉ
 * pasó, DÓNDE y con qué datos, y no puede llevar ni el token ni el contenido de
 * sus notas.
 *
 * Salida DOBLE, y esa es la decisión que manda sobre este fichero:
 *
 * - A la consola, filtrada por el nivel elegido en Ajustes (`info` por defecto).
 * - A un buffer circular de 1000 eventos, SIEMPRE, con independencia del nivel.
 *   Así «Copiar registro» tras un fallo trae también los `debug` de antes, que
 *   son justo los que hacen falta y que nadie tenía activados cuando pasó.
 *
 * El logger no puede romper el plugin: todo lo de `event()` va dentro de un
 * try/catch, y lo que se caiga se cuenta en `droppedEvents` y sale en el
 * informe. Un registro que tumba la aplicación es peor que no tener registro.
 *
 * Módulo puro: no importa `obsidian`. La consola y el reloj entran por
 * inyección, así que se prueba entero con Vitest.
 */

import { redact, redactText } from './redact';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** De menos a más grave. El orden ES el filtro de la consola. */
export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Nivel que trae el plugin de fábrica. */
export const DEFAULT_LOG_LEVEL: LogLevel = 'info';

/** Etiqueta legible de cada nivel, para el desplegable de Ajustes. */
export const LOG_LEVEL_LABELS: Record<LogLevel, string> = {
	debug: 'Todo (debug)',
	info: 'Normal (info)',
	warn: 'Solo avisos',
	error: 'Solo errores',
};

/** Las piezas del plugin que escriben en el registro. */
export type LogModule =
	| 'http'
	| 'queue'
	| 'links'
	| 'cache'
	| 'block'
	| 'panel'
	| 'modal'
	| 'api'
	| 'settings'
	| 'vault'
	| 'main';

export const LOG_MODULES: readonly LogModule[] = [
	'http',
	'queue',
	'links',
	'cache',
	'block',
	'panel',
	'modal',
	'api',
	'settings',
	'vault',
	'main',
];

/** Datos de un evento: objeto plano, pequeño y serializable. */
export type LogData = Record<string, unknown>;

export interface LogEvent {
	/** Contador, para ver de un vistazo si falta algo entre dos líneas. */
	seq: number;
	/** ISO 8601. */
	ts: string;
	level: LogLevel;
	module: LogModule;
	message: string;
	data?: LogData;
}

/** Lo que el logger necesita de la consola. En el plugin es `console`. */
export interface LogConsole {
	debug(...args: unknown[]): void;
	info(...args: unknown[]): void;
	warn(...args: unknown[]): void;
	error(...args: unknown[]): void;
}

/** Quien quiere ver cada evento según se produce (el registro en fichero). */
export type LogSink = (event: LogEvent) => void;

/** Eventos que caben en el buffer circular. */
export const LOG_BUFFER_SIZE = 1000;

export interface LoggerOptions {
	/** Nivel de la CONSOLA. El buffer se llena igual con todo. */
	level?: LogLevel;
	bufferSize?: number;
	/** Reloj, inyectable para los tests. */
	now?: () => Date;
	/** Consola de salida, o `null` para no escribir en ninguna. */
	console?: LogConsole | null;
	/** Cadenas que hay que tapar en todo lo que se registre (el token). */
	secrets?: () => readonly string[];
}

/** El estado que comparten un logger y todos sus hijos. */
interface LoggerCore {
	level: LogLevel;
	bufferSize: number;
	buffer: LogEvent[];
	seq: number;
	dropped: number;
	now: () => Date;
	console: LogConsole | null;
	secrets: () => readonly string[];
	sinks: Set<LogSink>;
}

export class Logger {
	private constructor(
		private readonly core: LoggerCore,
		/** Etiqueta del módulo que escribe, la que sale en `[Lumbre][queue]`. */
		readonly module: LogModule,
	) {}

	/** El logger raíz del plugin. Los módulos cuelgan de él con `child()`. */
	static create(options: LoggerOptions = {}): Logger {
		const core: LoggerCore = {
			level: options.level ?? DEFAULT_LOG_LEVEL,
			bufferSize: options.bufferSize ?? LOG_BUFFER_SIZE,
			buffer: [],
			seq: 0,
			dropped: 0,
			now: options.now ?? ((): Date => new Date()),
			console: options.console === undefined ? console : options.console,
			secrets: options.secrets ?? ((): readonly string[] => []),
			sinks: new Set(),
		};
		return new Logger(core, 'main');
	}

	/**
	 * Otro logger con la misma memoria, etiquetado con su módulo. El buffer, el
	 * nivel y el contador son los MISMOS: un registro por plugin, no uno por
	 * pieza, porque lo que se pega en un informe es la secuencia entera.
	 */
	child(module: LogModule): Logger {
		return new Logger(this.core, module);
	}

	/** Nivel de la consola. */
	get level(): LogLevel {
		return this.core.level;
	}

	setLevel(level: LogLevel): void {
		this.core.level = level;
	}

	/** `true` si ese nivel llega a la consola. Sirve para no calcular datos caros. */
	enabled(level: LogLevel): boolean {
		return LEVEL_RANK[level] >= LEVEL_RANK[this.core.level];
	}

	/** Eventos que el logger no pudo apuntar. Sale en el informe. */
	get droppedEvents(): number {
		return this.core.dropped;
	}

	/** Los últimos N eventos del buffer, del más viejo al más nuevo. */
	recent(count = LOG_BUFFER_SIZE): LogEvent[] {
		if (count >= this.core.buffer.length) return [...this.core.buffer];
		return this.core.buffer.slice(this.core.buffer.length - count);
	}

	/** Cuántos eventos hay guardados ahora mismo. */
	size(): number {
		return this.core.buffer.length;
	}

	/** Vacía el buffer. Lo usa el botón de «Vaciar registro». */
	clear(): void {
		this.core.buffer = [];
	}

	/**
	 * Se apunta a cada evento según se produce. Lo usa el registro en fichero,
	 * que filtra por su cuenta lo que le interesa. Devuelve cómo darse de baja.
	 */
	onEvent(sink: LogSink): () => void {
		this.core.sinks.add(sink);
		return (): void => {
			this.core.sinks.delete(sink);
		};
	}

	/**
	 * Apunta un evento. Nunca lanza: si algo falla aquí dentro (un `data` que no
	 * se puede recorrer, una consola que revienta), se cuenta y se sigue.
	 */
	event(level: LogLevel, message: string, data?: LogData): void {
		try {
			const secrets = this.core.secrets();
			const event: LogEvent = {
				seq: (this.core.seq += 1),
				ts: this.core.now().toISOString(),
				level,
				module: this.module,
				message: redactText(message, secrets),
			};
			const cleaned = data === undefined ? undefined : redact(data, secrets);
			if (cleaned !== undefined && cleaned !== null) event.data = cleaned as LogData;

			this.push(event);
			this.toConsole(event);
			this.toSinks(event);
		} catch {
			// Un fallo del propio registro no puede tumbar al plugin. Se cuenta y
			// aparece en el informe, que es donde se puede ver que faltan líneas.
			this.core.dropped += 1;
		}
	}

	debug(message: string, data?: LogData): void {
		this.event('debug', message, data);
	}

	info(message: string, data?: LogData): void {
		this.event('info', message, data);
	}

	warn(message: string, data?: LogData): void {
		this.event('warn', message, data);
	}

	error(message: string, data?: LogData): void {
		this.event('error', message, data);
	}

	private push(event: LogEvent): void {
		this.core.buffer.push(event);
		// Circular: los viejos caen por delante. Se hace con `splice` y no con un
		// `shift` por evento para que un buffer redimensionado a menos también se
		// recorte de golpe.
		const excess = this.core.buffer.length - this.core.bufferSize;
		if (excess > 0) this.core.buffer.splice(0, excess);
	}

	private toConsole(event: LogEvent): void {
		const target = this.core.console;
		if (target === null || !this.enabled(event.level)) return;

		const prefix = `[Lumbre][${event.module}]`;
		if (event.data === undefined) target[event.level](prefix, event.message);
		else target[event.level](prefix, event.message, event.data);
	}

	private toSinks(event: LogEvent): void {
		for (const sink of this.core.sinks) {
			try {
				sink(event);
			} catch {
				this.core.dropped += 1;
			}
		}
	}
}

/** `true` si el valor es uno de los cuatro niveles. Para leer los ajustes. */
export function isLogLevel(value: unknown): value is LogLevel {
	return typeof value === 'string' && LOG_LEVELS.includes(value as LogLevel);
}

/** Tope del título de una tarea dentro de un evento. */
export const MAX_TITLE_LENGTH = 80;

/**
 * El título de una tarea recortado, para un evento de `debug`. El título lo ha
 * escrito el usuario, así que solo se apunta en `debug` y nunca entero: en
 * `info` van los ids y los recuentos, que es lo que hace falta para seguir el
 * rastro sin llevarse texto suyo al informe.
 */
export function shortTitle(text: string, max = MAX_TITLE_LENGTH): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Una línea de texto de un evento, la del informe y la del fichero en vivo. */
export function formatEvent(event: LogEvent): string {
	const head = `${event.ts} ${event.level.toUpperCase().padEnd(5)} [${event.module}] ${event.message}`;
	if (event.data === undefined) return head;
	return `${head} ${safeJson(event.data)}`;
}

/** El `data` en una línea, o un marcador si no se puede serializar. */
function safeJson(data: LogData): string {
	try {
		return JSON.stringify(data);
	} catch {
		return '[data no serializable]';
	}
}
