/**
 * Selector de tarea cuando la nota tiene VARIOS vínculos. Enseña las tareas ya
 * cacheadas por `LinkStore` (no pide red): elegir aquí decide a cuál de ellas
 * va la foto de «Guardar esta nota en la tarea».
 */

import { SuggestModal, type App } from 'obsidian';

import type { LumbreTaskLink } from '../links/link-store';
import { normalizeForSearch } from '../ui/search-filter';

export class NoteTaskSuggestModal extends SuggestModal<LumbreTaskLink> {
	constructor(
		app: App,
		private readonly links: LumbreTaskLink[],
		private readonly onChoose: (link: LumbreTaskLink) => void,
	) {
		super(app);
		this.setPlaceholder('Qué tarea de esta nota');
		this.emptyStateText = 'Ninguna tarea con ese texto.';
	}

	getSuggestions(query: string): LumbreTaskLink[] {
		const needle = normalizeForSearch(query);
		if (needle.length === 0) return this.links;
		return this.links.filter((link) => normalizeForSearch(link.task.content).includes(needle));
	}

	renderSuggestion(link: LumbreTaskLink, el: HTMLElement): void {
		el.createDiv({ text: link.task.content });
		el.createDiv({
			cls: 'lumbre-suggest__meta',
			text: link.task.list === null ? 'Bandeja de entrada' : link.task.list.name,
		});
	}

	onChooseSuggestion(link: LumbreTaskLink): void {
		this.onChoose(link);
	}
}
