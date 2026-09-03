/**
 * El bloque de código ```lumbre-brl```: el registro del día EN VIVO en una nota.
 *
 * Mismas tres reglas que el bloque ```lumbre```:
 *
 * - No toca el Markdown. El bloque pinta lo que hay en Lumbre al renderizar; el
 *   fichero de la nota se queda exactamente como estaba. El comando «insertar
 *   el BRL de hoy como texto» es otra cosa: ahí el usuario PIDE la foto fija.
 * - Sin red no se enseña un bloque vacío: la última lectura confirmada con su
 *   hora y una línea que dice que eso es lo que se está viendo.
 * - Una consulta que no se entiende pinta el problema en una línea y no rompe
 *   nada más de la nota.
 *
 * El Markdown del BRL lo pinta `MarkdownRenderer.render`, o sea el mismo motor
 * que el resto de la nota: los enlaces internos, las listas y las citas salen
 * como salen en cualquier otro sitio del vault.
 */

import { MarkdownRenderChild, MarkdownRenderer, Platform, setIcon, type App } from 'obsidian';

import { BRL_TODAY, parseBrlQuery } from '../brl/brl-ops';
import type { Logger } from '../diagnostics/logger';
import { logInvalidBlock } from './block-log';
import type { BrlCache, BrlSnapshot } from './brl-cache';

/** El lenguaje del bloque: ```lumbre-brl```. */
export const LUMBRE_BRL_BLOCK_LANGUAGE = 'lumbre-brl';

/**
 * Lo que el bloque necesita del plugin. Se declara aquí como interfaz para no
 * importar `main.ts` y crear un ciclo entre los dos módulos.
 */
export interface BrlBlockHost {
	cache: BrlCache;
	/**
	 * La app de Obsidian, que `MarkdownRenderChild` no trae y que
	 * `MarkdownRenderer.render` necesita para resolver los enlaces internos.
	 */
	app: App;
	/** Avisa cuando cambian la cola o los vínculos. Devuelve cómo desuscribirse. */
	onDataChange(listener: () => void): () => void;
	/** Registro de diagnóstico, ya etiquetado como `block`. */
	logger: Logger;
}

export class LumbreBrlBlock extends MarkdownRenderChild {
	private date: string | null = null;
	private snapshot: BrlSnapshot | null = null;
	private parseError: string | null = null;
	private unsubscribeCache: (() => void) | null = null;
	private unsubscribeData: (() => void) | null = null;
	private unloaded = false;

	constructor(
		containerEl: HTMLElement,
		private readonly source: string,
		private readonly notePath: string,
		private readonly host: BrlBlockHost,
	) {
		super(containerEl);
	}

	onload(): void {
		this.containerEl.addClass('lumbre-brl');
		this.containerEl.toggleClass('lumbre-brl--mobile', Platform.isMobile);

		const parsed = parseBrlQuery(this.source);
		if (!parsed.ok) {
			this.parseError = parsed.error;
			// Igual que en el bloque de tareas: el cuerpo de un bloque mal escrito
			// solo sale en `debug`, ver `logInvalidBlock`.
			logInvalidBlock(this.host.logger, 'Consulta del bloque de BRL no válida', {
				notePath: this.notePath,
				error: parsed.error,
				source: this.source,
			});
			this.render();
			return;
		}

		this.date = parsed.date;
		this.host.logger.info('Bloque de BRL montado', { notePath: this.notePath, date: parsed.date });
		this.unsubscribeData = this.host.onDataChange(() => {
			this.render();
		});
		this.unsubscribeCache = this.host.cache.subscribe(parsed.date, (snapshot) => {
			this.snapshot = snapshot;
			this.render();
		});
		this.snapshot = this.host.cache.peek(parsed.date);
		this.render();
		void this.start(parsed.date);
	}

	onunload(): void {
		this.unloaded = true;
		if (this.date !== null) {
			this.host.logger.debug('Bloque de BRL desmontado', {
				notePath: this.notePath,
				date: this.date,
			});
		}
		this.unsubscribeCache?.();
		this.unsubscribeCache = null;
		this.unsubscribeData?.();
		this.unsubscribeData = null;
		this.containerEl.empty();
	}

	private async start(date: string): Promise<void> {
		this.snapshot = await this.host.cache.get(date);
		if (this.unloaded) return;
		this.render();
	}

	private async refresh(): Promise<void> {
		const date = this.date;
		if (date === null) return;
		this.snapshot = await this.host.cache.get(date, true);
		if (this.unloaded) return;
		this.render();
	}

	// ── Pintado ──────────────────────────────────────────────────────────────

	private render(): void {
		const root = this.containerEl;
		root.empty();

		const error = this.parseError;
		if (error !== null) {
			root.createDiv({ cls: 'lumbre-brl__error', text: error });
			return;
		}

		this.renderHeader(root);
		this.renderBody(root);
		this.renderFooter(root);
	}

	private renderHeader(root: HTMLElement): void {
		const header = root.createDiv({ cls: 'lumbre-brl__header' });
		header.createDiv({
			cls: 'lumbre-brl__title',
			text: this.date === null || this.date === BRL_TODAY ? 'Registro de hoy' : `Registro del ${this.date}`,
		});

		const button = header.createEl('button', { cls: 'lumbre-button lumbre-brl__refresh' });
		const icon = button.createSpan({ cls: 'lumbre-button__icon' });
		setIcon(icon, 'refresh-cw');
		button.createSpan({ text: 'Actualizar' });
		button.disabled = this.date === null || this.snapshot?.loading === true;
		button.addEventListener('click', () => {
			void this.refresh();
		});
	}

	private renderBody(root: HTMLElement): void {
		const snapshot = this.snapshot;
		if (snapshot === null || (snapshot.fetchedAt === null && snapshot.error === null)) {
			root.createDiv({ cls: 'lumbre-empty', text: 'Cargando…' });
			return;
		}

		if (snapshot.fetchedAt === null) {
			// Todavía no ha habido ninguna lectura buena y la primera falló: no hay
			// nada anterior que enseñar, así que se enseña el motivo.
			root.createDiv({ cls: 'lumbre-brl__error', text: snapshot.error ?? 'Cargando…' });
			return;
		}

		const body = root.createDiv({ cls: 'lumbre-brl__body' });
		if (snapshot.markdown.trim().length === 0) {
			body.createDiv({ cls: 'lumbre-empty', text: 'El registro de este día está vacío.' });
			return;
		}

		// El mismo motor que el resto de la nota: enlaces internos, listas y citas
		// salen igual que en cualquier otro sitio del vault.
		void MarkdownRenderer.render(this.host.app, snapshot.markdown, body, this.notePath, this);
	}

	private renderFooter(root: HTMLElement): void {
		const snapshot = this.snapshot;
		const footer = root.createDiv({ cls: 'lumbre-brl__footer' });
		footer.setAttribute('aria-live', 'polite');

		if (snapshot === null) return;
		if (snapshot.fetchedAt !== null) {
			footer.createSpan({ text: `Datos de ${clockText(snapshot.fetchedAt)}` });
		}
		if (snapshot.error !== null && snapshot.fetchedAt !== null) {
			footer.createSpan({
				cls: 'lumbre-brl__stale',
				text: 'Sin conexión, mostrando la última lectura',
			});
		}
	}
}

/** `HH:MM` en la hora local del dispositivo. */
function clockText(epochMs: number): string {
	return new Date(epochMs).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
