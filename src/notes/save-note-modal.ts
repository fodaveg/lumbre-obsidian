/**
 * Modal de confirmación de «Guardar esta nota en la tarea».
 *
 * La IA propone y el usuario confirma, la misma regla que Soplo: aquí no hay
 * IA, pero el principio es el mismo, así que nada se manda sin el clic en
 * «Guardar». Enseña a qué tarea va la foto, si es la selección o la nota
 * entera y cuántos caracteres, y cuántas fotos anteriores tiene ya esa tarea
 * (avisando si hay alguna).
 *
 * Si el texto no cabe en el tope de Lumbre, NO se recorta en silencio: se
 * dice, con el botón de recortar (cabecera intacta, marca de recorte) o el de
 * cancelar. El modal no habla con la red ni con la cola: solo compone el
 * texto final y se lo pasa al llamador.
 */

import { Component, Modal, setIcon, type App } from 'obsidian';

import {
	composeSnapshot,
	countSnapshots,
	MAX_NOTES_LEN,
	snapshotHeader,
	type NoteSnapshot,
} from './note-snapshot';

export interface SaveNoteModalOptions {
	/** Ruta de la nota, para la cabecera. */
	notePath: string;
	/** Si el texto es solo la selección o la nota entera. */
	scope: 'selection' | 'note';
	/** El texto que se va a guardar: la selección, o la nota entera. */
	text: string;
	/** Título de la tarea, ya recortado, para «a qué tarea va». */
	taskTitle: string;
	/** Las `notes` actuales de la tarea, para contar fotos anteriores y unir. */
	existingNotes: string | null;
	/** Reloj, inyectable para pruebas. Por defecto, ahora. */
	now?: () => Date;
	/**
	 * Qué hacer con el texto final. El modal ya se ha cerrado cuando esto
	 * corre. `header` es la cabecera de ESTA foto, que la cola necesita para
	 * confirmar al releer sin tener que guardar el texto entero.
	 */
	onSave(result: { notes: string; header: string }): Promise<void>;
}

export class SaveNoteModal extends Modal {
	/** Congelado al abrir: la cabecera de la foto no cambia mientras se decide recortar o no. */
	private readonly at: Date;
	private readonly header: string;
	private allowTruncate = false;

	/**
	 * Los listeners del DOM. `Modal` NO es un `Component` y no tiene
	 * `registerDomEvent`, así que el modal lleva el suyo: se carga al abrir y se
	 * descarga al cerrar, y con él se sueltan todos de una vez.
	 */
	private readonly events = new Component();

	constructor(
		app: App,
		private readonly options: SaveNoteModalOptions,
	) {
		super(app);
		this.at = (options.now ?? (() => new Date()))();
		this.header = snapshotHeader(options.notePath, this.at);
	}

	onOpen(): void {
		this.events.load();
		this.contentEl.addClass('lumbre-save-note-modal');
		this.setTitle('Guardar esta nota en la tarea');
		this.render();
	}

	onClose(): void {
		// Con el Component se van todos los listeners que registró el modal.
		this.events.unload();
		this.contentEl.empty();
	}

	private snapshot(): NoteSnapshot | null {
		return composeSnapshot(this.options.existingNotes, this.options.notePath, this.options.text, this.at, {
			allowTruncate: this.allowTruncate,
		});
	}

	private render(): void {
		const root = this.contentEl;
		root.empty();

		const info = root.createDiv({ cls: 'lumbre-save-note-modal__info' });
		info.createDiv({ cls: 'lumbre-save-note-modal__task', text: `Tarea: ${this.options.taskTitle}` });
		info.createDiv({
			text:
				this.options.scope === 'selection'
					? `La selección, ${this.options.text.length} caracteres.`
					: `La nota entera, ${this.options.text.length} caracteres.`,
		});

		const previous = countSnapshots(this.options.existingNotes);
		if (previous > 0) {
			info.createDiv({
				cls: 'lumbre-save-note-modal__warning',
				text: `Ya hay ${previous} ${previous === 1 ? 'foto anterior' : 'fotos anteriores'} en esta tarea.`,
			});
		}

		const actions = root.createDiv({ cls: 'lumbre-save-note-modal__actions' });
		const snapshot = this.snapshot();

		if (snapshot === null) {
			root.createDiv({
				cls: 'lumbre-notice lumbre-notice--error',
				text: this.allowTruncate
					? 'Ni recortando cabe: no queda hueco suficiente por debajo del tope de Lumbre.'
					: `No cabe: el tope de las notas de Lumbre es ${MAX_NOTES_LEN} caracteres.`,
			});
			if (!this.allowTruncate) {
				this.button(actions, {
					text: 'Recortar y guardar',
					icon: 'scissors',
					onClick: () => {
						this.allowTruncate = true;
						this.render();
					},
				});
			}
			this.button(actions, {
				text: 'Cancelar',
				onClick: () => {
					this.close();
				},
			});
			return;
		}

		if (snapshot.truncated) {
			root.createDiv({
				cls: 'lumbre-save-note-modal__warning',
				text: 'El texto se ha recortado para caber en el tope de Lumbre.',
			});
		}

		this.button(actions, {
			text: 'Cancelar',
			onClick: () => {
				this.close();
			},
		});
		this.button(actions, {
			text: 'Guardar',
			icon: 'check',
			cta: true,
			onClick: () => {
				this.save(snapshot);
			},
		});
	}

	private save(snapshot: NoteSnapshot): void {
		const result = { notes: snapshot.notes, header: this.header };
		this.close();
		void this.options.onSave(result);
	}

	private button(
		parent: HTMLElement,
		options: { text: string; icon?: string; cta?: boolean; onClick: () => void },
	): HTMLButtonElement {
		const button = parent.createEl('button', {
			cls: options.cta === true ? 'lumbre-button lumbre-button--cta' : 'lumbre-button',
		});
		if (options.icon !== undefined) {
			const icon = button.createSpan({ cls: 'lumbre-button__icon' });
			setIcon(icon, options.icon);
		}
		button.createSpan({ text: options.text });
		this.events.registerDomEvent(button, 'click', options.onClick);
		return button;
	}
}
