/**
 * El menú corto POR TAREA, el mismo en el panel y en el bloque ```lumbre```.
 *
 * Existe una sola vez a propósito: las dos superficies pintan filas de tarea y,
 * si cada una montara su menú, en dos lotes tendrían entradas distintas. Aquí
 * está solo el cableado con `obsidian`; QUÉ entradas salen lo decide
 * `task-menu-items.ts` y QUÉ se manda lo compone `task-menu-ops.ts`, los dos
 * módulos puros y con test.
 *
 * Cómo se abre, y por qué de las dos formas: un botón «⋯» en la fila MÁS el
 * clic derecho sobre la fila entera. El botón es el que hace que esto funcione
 * en MÓVIL, que es táctil y no tiene clic derecho ni `contextmenu` fiable; el
 * clic derecho es el gesto que un usuario de escritorio va a probar primero, y
 * no cuesta nada. `Menu.showAtMouseEvent` sirve para los dos eventos.
 *
 * Qué se enseña mientras la acción está encolada y sin confirmar: NADA nuevo. El
 * chip de la fila ya dice «Enviando…» en cuanto la operación entra en la cola
 * (`link-chip-state.ts` ya sabe leer del `check` a qué tarea afecta una
 * `mutation`), y este menú se DESHABILITA mientras ese chip está en `pending`,
 * igual que ya se deshabilita la casilla de completar. Encolar una segunda
 * mutación sobre la misma tarea antes de que la primera se confirme es justo
 * cómo se acaba con dos escrituras compitiendo. Con el chip en `warning` o en
 * `error` el menú sigue disponible: ahí la operación ya no se va a mover sola y
 * el panel ofrece «Reintentar» y «Descartar».
 *
 * Este módulo no escribe en la nota. El bloque tampoco puede, y el menú no le
 * añade ninguna vía para hacerlo.
 */

import { Menu, setIcon, type App, type Component } from 'obsidian';

import type { Logger } from '../diagnostics/logger';
import type { ListCache } from '../lumbre/list-cache';
import type { LumbreTask } from '../lumbre/types';
import { guarded } from '../diagnostics/unhandled';
import { ListSuggestModal } from './list-suggest-modal';
import {
	sectionNamesFor,
	taskMenuItems,
	type TaskMenuItem,
	type TaskMenuItemKind,
} from './task-menu-items';
import {
	AddSubtaskModal,
	SectionSuggestModal,
	SubtaskSuggestModal,
	TaskDateModal,
} from './task-menu-modals';
import {
	addSubtasksOp,
	cancelOp,
	completeSubtaskOp,
	isoDatePlusDays,
	moveToListOp,
	rescheduleOp,
	restoreOp,
	setSectionOp,
	type TaskMutationPlan,
} from './task-menu-ops';

/** Lo que el menú necesita de quien lo monta. Lo cablea `main.ts`. */
export interface TaskMenuHost {
	app: App;
	/** Catálogo de listas para el destino de «Mover a otra lista». Cacheado 5 min. */
	lists: Pick<ListCache, 'get'>;
	/**
	 * Encola la mutación por la cola durable, drena y refresca las superficies.
	 * El menú NO habla con la cola, igual que el bloque no habla con ella para
	 * completar una tarea.
	 */
	applyTaskMutation(plan: TaskMutationPlan, notePath: string): Promise<void>;
	/** Registro de diagnóstico, ya etiquetado por la superficie que monta el menú. */
	logger: Logger;
}

export interface TaskMenuOptions {
	/** Quien registra los listeners y los suelta al desmontarse. */
	component: Component;
	/** La fila entera: aquí se engancha el clic derecho. */
	row: HTMLElement;
	/** Dónde se cuelga el botón «⋯». */
	anchor: HTMLElement;
	task: LumbreTask;
	/** Nota donde se hizo el gesto, para el `LinkTarget` de la operación. */
	notePath: string;
	/** `true` si la tarea tiene una operación encolada y sin confirmar. */
	pending: boolean;
	/**
	 * Las tareas que la superficie tiene pintadas. De ahí salen las secciones
	 * candidatas, sin gastar ninguna petición (ver `sectionNamesFor`).
	 */
	siblings: readonly LumbreTask[];
	host: TaskMenuHost;
	/**
	 * Se llama cuando la mutación ya está encolada y drenada, para que la
	 * superficie relea lo que no se invalida solo.
	 *
	 * Lo necesita el PANEL: su lista de proyecto no vive en `QueryCache`, así que
	 * el `refreshSoon` de la cola no la toca y la fila se quedaría en su sección
	 * vieja hasta el siguiente sondeo. Los bloques no lo pasan porque sí se
	 * refrescan por ahí.
	 */
	onApplied?: () => void;
}

/** Icono del botón que abre el menú. */
const MENU_ICON = 'more-vertical';

