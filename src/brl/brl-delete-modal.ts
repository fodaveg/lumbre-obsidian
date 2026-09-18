/**
 * Modal de confirmación al borrar una entrada del BRL.
 *
 * Borrar es la única acción del bloque `lumbre-brl` que PIDE confirmación: el
 * repo prohíbe un diálogo nativo del navegador (`confirm()`), así que esto es
 * lo mínimo que hace falta en su lugar. Enseña el texto de la entrada (sin su
 * marcador) para que quien confirma sepa qué está borrando, y no habla con la
 * red ni con la cola: solo avisa al llamador, que es quien encola.
 */

import { Component, Modal, setIcon, type App } from 'obsidian';

export interface BrlDeleteModalOptions {
	/** El texto de la entrada, SIN marcador, para que se vea qué se va a borrar. */
	preview: string;
	/** Qué hacer al confirmar. El modal ya se ha cerrado cuando esto corre. */
	onConfirm(): Promise<void>;
}

export class BrlDeleteEntryModal extends Modal {
	/**
	 * Los listeners del DOM. `Modal` NO es un `Component` y no tiene
	 * `registerDomEvent`, así que el modal lleva el suyo: se carga al abrir y se
	 * descarga al cerrar, y con él se sueltan todos de una vez.
	 */
	private readonly events = new Component();

	constructor(
		app: App,
		private readonly options: BrlDeleteModalOptions,
	) {
		super(app);
	}

	onOpen(): void {
		this.events.load();
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('lumbre-brl-delete-modal');
		this.setTitle('Borrar esta entrada del registro');

		contentEl.createDiv({ cls: 'lumbre-brl-delete-modal__preview', text: this.options.preview });
		contentEl.createDiv({
			cls: 'lumbre-brl-delete-modal__warning',
			text: 'Esto la borra de Lumbre. No se puede deshacer.',
		});

		const actions = contentEl.createDiv({ cls: 'lumbre-brl-delete-modal__actions' });
		const cancel = actions.createEl('button', { cls: 'lumbre-button' });
		cancel.createSpan({ text: 'Cancelar' });
		this.events.registerDomEvent(cancel, 'click', () => {
			this.close();
		});

		const confirm = actions.createEl('button', { cls: 'lumbre-button lumbre-button--danger' });
		const icon = confirm.createSpan({ cls: 'lumbre-button__icon' });
		setIcon(icon, 'trash-2');
		confirm.createSpan({ text: 'Borrar' });
		this.events.registerDomEvent(confirm, 'click', () => {
			this.close();
			void this.options.onConfirm();
		});
	}

	onClose(): void {
		// Con el Component se van todos los listeners que registró el modal.
		this.events.unload();
		this.contentEl.empty();
	}
}
