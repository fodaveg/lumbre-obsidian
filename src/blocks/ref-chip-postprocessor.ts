/**
 * Ficha viva sobre una referencia a tarea (`[[task:ID|Etiqueta]]`) pegada
 * desde Lumbre, en modo LECTURA.
 *
 * Obsidian no conoce esa sintaxis: la pinta como un enlace interno SIN
 * RESOLVER, `a.internal-link.is-unresolved` con `data-href` = `task:ID`
 * (medido en el vault de David el 17 sep 2026: no crea ningún fichero, solo
 * falla al VALIDAR el nombre y saca «El nombre de archivo no puede contener
 * \ / :»). Este módulo hace dos cosas sobre ese mismo enlace, sin tocarlo:
 *
 * 1. Le añade el estado y la fecha de la tarea a continuación (`ref-chip-
 *    format.ts`), pidiéndolo en UNA lectura en lote por sección renderizada
 *    (`ref-chip-cache.ts` + `ref-chip-parser.ts`).
 * 2. Intercepta el clic EN CAPTURA con `stopImmediatePropagation` (medido: 1
 *    clic propio, 0 avisos) para abrir la tarea en Lumbre en vez de dejar que
 *    Obsidian intente crear el fichero.
 *
 * DECISIÓN (paso 1): la variante de LISTA (`list:ID`) se deja FUERA, chip Y
 * clic. Pintar su ficha pediría resolver contra `listLists()` con una forma
 * de estado distinta (sin `done`/fecha) y el encargo es sobre referencias a
 * TAREA; inventar también su deep link (`lumbre://lista/`, que no expone
 * `taskDeepLinks`) es una superficie nueva que nadie ha pedido. Su enlace
 * sigue con el aviso de Obsidian hasta que se encargue aparte.
 *
 * Nunca escribe en la nota: solo pinta DOM y solo LEE de Lumbre. Si la
 * lectura falla o el pestillo de lecturas está echado, el enlace se queda
 * con su texto de referencia tal cual: el clic no depende de esa lectura
 * (el id ya está en `data-href`), así que sigue abriendo la tarea igual.
 *
 * Módulo de UI: importa `obsidian`. La parte pura vive en
 * `ref-chip-parser.ts`, `ref-chip-cache.ts` y `ref-chip-format.ts`.
 */

import { MarkdownRenderChild } from 'obsidian';

import type { Logger } from '../diagnostics/logger';
import type { LumbreResult } from '../lumbre/client';
import { taskDeepLinks, type LumbreTask } from '../lumbre/types';
import { openTaskInLumbre } from '../ui/open-in-lumbre';
import type { RefTaskCache } from './ref-chip-cache';
import { refChipText } from './ref-chip-format';
import { parseRefHref, uniqueTaskIds, type ParsedRef } from './ref-chip-parser';

/** Selector de los enlaces sin resolver que puede pintar una referencia de Lumbre. */
const UNRESOLVED_LINK_SELECTOR = 'a.internal-link.is-unresolved';

/** Clase marcada en el enlace ya enganchado, para no repintar ni re-enganchar el clic dos veces. */
const WIRED_CLASS = 'lumbre-ref-chip';

/** Clase del `span` con el estado, para no duplicarlo si la sección se repinta sin desmontarse. */
const STATE_CLASS = 'lumbre-ref-chip__state';

/** Lo que este módulo necesita del plugin. */
export interface RefChipHost {
	getTasksByIds(ids: string[]): Promise<LumbreResult<LumbreTask[]>>;
	/** Caché compartida entre TODAS las secciones, para no repetir una lectura ya fresca. */
	cache: RefTaskCache;
	webOrigin(): string;
	/** Registro de diagnóstico, ya etiquetado como `block`. */
	logger: Logger;
}

/**
 * Se engancha al postprocesador de Markdown. Una instancia por sección
 * renderizada (la crea `ctx.addChild`), así que sus listeners de clic se
 * sueltan solos cuando la sección se vuelve a pintar o la nota se cierra.
 */
export class RefChipRenderer extends MarkdownRenderChild {
	private unloaded = false;

	constructor(
		containerEl: HTMLElement,
		private readonly host: RefChipHost,
	) {
		super(containerEl);
	}

	onload(): void {
		const anchors = Array.from(
			this.containerEl.querySelectorAll<HTMLAnchorElement>(UNRESOLVED_LINK_SELECTOR),
		).filter((anchor) => !anchor.hasClass(WIRED_CLASS));
		if (anchors.length === 0) return;

		const refs = new Map<HTMLAnchorElement, ParsedRef>();
		for (const anchor of anchors) {
			const href = anchor.getAttribute('data-href');
			if (href === null) continue;
			const ref = parseRefHref(href);
			if (ref === null) continue;
			refs.set(anchor, ref);
			// El clic se engancha para CUALQUIER referencia de tarea reconocida,
			// tenga o no forma de UUID: abrir con el id tal cual es mejor que dejar
			// que Obsidian intente crear un fichero con ese nombre.
			if (ref.kind === 'task') this.wireTaskClick(anchor, ref.id);
		}
		if (refs.size === 0) return;

		const ids = uniqueTaskIds([...refs.values()]);
		if (ids.length === 0) return;
		void this.paintChips(refs, ids);
	}

	onunload(): void {
		this.unloaded = true;
	}

	private wireTaskClick(anchor: HTMLAnchorElement, taskId: string): void {
		anchor.addClass(WIRED_CLASS);
		this.registerDomEvent(
			anchor,
			'click',
			(event: MouseEvent) => {
				event.preventDefault();
				event.stopImmediatePropagation();
				this.host.logger.debug('Clic en referencia a tarea', { taskId });
				openTaskInLumbre(taskDeepLinks({ id: taskId }, this.host.webOrigin()));
			},
			// EN CAPTURA: es lo único que corta el manejador de Obsidian que valida
			// el nombre de fichero y saca el aviso de error (medido en el vault de
			// David el 17 sep 2026, 1 clic propio y 0 avisos).
			{ capture: true },
		);
	}

	private async paintChips(refs: Map<HTMLAnchorElement, ParsedRef>, ids: string[]): Promise<void> {
		const resolved = await this.host.cache.resolve(ids, (batch) => this.host.getTasksByIds(batch));
		// La sección puede haberse desmontado mientras la lectura estaba en
		// vuelo (edición, cambio de nota): pintar sobre un DOM ya tirado no
		// rompe nada, pero no aporta nada tampoco.
		if (this.unloaded) return;

		for (const [anchor, ref] of refs) {
			if (ref.kind !== 'task') continue;
			const task = resolved.get(ref.id);
			// Sin dato (nunca pedida, fallo de red, o borrada en Lumbre): el
			// enlace se queda con su texto de referencia, el clic sigue igual.
			if (task === undefined || task === null) continue;
			const text = refChipText(task);
			if (text === null) continue;
			if (anchor.querySelector(`.${STATE_CLASS}`) !== null) continue;
			anchor.createSpan({ cls: `lumbre-chip ${STATE_CLASS}`, text });
		}
	}
}
