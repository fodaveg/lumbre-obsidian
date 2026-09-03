/**
 * Selector de un fichero del vault para adjuntarlo a una tarea.
 *
 * Solo enseña ficheros que NO son Markdown: una nota se vincula a la tarea (eso
 * ya lo hace el panel), no se sube como adjunto. Copiar una nota dentro de una
 * tarea crearía dos textos que mantener, que es justo lo que este plugin no
 * hace.
 *
 * Los que pasan del tope de Lumbre salen en la lista, marcados, y se rechazan
 * al elegirlos: esconderlos dejaría al usuario buscando un fichero que está ahí.
 */

import { SuggestModal, type App, type TFile } from 'obsidian';

import { normalizeForSearch } from '../ui/search-filter';
import { checkUploadSize, formatBytes } from './upload';

/** Tope de resultados que se pintan. Un vault grande tiene miles de ficheros. */
const MAX_RESULTS = 50;

export class FileSuggestModal extends SuggestModal<TFile> {
	private readonly files: TFile[];

	constructor(
		app: App,
		private readonly onChoose: (file: TFile) => void,
	) {
		super(app);
		// Los adjuntos suelen ser lo último que se ha metido en el vault, así que
		// lo más reciente va primero.
		this.files = app.vault
			.getFiles()
			.filter((file) => file.extension.toLowerCase() !== 'md')
			.sort((a, b) => b.stat.mtime - a.stat.mtime);
		this.setPlaceholder('Busca un fichero del vault');
		this.emptyStateText =
			this.files.length === 0
				? 'El vault no tiene ficheros que no sean notas.'
				: 'Ningún fichero con ese nombre.';
	}

	getSuggestions(query: string): TFile[] {
		const needle = normalizeForSearch(query);
		const matched =
			needle.length === 0
				? this.files
				: this.files.filter((file) => normalizeForSearch(file.path).includes(needle));
		return matched.slice(0, MAX_RESULTS);
	}

	renderSuggestion(file: TFile, el: HTMLElement): void {
		el.createDiv({ text: file.name });
		const meta = el.createDiv({ cls: 'lumbre-suggest__meta' });
		const size = checkUploadSize(file.stat.size);
		meta.setText(
			size.ok
				? `${file.parent?.path ?? '/'} · ${formatBytes(file.stat.size)}`
				: `${file.parent?.path ?? '/'} · ${formatBytes(file.stat.size)} · no cabe`,
		);
	}

	onChooseSuggestion(file: TFile): void {
		this.onChoose(file);
	}
}
