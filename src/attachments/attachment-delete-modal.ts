/**
 * Modal de confirmación al borrar un adjunto.
 *
 * Borrar es la única acción sobre un adjunto que PIDE confirmación: el repo
 * prohíbe un diálogo nativo del navegador (`confirm()`, bloquea la sesión), así
 * que esto es lo mínimo que hace falta en su lugar. Enseña el nombre del
 * fichero para que quien confirma sepa qué está borrando. No habla con la red:
 * solo avisa al llamador, que es quien hace el `DELETE` (gemelo de
 * `BrlDeleteEntryModal`, `brl/brl-delete-modal.ts`).
 */

import { Component, Modal, setIcon, type App } from 'obsidian';

export interface AttachmentDeleteModalOptions {
	/** Nombre del fichero, para que se vea qué se va a borrar. */
	filename: string;
	/** Qué hacer al confirmar. El modal ya se ha cerrado cuando esto corre. */
	onConfirm(): Promise<void>;
}

export class AttachmentDeleteModal extends Modal {
	/**
	 * Los listeners del DOM. `Modal` NO es un `Component` y no tiene
	 * `registerDomEvent`, así que el modal lleva el suyo: se carga al abrir y se
	 * descarga al cerrar, y con él se sueltan todos de una vez.
	 */
	private readonly events = new Component();

	constructor(
		app: App,
		private readonly options: AttachmentDeleteModalOptions,
	) {
		super(app);
	}

	onOpen(): void {
		this.events.load();
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('lumbre-attachment-delete-modal');
		this.setTitle('Borrar este adjunto');

		contentEl.createDiv({
			cls: 'lumbre-attachment-delete-modal__preview',
			text: this.options.filename,
		});
		contentEl.createDiv({
			cls: 'lumbre-attachment-delete-modal__warning',
			text: 'Esto lo borra de Lumbre. No se puede deshacer.',
		});

		const actions = contentEl.createDiv({ cls: 'lumbre-attachment-delete-modal__actions' });
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
