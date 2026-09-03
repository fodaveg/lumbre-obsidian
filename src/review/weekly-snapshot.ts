/**
 * La foto semanal de la revisión: la mitad de LEER, en texto de solo lectura.
 *
 * Qué es y qué no es. Lumbre manda sobre la tarea y el vault manda sobre la
 * nota, así que esto NO proyecta tareas ni las copia: compone un Markdown FIJO,
 * fechado en su cabecera, que el usuario pega a mano en su nota semanal y que
 * desde ese momento es texto suyo. Por eso no hay bloque en vivo, ni casillas, ni
 * estado nuevo que guardar. La otra mitad de la revisión (decidir, reprogramar)
 * es de la app de Lumbre, no de aquí.
 *
 * Las líneas son texto plano con un enlace, NUNCA `- [ ]`: una casilla de
 * Markdown en el vault es una tarea del vault, y eso serían dos fuentes de
 * verdad para lo mismo. Lo asevera `weekly-snapshot.test.ts` por la FORMA de las
 * líneas, no por lo que digan.
 *
 * Módulo puro salvo el cliente, que entra por inyección: no importa `obsidian`,
 * no toca el vault y no escribe nada. Se prueba entero con Vitest.
 */

import { describeFailure, MAX_TASKS_LIMIT, REQUESTS_PER_MINUTE_WARN, type LumbreClient } from '../lumbre/client';
import type { Logger } from '../diagnostics/logger';
import { taskDeepLinks, type LumbreTask } from '../lumbre/types';

export interface WeeklySnapshotDeps {
	client: Pick<LumbreClient, 'listTasks' | 'listLists'>;
	/**
	 * Espera entre las peticiones por lista. Va por inyección y sin valor por
	 * defecto a propósito: el temporizador de un plugin es `window.setTimeout` (lo
	 * exige el linter de Obsidian, por las ventanas emergentes) y `window` no
	 * existe en los tests. Así el módulo no depende de ninguna de las dos cosas.
	 */
	wait: (ms: number) => Promise<void>;
	/** Registro de diagnóstico. Sin él no se apunta nada. */
	logger?: Logger;
}

export interface WeeklySnapshotOptions {
	/** Momento de la foto, el que va en la cabecera. Por defecto, ahora. */
	now?: Date;
	/** Cuántas tareas de «Algún día» se enseñan. */
	somedaySample?: number;
	/**
	 * Semilla de la muestra. Por defecto el DÍA de `now`, que es lo que hace que
	 * dos ejecuciones de la misma jornada den la misma muestra.
	 */
	seed?: string;
	/** Veces rodada a partir de las cuales una tarea sale como arrastrada. */
	rolloverThreshold?: number;
}

/** El Markdown y cuántos de sus apartados no se han podido leer. */
export interface WeeklySnapshot {
	markdown: string;
	/** Apartados que se han quedado sin datos por un fallo de lectura. */
	failures: number;
	/** Apartados en total. Con `failures === sections` no se ha leído NADA. */
	sections: number;
}

/** Tareas de «Algún día» que se enseñan de muestra. */
export const SOMEDAY_SAMPLE_SIZE = 5;

/** Veces rodada a partir de las cuales una tarea cuenta como arrastrada. */
export const ROLLOVER_THRESHOLD = 3;

/**
 * Espera entre las peticiones por lista. Sale del aviso de ritmo del cliente
 * (`REQUESTS_PER_MINUTE_WARN`, hoy 100), no de un número a ojo: el límite del
 * servidor es 120/min y este apartado gasta una petición por lista, así que sin
 * intervalo un vault con 40 listas se comería los 429 de golpe.
 */
export const LIST_REQUEST_INTERVAL_MS = Math.ceil(60_000 / REQUESTS_PER_MINUTE_WARN);

/** Lo que se pinta cuando un apartado no tiene nada que decir. */
const EMPTY_SECTION = 'Nada';

/**
 * El Markdown de la foto semanal. Es lo que expone la API pública como
 * `api.weeklySnapshot()`, para poder llamarlo desde una plantilla de Templater.
 */
export async function buildWeeklySnapshot(
	deps: WeeklySnapshotDeps,
	options: WeeklySnapshotOptions = {},
): Promise<string> {
	const snapshot = await collectWeeklySnapshot(deps, options);
	return snapshot.markdown;
}

/**
 * Como `buildWeeklySnapshot`, pero diciendo además cuántos apartados se han
 * quedado sin leer. Lo usa el comando, que con TODO en rojo prefiere no pegar
 * nada antes que dejar tres líneas de error dentro de la nota.
 */
