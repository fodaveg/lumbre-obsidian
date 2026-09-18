/**
 * Empuje a Lumbre de la url interna de la nota activa en Obsidian.
 *
 * Por qué existe (medido el 18 sep 2026 contra `/Applications/Obsidian.app`):
 * Obsidian es Electron y no tiene diccionario AppleScript, ni `.sdef`, ni
 * `NSAppleScriptEnabled` en su `Info.plist`. El lector de enlaces de Lumbre no
 * puede sacar la url de la nota activa por Apple Events, así que hace falta
 * que la empuje el plugin, con `LumbreClient.foregroundLink`
 * (`POST /api/foreground-link`).
 *
 * Módulo puro: no importa `obsidian`. Quien sabe el nombre del vault y qué
 * nota está activa es `main.ts`, que llama a `noteChanged` en cada
 * `active-leaf-change` y `file-open`.
 *
 * Dos decisiones tomadas aquí, sin pedirlas:
 *
 * - `FOREGROUND_LINK_DEBOUNCE_MS`: 800 ms. Navegar por el vault (un enlace
 *   tras otro, el buscador) cambia de nota activa varias veces en menos de un
 *   segundo; empujar en cada salto gastaría el cupo de 60/min en notas de
 *   paso que ya no están delante cuando alguien dispara la captura rápida.
 *   800 ms es holgado frente a un «clic, clic, clic» normal y sigue siendo
 *   invisible para quien se queda quieto en una nota: la ventana del servidor
 *   es de 120 s, con margen de sobra.
 * - Sin nota activa (un PDF, un lienzo, ninguna hoja abierta): NO se empuja
 *   nada, y el último valor aceptado se queda tal cual hasta que el servidor
 *   lo caduque solo. Entre las dos formas de fallar, empujar la url de una
 *   nota que ya no está delante es peor que no empujar: rellenaría la
 *   captura rápida con un enlace a algo que la persona no está mirando, y eso
 *   no se nota hasta que ya se ha guardado. Quedarse sin enlace es un fallo
 *   visible (el campo llega vacío) y no escribe nada incorrecto.
 */

import type { Logger } from '../diagnostics/logger';
import { buildObsidianDeepLink, noteLinkLabel } from '../links/deep-link';
import type { LumbreClient } from './client';

/** Ver el JSDoc de cabecera: por qué 800 ms y no menos ni más. */
export const FOREGROUND_LINK_DEBOUNCE_MS = 800;

/** La nota activa, tal y como la conoce `main.ts` a partir del `TFile`. */
export interface ForegroundLinkNote {
	/** Ruta completa, CON extensión, como la da Obsidian. */
	notePath: string;
	/** `TFile.basename`: el nombre sin ruta ni extensión. */
	basename: string;
}

export interface ForegroundLinkPusherOptions {
	client: Pick<LumbreClient, 'foregroundLink'>;
	/** `app.vault.getName()`. Se consulta en cada empuje, no una vez guardada. */
	vaultName: () => string;
	/** El ajuste de Ajustes. Apagado, `noteChanged` no programa ni empuja nada. */
	enabled: () => boolean;
	/**
	 * Espera inyectable para los tests, gemela de la de `QueryCache`. En el
	 * plugin real es `window.setTimeout`, porque en una ventana emergente de
	 * Obsidian el temporizador tiene que ser el de ESA ventana.
	 */
	wait?: (ms: number) => Promise<void>;
	/** Registro de diagnóstico. Sin él, el pusher no apunta nada. */
	logger?: Logger;
}

/**
 * Decide cuándo empujar y con qué debounce. Guarda en memoria la última url
 * que Lumbre aceptó: si la nota activa compone la MISMA url, no se gasta una
 * petición para repetir lo que el servidor ya tiene.
 */
export class ForegroundLinkPusher {
	private readonly client: Pick<LumbreClient, 'foregroundLink'>;
	private readonly vaultName: () => string;
	private readonly enabled: () => boolean;
	private readonly wait: (ms: number) => Promise<void>;
	private readonly log: Logger | null;

	/** La url del último empuje que Lumbre aceptó, o `null` hasta el primero. */
	private lastPushedUrl: string | null = null;

	/**
	 * Cuenta cada llamada a `noteChanged`. Es el debounce: cuando el temporizador
	 * de una llamada vieja se cumple, compara su número contra el actual, y si ya
	 * hay una más nueva en marcha se calla. Reemplaza a un `clearTimeout`, que
	 * `wait` (una promesa) no puede ofrecer.
	 */
	private generation = 0;

	constructor(options: ForegroundLinkPusherOptions) {
		this.client = options.client;
		this.vaultName = options.vaultName;
		this.enabled = options.enabled;
		this.wait =
			options.wait ??
			((ms: number): Promise<void> =>
				new Promise<void>((done) => {
					window.setTimeout(done, ms);
				}));
		this.log = options.logger ?? null;
	}

	/**
	 * La nota activa acaba de cambiar (o de dejar de haber ninguna). Programa el
	 * empuje tras el debounce; una llamada posterior antes de que se cumpla
	 * cancela esta de facto (ver `generation`). Devuelve la promesa del empuje
	 * para que los tests puedan esperarla; `main.ts` la llama con `void`.
	 */
	noteChanged(note: ForegroundLinkNote | null): Promise<void> {
		if (!this.enabled()) return Promise.resolve();
		const generation = ++this.generation;
		return this.schedule(generation, note);
	}

	private async schedule(generation: number, note: ForegroundLinkNote | null): Promise<void> {
		await this.wait(FOREGROUND_LINK_DEBOUNCE_MS);
		// Una llamada más nueva ya está en marcha (o ya ha empujado): esta se calla.
		if (generation !== this.generation) return;
		await this.push(note);
	}

	private async push(note: ForegroundLinkNote | null): Promise<void> {
		// Sin nota activa no se empuja nada: ver el JSDoc de cabecera.
		if (note === null) return;

		const url = buildObsidianDeepLink(this.vaultName(), note.notePath);
		if (url === this.lastPushedUrl) return;

		const result = await this.client.foregroundLink({
			url,
			title: noteLinkLabel(note.basename),
		});
		if (!result.ok) {
			// Se descarta en silencio: reintentar el mismo valor no arregla nada
			// (ver el JSDoc de `LumbreClient.foregroundLink`), y el siguiente cambio
			// de nota activa lo vuelve a intentar solo.
			this.log?.warn('No se pudo empujar el enlace de la nota activa', {
				reason: result.reason,
				status: result.status,
			});
			return;
		}

		this.lastPushedUrl = url;
		this.log?.debug('Enlace de la nota activa empujado a Lumbre', { notePath: note.notePath });
	}
}
