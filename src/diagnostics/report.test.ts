import { describe, expect, it } from 'vitest';

import type { LumbreTaskLink } from '../links/link-store';
import type { QueuedOperation } from '../lumbre/queue';
import type { LumbreTask } from '../lumbre/types';
import { Logger, type LogEvent } from './logger';
import { buildReport, type ReportInput } from './report';

const TOKEN = 'lum_tok_9f8e7d6c5b4a3210';

function task(): LumbreTask {
	return {
		id: 'task-1',
		content: 'Comprar pan',
		notes: null,
		date: null,
		someday: false,
		deadline: null,
		time: null,
		priority: 'p4',
		done: false,
		cancelledAt: null,
		archivedAt: null,
		list: null,
		section: null,
		rolloverCount: 0,
		parentId: null,
	};
}

function operation(overrides: Partial<QueuedOperation> = {}): QueuedOperation {
	return {
		id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
		deviceId: 'device-a',
		kind: 'status',
		state: 'sent',
		attempts: 1,
		error: null,
		createdAt: '2026-09-03T10:00:00.000Z',
		updatedAt: '2026-09-03T10:00:01.000Z',
		sentAt: '2026-09-03T10:00:01.000Z',
		taskId: 'task-1',
		done: true,
		target: { notePath: 'Cocina.md', label: 'Comprar pan', excerpt: null },
		...overrides,
	} as QueuedOperation;
}

function link(overrides: Partial<LumbreTaskLink> = {}): LumbreTaskLink {
	return {
		id: 'link-1',
		taskId: 'task-1',
		notePath: 'Cocina.md',
		label: 'Comprar pan',
		excerpt: null,
		task: task(),
		syncState: 'materialized',
		error: null,
		updatedAt: '2026-09-03T10:00:00.000Z',
		orphanedAt: null,
		...overrides,
	};
}

function events(): LogEvent[] {
	const logger = Logger.create({ console: null, now: () => new Date(0) });
	logger.child('http').info('Petición', { method: 'GET', path: '/api/tasks', status: 200 });
	return logger.recent();
}

function input(overrides: Partial<ReportInput> = {}): ReportInput {
	return {
		pluginVersion: '0.1.4',
		obsidianVersion: '1.13.1',
		platform: { mobile: false, desktop: true },
		apiOrigin: 'https://app.lumbre.pro',
		hasToken: true,
		connection: { at: '2026-09-03T10:00:00.000Z', ok: true },
		queue: [operation()],
		links: [link()],
		caches: [{ name: 'consultas de bloques', entries: 2, oldestFetchedAt: 1000 }],
		events: events(),
		droppedEvents: 0,
		generatedAt: new Date('2026-09-03T11:00:00.000Z'),
		now: 46_000,
		secrets: [],
		...overrides,
	};
}