/**
 * Monta el menú en una fila de tarea: el botón «⋯» y el clic derecho.
 *
 * No hace nada si la tarea no tiene ninguna acción disponible (hoy, una
 * archivada): ni botón, ni clic derecho, en vez de un menú vacío.
 */
export function mountTaskMenu(options: TaskMenuOptions): void {
	const items = taskMenuItems(options.task);
	if (items.length === 0) return;

	const { component, task, pending } = options;
	const button = options.anchor.createEl('button', {
		cls: 'lumbre-button lumbre-task__menu',
	});
	const icon = button.createSpan({ cls: 'lumbre-button__icon' });
	setIcon(icon, MENU_ICON);
	button.setAttribute('aria-label', `Acciones de ${task.content}`);
	button.disabled = pending;
	if (pending) {
		button.setAttribute('title', 'Hay un cambio sin confirmar en esta tarea.');
	}

	const open = (event: MouseEvent): void => {
		const menu = new Menu();
		fillMenu(menu, items, options);
		menu.showAtMouseEvent(event);
	};

	component.registerDomEvent(button, 'click', (event: MouseEvent) => {
		open(event);
	});
	// El clic derecho de escritorio. En una fila con la acción encolada no abre
	// nada, igual que el botón queda deshabilitado.
	component.registerDomEvent(options.row, 'contextmenu', (event: MouseEvent) => {
		if (pending) return;
		event.preventDefault();
		open(event);
	});
}

/** Las entradas del menú, con un separador al cambiar de grupo. */
function fillMenu(menu: Menu, items: readonly TaskMenuItem[], options: TaskMenuOptions): void {
	const log = options.host.logger;
	let group = items[0]?.group;

	for (const item of items) {
		if (item.group !== group) {
			menu.addSeparator();
			group = item.group;
		}
		menu.addItem((entry) => {
			entry
				.setTitle(item.title)
				.setIcon(item.icon)
				.onClick(
					guarded(log, `menú de tarea (${item.kind})`, () => {
						run(item.kind, options);
					}),
				);
			if (item.warning === true) entry.setWarning(true);
		});
	}
}

/**
 * Ejecuta una entrada. Las que ya tienen todos los datos encolan directamente;
 * las que llevan puntos suspensivos abren su diálogo y encolan al confirmar.
 */
function run(kind: TaskMenuItemKind, options: TaskMenuOptions): void {
	const { task, host } = options;
	const now = new Date();

	switch (kind) {
		case 'rescheduleToday':
			apply(rescheduleOp(task, isoDatePlusDays(now, 0)), options);
			return;
		case 'rescheduleTomorrow':
			apply(rescheduleOp(task, isoDatePlusDays(now, 1)), options);
			return;
		case 'reschedulePick':
			new TaskDateModal(host.app, task.date, (date) => {
				apply(rescheduleOp(task, date), options);
			}).open();
			return;
		case 'rescheduleClear':
			apply(rescheduleOp(task, null), options);
			return;
		case 'cancel':
			apply(cancelOp(task), options);
			return;
		case 'restore':
			apply(restoreOp(task), options);
			return;
		case 'moveToList':
			// El catálogo está cacheado cinco minutos y lo comparten todas las
			// superficies, así que esto casi nunca es una petición.
			void guarded(host.logger, 'menú de tarea (elegir lista)', async () => {
				const lists = await host.lists.get();
				new ListSuggestModal(host.app, lists, (list) => {
					apply(moveToListOp(task, list.id), options);
				}).open();
			})();
			return;
		case 'clearList':
			apply(moveToListOp(task, null), options);
			return;
		case 'setSection':
			new SectionSuggestModal(
				host.app,
				sectionNamesFor(options.siblings, task.list?.id ?? null),
				(name) => {
					apply(setSectionOp(task, name), options);
				},
			).open();
			return;
		case 'clearSection':
			apply(setSectionOp(task, null), options);
			return;
		case 'addSubtask':
			new AddSubtaskModal(host.app, (lines) => {
				const plan = addSubtasksOp(task, lines);
				// Sin ningún título válido no se encola nada: un `addSubtask` con el
				// array vacío no haría nada y tampoco se podría confirmar.
				if (plan === null) return;
				apply(plan, options);
			}).open();
			return;
		case 'completeSubtask':
			new SubtaskSuggestModal(host.app, task.subtasks ?? [], (subtask) => {
				apply(completeSubtaskOp(task, subtask, !subtask.done), options);
			}).open();
			return;
	}
}

/**
 * Encola el plan. El repintado lo dispara el host al avisar del cambio, y
 * `onApplied` releé lo que ese aviso no cubre (ver su JSDoc).
 */
function apply(plan: TaskMutationPlan, options: TaskMenuOptions): void {
	const { host, notePath, onApplied } = options;
	void guarded(host.logger, `menú de tarea (${plan.action})`, async () => {
		await host.applyTaskMutation(plan, notePath);
		onApplied?.();
	})();
}
