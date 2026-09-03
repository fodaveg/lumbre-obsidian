/**
 * El informe de diagnóstico: un texto plano que se copia y se pega.
 *
 * Es lo que se le pide a alguien cuando algo falla en su Obsidian, así que
 * manda una regla por encima de todas: aquí no sale el token, ni una cabecera
 * `Authorization`, ni el contenido de una nota. Lo último se cumple por lo que
 * NO se pinta: de la cola salen ids, tipos y estados; de los vínculos, los
 * recuentos; de los eventos, lo que ya venía limpio del logger. Y al final el
 * texto entero vuelve a pasar por `stripSecrets`, que es la red de seguridad
 * para lo que se cuele por un camino nuevo.
 *
 * Módulo puro: no importa `obsidian` y no hace red. Quien lo llama (`main.ts`)
 * es quien reúne las piezas.
 */

import type { LumbreTaskLink } from '../links/link-store';
import type { PingRecord } from '../lumbre/client';
import type { OperationState, QueuedOperation } from '../lumbre/queue';
import { formatEvent, type LogEvent } from './logger';
import { stripSecrets } from './redact';

/** Eventos que lleva el informe si no se pide otra cosa. */
export const DEFAULT_REPORT_EVENTS = 300;

/** Operaciones de la cola que se detallan una a una. */
const QUEUE_DETAIL = 10;

/** Lo que se dice de una caché. La rellenan `QueryCache` y `BrlCache`. */
export interface CacheStats {
	/** Cómo se llama en el informe. */
	name: string;
	entries: number;
	/** Epoch ms de la lectura más VIEJA que sigue guardada, o `null`. */
	oldestFetchedAt: number | null;
}

export interface ReportInput {
	pluginVersion: string;
	/** `app.apiVersion` de Obsidian. */
	obsidianVersion: string;
	platform: { mobile: boolean; desktop: boolean };
	/** Origen de la API. Va SIN token: el token no viaja en la URL. */
	apiOrigin: string;
	/** Si hay token, nunca cuál. */
	hasToken: boolean;
	/** Última prueba de conexión conocida, o `null` si no ha habido ninguna. */
	connection: PingRecord | null;
	/** Operaciones de la cola de ESTE dispositivo. */
	queue: readonly QueuedOperation[];
	links: readonly LumbreTaskLink[];
	caches: readonly CacheStats[];
	/** Los últimos eventos del buffer, ya limpios por el logger. */
	events: readonly LogEvent[];
	/** Eventos que el logger no pudo apuntar. */
	droppedEvents: number;
	/** Cuándo se genera. Reloj inyectado, igual que en el resto del plugin. */
	generatedAt: Date;
	/** Epoch ms de ahora, para calcular la edad de las cachés. */
	now: number;
	/** Cadenas a tapar por si acaso. En el plugin, el token. */
	secrets?: readonly string[];
}

/** El informe entero, listo para pegar. */
export function buildReport(input: ReportInput): string {
	const lines: string[] = [];

	lines.push('# Diagnóstico de Lumbre para Obsidian');
	lines.push(`Generado: ${input.generatedAt.toISOString()}`);
	lines.push('');

	lines.push('## Entorno');
	lines.push(`Plugin: ${input.pluginVersion}`);
	lines.push(`Obsidian: ${input.obsidianVersion}`);
	lines.push(
		`Plataforma: ${input.platform.mobile ? 'móvil' : 'escritorio'} (isMobile: ${yesNo(
			input.platform.mobile,
		)}, isDesktop: ${yesNo(input.platform.desktop)})`,
	);
	lines.push(`Origen de la API: ${input.apiOrigin}`);
	lines.push(`Token configurado: ${yesNo(input.hasToken)}`);
	lines.push('');

	lines.push('## Conexión');
	lines.push(connectionLine(input.connection));
	lines.push('');

	lines.push('## Cola');
	lines.push(...queueLines(input.queue));
	lines.push('');

	lines.push('## Vínculos');
	lines.push(...linkLines(input.links));
	lines.push('');

	lines.push('## Cachés');
	if (input.caches.length === 0) lines.push('Ninguna.');
	for (const cache of input.caches) lines.push(cacheLine(cache, input.now));
	lines.push('');

	lines.push(
		`## Eventos (${input.events.length}, descartados por el registro: ${input.droppedEvents})`,
	);
	if (input.events.length === 0) lines.push('El registro está vacío.');
	for (const event of input.events) lines.push(formatEvent(event));
	lines.push('');

	// Red de seguridad: si un secreto se cuela por un camino nuevo, muere aquí.
	return stripSecrets(lines.join('\n'), input.secrets ?? []);
}

function connectionLine(ping: PingRecord | null): string {
	if (ping === null) return 'Sin ninguna prueba de conexión desde que arrancó Obsidian.';
	if (ping.ok) return `Última prueba: ${ping.at} · correcta`;
	const status = ping.status === undefined ? '' : ` (${ping.status})`;
	return `Última prueba: ${ping.at} · falló: ${ping.reason ?? 'desconocido'}${status}`;
}

function queueLines(operations: readonly QueuedOperation[]): string[] {
	if (operations.length === 0) return ['La cola está vacía.'];

	const counts = new Map<OperationState, number>();
	for (const operation of operations) {
		counts.set(operation.state, (counts.get(operation.state) ?? 0) + 1);
	}
	const summary = [...counts.entries()].map(([state, count]) => `${state}: ${count}`).join(' · ');

	const lines = [`Total: ${operations.length} · ${summary}`];
	const last = operations.slice(-QUEUE_DETAIL);
	lines.push(`Últimas ${last.length} operaciones:`);
	for (const operation of last) {
		const reason = operation.error === null ? '' : ` · ${operation.error}`;
		lines.push(
			`- ${operation.updatedAt} · ${operation.kind} · ${shortId(operation.id)} · ${
				operation.state
			} · intentos ${operation.attempts}${reason}`,
		);
	}
	return lines;
}

function linkLines(links: readonly LumbreTaskLink[]): string[] {
	if (links.length === 0) return ['Ninguna nota tiene tareas vinculadas.'];

	const orphans = links.filter((link) => link.orphanedAt !== null).length;
	const notes = new Set(links.map((link) => link.notePath)).size;
	const failing = links.filter((link) => link.error !== null).length;
	return [
		`Total: ${links.length} · notas distintas: ${notes} · huérfanos: ${orphans} · con error: ${failing}`,
	];
}

function cacheLine(cache: CacheStats, now: number): string {
	if (cache.entries === 0) return `${cache.name}: vacía`;
	if (cache.oldestFetchedAt === null) {
		return `${cache.name}: ${cache.entries} entradas, ninguna leída todavía`;
	}
	const seconds = Math.max(0, Math.round((now - cache.oldestFetchedAt) / 1000));
	return `${cache.name}: ${cache.entries} entradas · la más vieja, de hace ${seconds} s`;
}

/** Los ocho primeros caracteres de un UUID: bastan para casar dos líneas. */
function shortId(id: string): string {
	return id.slice(0, 8);
}

function yesNo(value: boolean): string {
	return value ? 'sí' : 'no';
}