describe('buildReport: la forma', () => {
	it('lleva todas las secciones', () => {
		const report = buildReport(input());

		for (const heading of ['## Entorno', '## Conexión', '## Cola', '## Vínculos', '## Cachés']) {
			expect(report).toContain(heading);
		}
		expect(report).toContain('# Diagnóstico de Lumbre para Obsidian');
		expect(report).toContain('Generado: 2026-09-03T11:00:00.000Z');
	});

	it('dice la versión, la plataforma y el origen', () => {
		const report = buildReport(input());

		expect(report).toContain('Plugin: 0.1.4');
		expect(report).toContain('Obsidian: 1.13.1');
		expect(report).toContain('Plataforma: escritorio (isMobile: no, isDesktop: sí)');
		expect(report).toContain('Origen de la API: https://app.lumbre.pro');
	});

	it('dice SI hay token, nunca cuál', () => {
		expect(buildReport(input())).toContain('Token configurado: sí');
		expect(buildReport(input({ hasToken: false }))).toContain('Token configurado: no');
	});

	it('resume la conexión, con su fallo si lo hubo', () => {
		expect(buildReport(input())).toContain('Última prueba: 2026-09-03T10:00:00.000Z · correcta');
		expect(
			buildReport(
				input({
					connection: { at: '2026-09-03T10:00:00.000Z', ok: false, reason: 'network' },
				}),
			),
		).toContain('falló: network');
		expect(buildReport(input({ connection: null }))).toContain('Sin ninguna prueba de conexión');
	});

	it('cuenta la cola por estado y detalla las 10 últimas', () => {
		const many = Array.from({ length: 12 }, (_value, index) =>
			operation({ id: `op-${index}`, state: index === 0 ? 'materialized' : 'sent' }),
		);

		const report = buildReport(input({ queue: many }));

		expect(report).toContain('Total: 12 · materialized: 1 · sent: 11');
		expect(report).toContain('Últimas 10 operaciones:');
		// La más vieja se queda fuera del detalle, pero cuenta en el resumen.
		expect(report).not.toContain('op-0 ·');
		expect(report).toContain('op-11');
	});

	it('detalla estado, intentos y motivo de cada operación', () => {
		const report = buildReport(
			input({ queue: [operation({ attempts: 3, error: 'No se pudo conectar con Lumbre.' })] }),
		);

		expect(report).toContain('status · aaaaaaaa · sent · intentos 3 · No se pudo conectar con Lumbre.');
	});

	it('cuenta los vínculos, los huérfanos y los que tienen error', () => {
		const report = buildReport(
			input({
				links: [
					link(),
					link({ id: 'link-2', notePath: 'Otra.md', orphanedAt: '2026-09-03T09:00:00.000Z' }),
					link({ id: 'link-3', error: 'no se pudo releer' }),
				],
			}),
		);

		expect(report).toContain('Total: 3 · notas distintas: 2 · huérfanos: 1 · con error: 1');
	});

	it('dice la edad de la entrada más vieja de cada caché', () => {
		const report = buildReport(input());

		expect(report).toContain('consultas de bloques: 2 entradas · la más vieja, de hace 45 s');
	});

	it('cuenta los eventos y los descartados', () => {
		const report = buildReport(input({ droppedEvents: 4 }));

		expect(report).toContain('## Eventos (1, descartados por el registro: 4)');
		expect(report).toContain('[http] Petición');
	});

	it('aguanta un plugin recién instalado, sin nada de nada', () => {
		const report = buildReport(
			input({ queue: [], links: [], caches: [], events: [], connection: null }),
		);

		expect(report).toContain('La cola está vacía.');
		expect(report).toContain('Ninguna nota tiene tareas vinculadas.');
		expect(report).toContain('El registro está vacío.');
	});
});

describe('buildReport: el token no sale por ningún lado', () => {
	it('ni desde el cliente, ni desde la cola, ni desde los vínculos, ni desde los eventos', () => {
		const logger = Logger.create({ console: null, secrets: () => [] });
		// A propósito SIN redactar al apuntarlo: el informe es la última barrera y
		// esto comprueba que la barrera existe, no que el logger la haga por él.
		logger.child('http').warn(`Petición fallida con ${TOKEN}`);

		const report = buildReport(
			input({
				// Alguien que pega el token donde no toca: en el origen.
				apiOrigin: `https://app.lumbre.pro/?t=${TOKEN}`,
				connection: { at: '2026-09-03T10:00:00.000Z', ok: false, reason: 'unauthorized' },
				queue: [operation({ error: `Rechazada con el token ${TOKEN}` })],
				links: [link({ label: `Nota con ${TOKEN}` })],
				events: logger.recent(),
				secrets: [TOKEN],
			}),
		);

		expect(report).not.toContain(TOKEN);
		expect(report).toContain('«token»');
	});

	it('tampoco sale el contenido de una nota vinculada', () => {
		const report = buildReport(
			input({ links: [link({ excerpt: 'texto privado de la nota', label: 'etiqueta privada' })] }),
		);

		expect(report).not.toContain('texto privado de la nota');
		expect(report).not.toContain('etiqueta privada');
	});
});
