/**
 * Modal de «Mostrar diagnóstico».
 *
 * Enseña el resumen de estado y los últimos eventos en una lista monoespaciada,
 * con los mismos dos botones que los ajustes: copiar el informe y guardarlo en
 * el vault. Existe para el caso en el que el registro hay que verlo AHORA, sin
 * abrir los ajustes y sin la consola de desarrollo, que en móvil no hay.
 *
 * El modal no compone el informe ni lo guarda: recibe las dos funciones ya
 * hechas, igual que el resto de los modales del plugin.
 */

import { Modal, Notice, setIcon, type App } from 'obsidian';

import { formatEvent, type LogEvent } from './logger';

/** Eventos que se pintan. Más que esto no se lee en una lista. */
export const MODAL_EVENTS = 100;

export interface DiagnosticsModalOptions {
	/** Las dos líneas de estado: conexión y cola. */
	statusLines(): string[];
	/** Los últimos eventos, del más viejo al más nuevo. */
	events(count: number): LogEvent[];
	/** El informe entero, para copiar. */
	buildReport(): string;
	/** Guarda el informe en el vault y devuelve la ruta. */
	saveReport(): Promise<string>;
}

export class DiagnosticsModal extends Modal {
	constructor(
		app: App,
		private readonly options: DiagnosticsModalOptions,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass('lumbre-diagnostics');
		this.setTitle('Diagnóstico de Lumbre');

		const root = this.contentEl;
		root.empty();

		const status = root.createDiv({ cls: 'lumbre-diagnostics__status' });
		for (const line of this.options.statusLines()) status.createDiv({ text: line });

		const events = this.options.events(MODAL_EVENTS);
		root.createDiv({
			cls: 'lumbre-diagnostics__label',
			text:
				events.length === 0
					? 'El registro está vacío.'
					: `Últimos ${events.length} eventos, el más nuevo abajo`,
		});

		const list = root.createEl('pre', { cls: 'lumbre-diagnostics__events' });
		list.setAttribute('aria-label', 'Últimos eventos del registro');
		// Una sola cadena y no una línea por elemento: con 100 eventos, insertar
		// nodo a nodo son 100 recálculos de layout dentro de un modal.
		list.setText(events.map((event) => formatEvent(event)).join('\n'));

		const actions = root.createDiv({ cls: 'lumbre-diagnostics__actions' });
		this.button(actions, 'Copiar', 'copy', async () => {
			try {
				await navigator.clipboard.writeText(this.options.buildReport());
				new Notice('Registro copiado');
			} catch {
				new Notice('No se pudo copiar; prueba a guardarlo en el vault.');
			}
		});
		this.button(actions, 'Guardar', 'save', async () => {
			try {
				const path = await this.options.saveReport();
				new Notice(`Registro guardado en ${path}`);
			} catch {
				new Notice('No se pudo escribir el registro en el vault.');
			}
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private button(
		parent: HTMLElement,
		text: string,
		icon: string,
		onClick: () => Promise<void>,
	): void {
		const button = parent.createEl('button', { cls: 'lumbre-button' });
		const holder = button.createSpan({ cls: 'lumbre-button__icon' });
		setIcon(holder, icon);
		button.createSpan({ text });
		button.addEventListener('click', () => {
			void onClick();
		});
	}
}
