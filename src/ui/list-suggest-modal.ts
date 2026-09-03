/**
 * Selector de lista de Lumbre. Se usa para el comando de vincular la nota a una
 * lista: enseña las listas cacheadas y devuelve la elegida.
 */

import { SuggestModal, type App } from 'obsidian';

import type { LumbreList } from '../lumbre/types';
import { normalizeForSearch } from './search-filter';

export class ListSuggestModal extends SuggestModal<LumbreList> {
	constructor(
		app: App,
		private readonly lists: LumbreList[],
		private readonly onChoose: (list: LumbreList) => void,
	) {
		super(app);
		this.setPlaceholder('Busca una lista de Lumbre');
		this.emptyStateText = 'Ninguna lista con ese nombre.';
	}

	getSuggestions(query: string): LumbreList[] {
		const needle = normalizeForSearch(query);
		if (needle.length === 0) return this.lists;
		return this.lists.filter((list) => normalizeForSearch(list.name).includes(needle));
	}

	renderSuggestion(list: LumbreList, el: HTMLElement): void {
		el.createDiv({ text: list.name });
		el.createDiv({
			cls: 'lumbre-suggest__meta',
			text: list.taskCount === 1 ? '1 tarea' : `${list.taskCount} tareas`,
		});
	}

	onChooseSuggestion(list: LumbreList): void {
		this.onChoose(list);
	}
}
