/**
 * Modal de «Registrar hábito»: un campo de texto con el nombre, con los
 * nombres guardados en Ajustes como sugerencia (`<datalist>` nativo del
 * navegador, sin lógica propia que mantener). El plugin NO puede comprobar
 * que ese nombre existe de verdad en Lumbre (ver `habit-name.ts`): el aviso
 * de que el registro ha quedado sin confirmar lo da `main.ts` después de
 * drenar, no este modal.
 */

import { Component, Modal, Notice, setIcon, type App } from 'obsidian';

import { normalizeHabitName } from './habit-name';

export interface RegisterHabitModalOptions {
	/** Nombres guardados en Ajustes, para el desplegable de sugerencias. */
	savedNames: readonly string[];
	/** Qué hacer con el nombre. El modal ya se ha cerrado cuando esto corre. */
	onSubmit(name: string): Promise<void>;
}

const DATALIST_ID = 'lumbre-habit-names';

export class RegisterHabitModal extends Modal {
	private name = '';

	/**
	 * Los listeners del DOM. `Modal` NO es un `Component` y no tiene
	 * `registerDomEvent`, así que el modal lleva el suyo: se carga al abrir y se
	 * descarga al cerrar, y con él se sueltan todos de una vez.
	 */
	private readonly events = new Component();

	constructor(
		app: App,
		private readonly options: RegisterHabitModalOptions,
	) {
		super(app);
	}

	onOpen(): void {
		this.events.load();
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('lumbre-habit-modal');
		this.setTitle('Registrar hábito');

		if (this.options.savedNames.length > 0) {
			const datalist = contentEl.createEl('datalist', { attr: { id: DATALIST_ID } });
			for (const name of this.options.savedNames) datalist.createEl('option', { attr: { value: name } });
		}

		const input = contentEl.createEl('input', { type: 'text', cls: 'lumbre-habit-modal__input' });
		input.placeholder = 'Nombre del hábito';
		input.setAttribute('aria-label', 'Nombre del hábito');
		if (this.options.savedNames.length > 0) input.setAttribute('list', DATALIST_ID);
		this.events.registerDomEvent(input, 'input', () => {
			this.name = input.value;
		});
		this.events.registerDomEvent(input, 'keydown', (event: KeyboardEvent) => {
			if (event.key !== 'Enter' || event.isComposing) return;
			event.preventDefault();
			this.submit();
		});

		contentEl.createDiv({
			cls: 'lumbre-habit-modal__hint',
			text: 'El plugin no puede comprobar que este nombre existe en Lumbre: si no casa con ningún hábito, el registro quedará sin confirmar.',
		});

		const actions = contentEl.createDiv({ cls: 'lumbre-habit-modal__actions' });
		this.button(actions, 'Cancelar', undefined, false, () => {
			this.close();
		});
		this.button(actions, 'Registrar', 'check', true, () => {
			this.submit();
		});

		window.setTimeout(() => {
			input.focus();
		}, 0);
	}

	onClose(): void {
		// Con el Component se van todos los listeners que registró el modal.
		this.events.unload();
		this.contentEl.empty();
	}

	private submit(): void {
		const name = normalizeHabitName(this.name);
		if (name === null) {
			new Notice('El nombre del hábito no puede estar vacío.');
			return;
		}
		this.close();
		void this.options.onSubmit(name);
	}

	private button(
		parent: HTMLElement,
		text: string,
		icon: string | undefined,
		cta: boolean,
		onClick: () => void,
	): void {
		const button = parent.createEl('button', {
			cls: cta ? 'lumbre-button lumbre-button--cta' : 'lumbre-button',
		});
		if (icon !== undefined) {
			const holder = button.createSpan({ cls: 'lumbre-button__icon' });
			setIcon(holder, icon);
		}
		button.createSpan({ text });
		this.events.registerDomEvent(button, 'click', onClick);
	}
}
