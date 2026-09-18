/**
 * Selector de una tarea de Lumbre para adjuntarle un fichero, desde el menú
 * contextual del explorador («Adjuntar a una tarea de Lumbre»). A diferencia
 * de `NoteTaskSuggestModal` (que solo mira las tareas YA vinculadas a la nota
 * activa), este busca entre TODAS las tareas abiertas: el fichero puede no
 * tener nota, o su tarea puede no estar vinculada todavía.
 *
 * La lectura es UNA sola, al abrir el modal, igual que el buscador del panel
 * (`ui/task-search.ts`): la API no busca por texto, así que encadenar una
 * petición por tecla no compraría nada. El filtro por tecla es el mismo
 * `filterTasks` que usa el panel.
 */

import { SuggestModal, type App } from 'obsidian';

import { describeFailure, MAX_TASKS_LIMIT, type LumbreClient } from '../lumbre/client';
import type { LumbreTask } from '../lumbre/types';
import { filterTasks } from '../ui/search-filter';

/** Tope de resultados que se pintan, igual que el buscador del panel. */
const MAX_RESULTS = 50;

export class TaskSuggestModal extends SuggestModal<LumbreTask> {
	private tasks: LumbreTask[] = [];
	private readonly loaded: Promise<void>;

	constructor(
		app: App,
		client: Pick<LumbreClient, 'listTasks'>,
		private readonly onChoose: (task: LumbreTask) => void,
	) {
		super(app);
		this.setPlaceholder('Qué tarea de Lumbre');
		this.emptyStateText = 'Buscando…';
		this.loaded = this.load(client);
	}

	private async load(client: Pick<LumbreClient, 'listTasks'>): Promise<void> {
		const read = await client.listTasks({
			scope: 'all',
			includeDone: false,
			notes: 'none',
			limit: MAX_TASKS_LIMIT,
		});
		if (read.ok) {
			this.tasks = read.value;
			this.emptyStateText = 'Ninguna tarea con ese texto.';
		} else {
			this.emptyStateText = `No se pudo leer las tareas. ${describeFailure(read.reason, read.status)}`;
		}
	}

	async getSuggestions(query: string): Promise<LumbreTask[]> {
		await this.loaded;
		return filterTasks(this.tasks, query).slice(0, MAX_RESULTS);
	}

	renderSuggestion(task: LumbreTask, el: HTMLElement): void {
		el.createDiv({ text: task.content });
		el.createDiv({
			cls: 'lumbre-suggest__meta',
			text: task.list === null ? 'Bandeja de entrada' : task.list.name,
		});
	}

	onChooseSuggestion(task: LumbreTask): void {
		this.onChoose(task);
	}
}