export async function collectWeeklySnapshot(
	deps: WeeklySnapshotDeps,
	options: WeeklySnapshotOptions = {},
): Promise<WeeklySnapshot> {
	const now = options.now ?? new Date();
	const sections = [
		await staleSection(deps, options),
		await listsWithoutNextActionSection(deps),
		await somedaySection(deps, options, now),
	];

	const lines: string[] = [
		`## Foto del ${formatStamp(now)}`,
		'',
		'Texto de solo lectura y de este momento. Las tareas viven en Lumbre.',
	];
	for (const section of sections) {
		lines.push('', `### ${section.title}`, '');
		lines.push(...(section.lines.length === 0 ? [EMPTY_SECTION] : section.lines));
	}

	const failures = sections.filter((section) => section.failed).length;
	deps.logger?.info('Foto semanal compuesta', {
		sections: sections.length,
		failures,
		rows: sections.reduce((total, section) => total + section.lines.length, 0),
	});

	return { markdown: `${lines.join('\n')}\n`, failures, sections: sections.length };
}

/** Un apartado ya resuelto: sus líneas y si se ha quedado sin datos. */
interface Section {
	title: string;
	lines: string[];
	failed: boolean;
}

// ── Vencidas y arrastradas ─────────────────────────────────────────────────

/**
 * Lo vencido más lo que lleva rodando. Son dos lecturas: `scope: overdue`, que
 * la resuelve el servidor con la zona horaria de la cuenta, y `scope: all` para
 * mirar el `rolloverCount` de todo lo vivo, que ningún scope filtra por él.
 *
 * Si NINGUNA tarea de esa segunda lectura trae el campo, el apartado lo DICE en
 * vez de contar cero arrastradas: contra un Lumbre anterior al SHA `861cfb4d`
 * "no viene el campo" y "no ha rodado nunca" se verían igual, y el segundo es
 * mentira. La distinción la sostiene `LumbreTask.rolloverCount`, que va ausente
 * cuando la fila cruda no lo traía.
 */
async function staleSection(
	deps: WeeklySnapshotDeps,
	options: WeeklySnapshotOptions,
): Promise<Section> {
	const title = 'Vencidas y arrastradas';
	const threshold = options.rolloverThreshold ?? ROLLOVER_THRESHOLD;

	const overdue = await deps.client.listTasks({ scope: 'overdue', notes: 'none', limit: MAX_TASKS_LIMIT });
	if (!overdue.ok) {
		return failedSection(title, 'las vencidas', describeFailure(overdue.reason, overdue.status));
	}

	const lines: string[] = [];
	const seen = new Set<string>();
	for (const task of overdue.value.filter(isPending)) {
		seen.add(task.id);
		lines.push(taskLine(task, threshold));
	}

	const pool = await deps.client.listTasks({ scope: 'all', notes: 'none', limit: MAX_TASKS_LIMIT });
	if (!pool.ok) {
		lines.push(`Arrastradas: ${describeFailure(pool.reason, pool.status)}`);
		return { title, lines, failed: false };
	}

	const live = pool.value.filter(isPending);
	const reported = live.some((task) => task.rolloverCount !== undefined);
	if (live.length > 0 && !reported) {
		lines.push('Arrastradas: este Lumbre no lo informa.');
		return { title, lines, failed: false };
	}

	for (const task of live) {
		if (seen.has(task.id) || (task.rolloverCount ?? 0) < threshold) continue;
		seen.add(task.id);
		lines.push(taskLine(task, threshold));
	}
	return { title, lines, failed: false };
}

// ── Listas sin próxima acción ──────────────────────────────────────────────

/**
 * Las listas con tareas pendientes y NINGUNA con fecha. Una petición por lista y
 * en serie, con `LIST_REQUEST_INTERVAL_MS` entre medias: el endpoint no sabe
 * agrupar por lista, así que el agrupado es de aquí.
 *
 * No se saltan las listas con `taskCount: 0`: ese campo también sale en cero
 * contra un servidor que no lo manda, y usarlo para ahorrar peticiones dejaría
 * el apartado vacío justo donde más falta hace.
 */
async function listsWithoutNextActionSection(deps: WeeklySnapshotDeps): Promise<Section> {
	const title = 'Listas sin próxima acción';

	const lists = await deps.client.listLists();
	if (!lists.ok) {
		return failedSection(title, 'las listas', describeFailure(lists.reason, lists.status));
	}

	const lines: string[] = [];
	const unreadable: string[] = [];
	for (const [index, list] of lists.value.entries()) {
		if (index > 0) await deps.wait(LIST_REQUEST_INTERVAL_MS);
		const read = await deps.client.listTasks({ list: list.name, scope: 'all', notes: 'none', limit: MAX_TASKS_LIMIT });
		if (!read.ok) {
			unreadable.push(oneLine(list.name));
			continue;
		}
		const pending = read.value.filter(isPending);
		if (pending.length === 0 || pending.some((task) => task.date !== null)) continue;
		lines.push(
			`- ${oneLine(list.name)} · ${pending.length} ${pending.length === 1 ? 'pendiente' : 'pendientes'}`,
		);
	}

	if (unreadable.length > 0) lines.push(`No se han podido leer: ${unreadable.join(', ')}.`);
	return { title, lines, failed: false };
}

