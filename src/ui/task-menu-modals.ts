/**
 * Los diálogos que abren las entradas del menú por tarea que necesitan un dato:
 * una fecha, una sección, unas subtareas nuevas o cuál de las subtareas se
 * marca.
 *
 * Son la capa de `obsidian` del menú: ninguno decide NADA sobre la mutación
 * (eso es `task-menu-ops.ts`), solo recogen el dato y lo devuelven por el
 * callback. La lista de destino no está aquí porque ya existía:
 * `ListSuggestModal` (`src/ui/list-suggest-modal.ts`).
 *
 * `Modal` NO es un `Component` y no tiene `registerDomEvent`, así que cada
 * modal que engancha listeners lleva su propio `Component`: se carga al abrir y
 * se descarga al cerrar. Ningún `addEventListener` a pelo, que lo vigila
 * `src/dom-events.test.ts`.
 */

import { Component, Modal, Setting, SuggestModal, type App } from 'obsidian';

import type { LumbreSubtask } from '../lumbre/types';
import { MAX_SUBTASKS_PER_OP, MAX_SUBTASK_LENGTH } from './task-menu-ops';
import { normalizeForSearch } from './search-filter';

/**
 * Pide UNA fecha para reprogramar.
 *
 * Un `input type="date"` y nada más: en móvil abre el selector nativo del
 * sistema, que es táctil, y en escritorio acepta el teclado. El menú ya trae
 * "hoy" y "mañana" resueltos, así que esto solo cubre el resto del calendario.
 */
export class TaskDateModal extends Modal {
	private date: string;

	/** Ver el JSDoc de cabecera: `Modal` no es `Component`. */
	private readonly events = new Component();

	constructor(
		app: App,
		/** La fecha que ya tiene la tarea (`YYYY-MM-DD`), para partir de ella. */
		current: string | null,
		private readonly onChoose: (date: string) => void,
	) {
		super(app);
		this.date = current ?? '';
	}

	onOpen(): void {
		this.events.load();
		const { contentEl } = this;
		contentEl.empty();
		this.setTitle('Reprogramar la tarea');

		new Setting(contentEl)
			.setName('Fecha')
			.setDesc('El día al que se mueve la tarea.')
			.addText((text) => {
				text.inputEl.type = 'date';
				text.inputEl.setAttribute('aria-label', 'Nueva fecha de la tarea');
				text.setValue(this.date);
				text.onChange((value) => {
					this.date = value;
				});
				window.setTimeout(() => {
					text.inputEl.focus();
				}, 0);
			});

		new Setting(contentEl)
			.addButton((button) =>
				button.setButtonText('Cancelar').onClick(() => {
					this.close();
				}),
			)
			.addButton((button) =>
				button
					.setButtonText('Reprogramar')
					.setCta()
					.onClick(() => {
						this.submit();
					}),
			);

		this.events.registerDomEvent(contentEl, 'keydown', (event: KeyboardEvent) => {
			if (event.key !== 'Enter' || event.isComposing) return;
			event.preventDefault();
			this.submit();
		});
	}

	onClose(): void {
		this.events.unload();
		this.contentEl.empty();
	}

	/** Sin fecha no se encola nada: para quitarla está su propia entrada del menú. */
	private submit(): void {
		const date = this.date.trim();
		if (date.length === 0) return;
		this.close();
		this.onChoose(date);
	}
}

/**
 * Pide las subtareas nuevas, una por línea, igual que el campo "Subtareas" del
 * modal de enviar.
 *
 * Los topes se enseñan en la descripción porque el recorte es SILENCIOSO:
 * `subtaskTitles` descarta de la 51 en adelante y trunca lo que pase de 500
 * caracteres, que es lo que el servidor haría por su cuenta.
 */
export class AddSubtaskModal extends Modal {
	private text = '';

	private readonly events = new Component();

