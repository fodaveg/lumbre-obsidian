/**
 * Modal de «anotar en el BRL».
 *
 * Lo mínimo: un campo de texto y dos botones, «Nota» y «Pensamiento». El botón
 * que se pulsa ES el tipo de entrada, así que no hay un selector aparte: en
 * Lumbre el tipo lo decide el marcador (`-` o `=`) y aquí lo decide el botón.
 *
 * El modal no habla con la red ni con el vault: recoge el texto y se lo pasa al
 * llamador, que es quien encola por la cola durable.
 */

import { Component, Modal, Notice, setIcon, type App } from 'obsidian';

import { MAX_BRL_ENTRY_LENGTH, type BrlKind } from './brl-ops';

export interface BrlModalOptions {
	/** Texto prefijado: la selección del editor, si la había. */
	defaultText: string;
	/** Qué hacer con la entrada. El modal ya se ha cerrado cuando esto corre. */
	onSubmit(text: string, kind: BrlKind): Promise<void>;
}

export class BrlEntryModal extends Modal {
	private text: string;

	/**
	 * Los listeners del DOM. `Modal` NO es un `Component` y no tiene
	 * `registerDomEvent`, así que el modal lleva el suyo: se carga al abrir y se
	 * descarga al cerrar, y con él se sueltan todos de una vez.
	 */
	private readonly events = new Component();

	constructor(
		app: App,
		private readonly options: BrlModalOptions,
	) {
		super(app);
		this.text = options.defaultText;
	}

	onOpen(): void {
		this.events.load();
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('lumbre-brl-modal');
		this.setTitle('Anotar en el BRL');

		const area = contentEl.createEl('textarea', { cls: 'lumbre-brl-modal__text' });
		area.rows = 4;
		area.maxLength = MAX_BRL_ENTRY_LENGTH;
		area.placeholder = 'Qué ha pasado, o qué estás pensando';
		area.value = this.text;
		area.setAttribute('aria-label', 'Texto de la entrada del registro');
		this.events.registerDomEvent(area, 'input', () => {
			this.text = area.value;
		});

		const actions = contentEl.createDiv({ cls: 'lumbre-brl-modal__actions' });
		this.button(actions, 'Nota', 'minus', 'note');
		this.button(actions, 'Pensamiento', 'equal', 'thought');

		contentEl.createDiv({
			cls: 'lumbre-brl-modal__hint',
			text: 'Una nota es algo que ha pasado; un pensamiento es algo que se te ha ocurrido.',
		});

		// Enter dentro del textarea es un salto de línea, que es lo que uno espera
		// de un apunte de varias líneas. Ctrl/Cmd+Enter lo manda como nota, que es
		// el caso frecuente.
		this.events.registerDomEvent(area, 'keydown', (event: KeyboardEvent) => {
			if (event.key !== 'Enter' || event.isComposing) return;
			if (!event.metaKey && !event.ctrlKey) return;
			event.preventDefault();
			this.submit('note');
		});

		window.setTimeout(() => {
			area.focus();
			area.select();
		}, 0);
	}

	onClose(): void {
		// Con el Component se van todos los listeners que registró el modal.
		this.events.unload();
		this.contentEl.empty();
	}

	private button(parent: HTMLElement, text: string, icon: string, kind: BrlKind): void {
		const button = parent.createEl('button', { cls: 'lumbre-button lumbre-button--cta' });
		const holder = button.createSpan({ cls: 'lumbre-button__icon' });
		setIcon(holder, icon);
		button.createSpan({ text });
		button.setAttribute('aria-label', `Anotar como ${text.toLowerCase()}`);
		this.events.registerDomEvent(button, 'click', () => {
			this.submit(kind);
		});
	}

	private submit(kind: BrlKind): void {
		if (this.text.trim().length === 0) {
			new Notice('La entrada necesita un texto.');
			return;
		}
		const text = this.text;
		this.close();
		void this.options.onSubmit(text, kind);
	}
}
