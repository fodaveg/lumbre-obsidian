/**
 * Modal de "Enviar a Lumbre".
 *
 * Recoge lo que hace falta para crear UNA tarea y se lo pasa al llamador, que es
 * quien encola. El modal no habla con la red ni con el vault: ni lee la nota ni
 * la escribe.
 *
 * Las notas salen SIEMPRE vacías. Rellenarlas con el cuerpo de la nota sería
 * copiar la nota dentro de la tarea, y entonces habría dos textos que mantener.
 */

import { Component, Modal, Notice, Setting, type App } from 'obsidian';

import type { LumbreList, LumbrePriority, TaskDraft } from '../lumbre/types';
import { MAX_TITLE_LENGTH } from './draft-from-editor';

/** Valor del desplegable de listas que significa "sin lista", o sea la bandeja. */
const INBOX_VALUE = '';

const PRIORITY_LABELS: Record<LumbrePriority, string> = {
	p1: 'p1 · máxima',
	p2: 'p2 · alta',
	p3: 'p3 · media',
	p4: 'p4 · sin prioridad',
};

export interface SendModalDefaults {
	/** Título prefijado: la selección o la línea del cursor, ya recortada. */
	title: string;
	/** Lista preseleccionada, normalmente la `lumbre-list` de la nota. */
	listId: string | null;
}

export interface SendModalOptions {
	/** Listas cacheadas para el desplegable. Puede venir vacío si nunca hubo red. */
	lists: LumbreList[];
	defaults: SendModalDefaults;
	/** Qué hacer con el borrador. El modal ya se ha cerrado cuando esto corre. */
	onSubmit(draft: TaskDraft): Promise<void>;
}

export class SendTaskModal extends Modal {
	private title: string;
	private listId: string;
	private date = '';
	private someday = false;
	private time = '';
	private priority: LumbrePriority = 'p4';
	private deadline = '';
	private notes = '';
	private subtasks = '';

	/** Se guardan para poder deshabilitarlas cuando se marca "Algún día". */
	private dateSetting: Setting | null = null;
	private timeSetting: Setting | null = null;

	/**
	 * Los listeners del DOM. `Modal` NO es un `Component` y no tiene
	 * `registerDomEvent`, así que el modal lleva el suyo: se carga al abrir y se
	 * descarga al cerrar, y con él se sueltan todos de una vez.
	 */
	private readonly events = new Component();

	constructor(
		app: App,
		private readonly options: SendModalOptions,
	) {
		super(app);
		this.title = options.defaults.title;
		this.listId = options.defaults.listId ?? INBOX_VALUE;
	}