// ── Muestra de Algún día ───────────────────────────────────────────────────

/**
 * Cinco tareas de «Algún día», elegidas con una semilla del DÍA: dos ejecuciones
 * de la misma jornada dan la misma muestra, y la de mañana es otra. No es azar
 * de verdad a propósito, porque una muestra que cambia a cada clic invita a
 * volver a tirar hasta que salga algo cómodo.
 */
async function somedaySection(
	deps: WeeklySnapshotDeps,
	options: WeeklySnapshotOptions,
	now: Date,
): Promise<Section> {
	const title = 'Muestra de Algún día';

	const read = await deps.client.listTasks({ scope: 'someday', notes: 'none', limit: MAX_TASKS_LIMIT });
	if (!read.ok) {
		return failedSection(title, 'Algún día', describeFailure(read.reason, read.status));
	}

	const sample = sampleTasks(
		read.value.filter(isPending),
		options.seed ?? dayOf(now),
		options.somedaySample ?? SOMEDAY_SAMPLE_SIZE,
	);
	// Umbral infinito: aquí NUNCA se pone el «arrastrada N veces». Lo aparcado en
	// «Algún día» no tiene fecha que rodar, así que ese dato sobra en este apartado.
	const lines = sample.map((task) => taskLine(task, Number.POSITIVE_INFINITY));
	return { title, lines, failed: false };
}

/**
 * La muestra estable: se ordena por el hash de `semilla + id` y se cogen las
 * primeras. Ordenar por hash en vez de barajar es lo que hace que el resultado
 * dependa SOLO de la semilla y de los ids, no del orden en que llegaron.
 */
export function sampleTasks(tasks: LumbreTask[], seed: string, size: number): LumbreTask[] {
	return tasks
		.map((task) => ({ task, key: hash(`${seed} ${task.id}`) }))
		.sort((left, right) => left.key - right.key || compareText(left.task.id, right.task.id))
		.slice(0, Math.max(0, size))
		.map((entry) => entry.task);
}

// ── Piezas comunes ─────────────────────────────────────────────────────────

/**
 * La línea de una tarea: título, lista, fecha y el enlace para abrirla. Empieza
 * por `- `, que es una viñeta; NUNCA por `- [ ]`, que sería una tarea del vault.
 */
function taskLine(task: LumbreTask, rolloverThreshold: number): string {
	const parts = [
		plainTitle(task.content),
		task.list === null ? 'sin lista' : oneLine(task.list.name),
		task.someday ? 'Algún día' : (task.date ?? 'sin fecha'),
	];
	const rollover = task.rolloverCount;
	if (rollover !== undefined && rollover >= rolloverThreshold) {
		parts.push(`arrastrada ${rollover} ${rollover === 1 ? 'vez' : 'veces'}`);
	}
	parts.push(`[Abrir](${taskDeepLinks(task).native})`);
	return `- ${parts.join(' · ')}`;
}

/** Un apartado que no se ha podido leer. Lo dice, en vez de salir vacío. */
function failedSection(title: string, what: string, reason: string): Section {
	return { title, lines: [`No se han podido leer ${what}: ${reason}`], failed: true };
}

/** Viva y sin completar. Es lo único que tiene sentido enseñar en una revisión. */
function isPending(task: LumbreTask): boolean {
	return !task.done && task.cancelledAt === null && task.archivedAt === null;
}

/**
 * El título en UNA línea y sin marcador de casilla delante. Lo segundo no es
 * cosmético: una tarea que se llame «[ ] Comprar pan» produciría la línea
 * `- [ ] Comprar pan`, o sea justo la casilla de Markdown que este plugin no
 * escribe nunca.
 */
export function plainTitle(raw: string): string {
	const line = oneLine(raw).replace(/^(?:[-*+]\s*)?\[[ xX]\]\s*/, '');
	return line.length === 0 ? 'Sin título' : line;
}

/** Todo el espacio en blanco colapsado: una línea de la foto es UNA línea. */
function oneLine(raw: string): string {
	return raw.replace(/\s+/g, ' ').trim();
}

/** `YYYY-MM-DD a las HH:MM`, con el reloj LOCAL, que es el que ve quien la pega. */
function formatStamp(now: Date): string {
	return `${dayOf(now)} a las ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/** El día local `YYYY-MM-DD`. Es también la semilla por defecto de la muestra. */
export function dayOf(now: Date): string {
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function pad(value: number): string {
	return String(value).padStart(2, '0');
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/** FNV-1a de 32 bits. No hace falta nada mejor: solo tiene que repartir y no cambiar. */
function hash(text: string): number {
	let value = 0x811c9dc5;
	for (let index = 0; index < text.length; index += 1) {
		value ^= text.charCodeAt(index);
		value = Math.imul(value, 0x01000193);
	}
	return value >>> 0;
}