	constructor(
		app: App,
		private readonly onSubmit: (lines: string[]) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.events.load();
		const { contentEl } = this;
		contentEl.empty();
		this.setTitle('Añadir subtareas');

		new Setting(contentEl)
			.setName('Subtareas')
			.setDesc(
				`Una por línea. Máximo ${MAX_SUBTASKS_PER_OP}, y ${MAX_SUBTASK_LENGTH} caracteres cada una.`,
			)
			.addTextArea((area) => {
				area.inputEl.rows = 4;
				area.setPlaceholder('Una subtarea por línea');
				area.onChange((value) => {
					this.text = value;
				});
				window.setTimeout(() => {
					area.inputEl.focus();
				}, 0);
			});

		new Setting(contentEl)
			.addButton((button) =>
				button.setButtonText('Cancelar').onClick(() => {
					this.close();
				}),
			)
			.addButton((button) =>
				button
					.setButtonText('Añadir')
					.setCta()
					.onClick(() => {
						this.submit();
					}),
			);
	}

	onClose(): void {
		this.events.unload();
		this.contentEl.empty();
	}

	private submit(): void {
		this.close();
		this.onSubmit(this.text.split('\n'));
	}
}

/** Una sección candidata: una que ya existe, o la que se está escribiendo. */
export interface SectionChoice {
	kind: 'known' | 'new';
	name: string;
}

/**
 * Elige la sección de destino entre las que la superficie ya conoce (salen de
 * las tareas pintadas, sin gastar ninguna petición), o crea una escribiendo su
 * nombre: `setSection` va por NOMBRE y Lumbre acepta uno que no exista.
 *
 * Para SACAR la tarea de su sección está la entrada «Quitar de la sección» del
 * menú, que no abre nada.
 */
export class SectionSuggestModal extends SuggestModal<SectionChoice> {
	constructor(
		app: App,
		private readonly names: readonly string[],
		private readonly onChoose: (name: string) => void,
	) {
		super(app);
		this.setPlaceholder('Busca una sección, o escribe una nueva');
		this.emptyStateText = 'Escribe el nombre de la sección.';
	}

	getSuggestions(query: string): SectionChoice[] {
		const raw = query.trim();
		const needle = normalizeForSearch(query);
		const known: SectionChoice[] = this.names
			.filter((name) => needle.length === 0 || normalizeForSearch(name).includes(needle))
			.map((name) => ({ kind: 'known', name }));
		// La sección nueva solo se ofrece si lo escrito no es YA una de las
		// conocidas: si no, saldrían dos entradas que hacen lo mismo.
		if (raw.length > 0 && !this.names.includes(raw)) known.push({ kind: 'new', name: raw });
		return known;
	}

	renderSuggestion(choice: SectionChoice, el: HTMLElement): void {
		el.createDiv({ text: choice.name });
		if (choice.kind === 'new') {
			el.createDiv({ cls: 'lumbre-suggest__meta', text: 'Sección nueva' });
		}
	}

	onChooseSuggestion(choice: SectionChoice): void {
		this.onChoose(choice.name);
	}
}

/**
 * Elige QUÉ subtarea se marca o se desmarca. Un modal y no una entrada por
 * subtarea en el menú: con quince subtareas el menú dejaría de ser corto.
 *
 * La op se dirige al id de la SUBTAREA elegida, nunca al de su padre (lo compone
 * `completeSubtaskOp`).
 */
export class SubtaskSuggestModal extends SuggestModal<LumbreSubtask> {
	constructor(
		app: App,
		private readonly subtasks: readonly LumbreSubtask[],
		private readonly onChoose: (subtask: LumbreSubtask) => void,
	) {
		super(app);
		this.setPlaceholder('Qué subtarea se marca');
		this.emptyStateText = 'Ninguna subtarea con ese texto.';
	}

	getSuggestions(query: string): LumbreSubtask[] {
		const needle = normalizeForSearch(query);
		if (needle.length === 0) return [...this.subtasks];
		return this.subtasks.filter((subtask) =>
			normalizeForSearch(subtask.content).includes(needle),
		);
	}

	renderSuggestion(subtask: LumbreSubtask, el: HTMLElement): void {
		el.createDiv({ text: subtask.content });
		el.createDiv({
			cls: 'lumbre-suggest__meta',
			text: subtask.done ? 'Completada; se reabre' : 'Pendiente; se completa',
		});
	}

	onChooseSuggestion(subtask: LumbreSubtask): void {
		this.onChoose(subtask);
	}
}