	onOpen(): void {
		this.events.load();
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('lumbre-send-modal');
		this.setTitle('Enviar a Lumbre');

		new Setting(contentEl).setName('Tarea').addText((text) => {
			text.inputEl.addClass('lumbre-send-modal__title');
			text.inputEl.maxLength = MAX_TITLE_LENGTH;
			text.setPlaceholder('Qué hay que hacer');
			text.setValue(this.title);
			text.onChange((value) => {
				this.title = value;
			});
			window.setTimeout(() => {
				text.inputEl.focus();
				text.inputEl.select();
			}, 0);
		});

		new Setting(contentEl)
			.setName('Lista')
			.setDesc(
				this.options.lists.length > 0
					? 'Dónde cae la tarea en Lumbre.'
					: 'Sin listas cacheadas todavía; se enviará a la bandeja de entrada.',
			)
			.addDropdown((dropdown) => {
				dropdown.addOption(INBOX_VALUE, 'Bandeja de entrada');
				for (const list of this.options.lists) dropdown.addOption(list.id, list.name);
				dropdown.setValue(this.listId);
				dropdown.onChange((value) => {
					this.listId = value;
				});
			});

		this.dateSetting = new Setting(contentEl).setName('Fecha').addText((text) => {
			text.inputEl.type = 'date';
			text.inputEl.setAttribute('aria-label', 'Fecha de la tarea');
			text.onChange((value) => {
				this.date = value;
			});
		});

		new Setting(contentEl)
			.setName('Algún día')
			.setDesc('Sin fecha. Excluye la fecha y la hora.')
			.addToggle((toggle) =>
				toggle.setValue(this.someday).onChange((value) => {
					this.someday = value;
					this.applySomeday();
				}),
			);

		this.timeSetting = new Setting(contentEl).setName('Hora').addText((text) => {
			text.inputEl.type = 'time';
			text.inputEl.setAttribute('aria-label', 'Hora de la tarea');
			text.onChange((value) => {
				this.time = value;
			});
		});

		new Setting(contentEl).setName('Prioridad').addDropdown((dropdown) => {
			for (const [value, label] of Object.entries(PRIORITY_LABELS)) dropdown.addOption(value, label);
			dropdown.setValue(this.priority);
			dropdown.onChange((value) => {
				this.priority = value as LumbrePriority;
			});
		});

		new Setting(contentEl)
			.setName('Fecha límite')
			.setDesc('El día en que deja de servir, si lo tiene.')
			.addText((text) => {
				text.inputEl.type = 'date';
				text.inputEl.setAttribute('aria-label', 'Fecha límite de la tarea');
				text.onChange((value) => {
					this.deadline = value;
				});
			});

		new Setting(contentEl)
			.setName('Notas')
			.setDesc('Vacío por defecto. El cuerpo de la nota NO se copia aquí.')
			.addTextArea((area) => {
				area.inputEl.rows = 3;
				area.onChange((value) => {
					this.notes = value;
				});
			});

		new Setting(contentEl)
			.setName('Subtareas')
			.setDesc('Una por línea.')
			.addTextArea((area) => {
				area.inputEl.rows = 3;
				area.setPlaceholder('Una subtarea por línea');
				area.onChange((value) => {
					this.subtasks = value;
				});
			});

		new Setting(contentEl)
			.addButton((button) =>
				button.setButtonText('Cancelar').onClick(() => {
					this.close();
				}),
			)
			.addButton((button) =>
				button
					.setButtonText('Enviar')
					.setCta()
					.onClick(() => {
						this.submit();
					}),
			);

		// Enter envía, salvo dentro de un textarea, donde Enter es un salto de línea.
		this.events.registerDomEvent(contentEl, 'keydown', (event: KeyboardEvent) => {
			if (event.key !== 'Enter' || event.isComposing) return;
			if (event.target instanceof HTMLTextAreaElement) return;
			event.preventDefault();
			this.submit();
		});

		this.applySomeday();
	}

	onClose(): void {
		// Con el Component se van todos los listeners que registró el modal.
		this.events.unload();
		this.contentEl.empty();
	}

	/** Con "Algún día" no hay fecha ni hora: se deshabilitan y se olvidan. */
	private applySomeday(): void {
		this.dateSetting?.setDisabled(this.someday);
		this.timeSetting?.setDisabled(this.someday);
		if (!this.someday) return;
		this.date = '';
		this.time = '';
	}

	private submit(): void {
		const title = this.title.trim();
		if (title.length === 0) {
			new Notice('La tarea necesita un título.');
			return;
		}

		const draft: TaskDraft = {
			title,
			listId: this.listId.length > 0 ? this.listId : null,
			date: this.someday || this.date.length === 0 ? null : this.date,
			someday: this.someday ? true : null,
			time: this.someday || this.time.length === 0 ? null : this.time,
			priority: this.priority,
			deadline: this.deadline.length > 0 ? this.deadline : null,
			notes: this.notes.trim().length > 0 ? this.notes.trim() : null,
			subtasks: splitSubtasks(this.subtasks),
		};

		this.close();
		void this.options.onSubmit(draft);
	}
}

/** Una subtarea por línea, sin las vacías ni el marcador de lista si lo pegaron. */
export function splitSubtasks(raw: string): string[] {
	return raw
		.split('\n')
		.map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[.\]\s+)?/, '').trim())
		.filter((line) => line.length > 0);
}
