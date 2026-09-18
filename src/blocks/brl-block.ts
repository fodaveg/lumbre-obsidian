/**
 * El bloque de código ```lumbre-brl```: el registro del día EN VIVO en una nota.
 *
 * Mismas tres reglas que el bloque ```lumbre```:
 *
 * - No toca el Markdown. El bloque pinta lo que hay en Lumbre al renderizar; el
 *   fichero de la nota se queda exactamente como estaba. El comando «insertar
 *   el BRL de hoy como texto» es otra cosa: ahí el usuario PIDE la foto fija.
 * - Sin red no se enseña un bloque vacío: la última lectura confirmada con su
 *   hora y una línea que dice que eso es lo que se está viendo.
 * - Una consulta que no se entiende pinta el problema en una línea y no rompe
 *   nada más de la nota.
 *
 * Cada entrada se pinta con su propio texto (Markdown de esa línea, con el
 * mismo motor que el resto de la nota) y, si no está cancelada ni con una
 * operación en curso, dos botones: Editar y Borrar.
 *
 * DECISIÓN: editar es EN LÍNEA, dentro de la propia fila; borrar abre un
 * `Modal` con confirmación (lo pide el encargo: nada de `confirm()` nativo).
 * La edición no necesita un `Component` propio porque `MarkdownRenderChild` ya
 * lo es (`registerDomEvent` vale igual que en el resto del bloque); el borrado
 * sí, porque `Modal` no es un `Component` (ver `BrlDeleteEntryModal`).
 *
 * Mientras la edición o el borrado están encolados y sin confirmar, la fila
 * enseña un chip («Guardando…», «Eliminando…», «Sin confirmar» o «Rechazada»),
 * el mismo trato que ya usa el chip de un vínculo nota↔tarea
 * (`src/ui/link-chip-state.ts`): un 200 no es un hecho, así que hasta que la
 * cola no relee y confirma, la fila sigue mostrando el texto de ANTES con el
 * chip encima, nunca el texto que se acaba de mandar (ver `brl-entry-state.ts`).
 */

import { MarkdownRenderChild, MarkdownRenderer, Platform, setIcon, type App } from 'obsidian';

import {
	BRL_TODAY,
	brlEntryText,
	brlKindOf,
	MAX_BRL_ENTRY_LENGTH,
	parseBrlQuery,
	stripBrlMarker,
	type BrlKind,
} from '../brl/brl-ops';
import { BrlDeleteEntryModal } from '../brl/brl-delete-modal';
import { brlEntryChipState, pendingOperationForEntry } from '../brl/brl-entry-state';
import type { Logger } from '../diagnostics/logger';
import type { BrlEntryRow } from '../lumbre/client';
import type { OperationQueue, QueuedOperation } from '../lumbre/queue';
import { staleNote } from './block-footer';
import { logInvalidBlock } from './block-log';
import type { BrlCache, BrlSnapshot } from './brl-cache';

/** El lenguaje del bloque: ```lumbre-brl```. */
export const LUMBRE_BRL_BLOCK_LANGUAGE = 'lumbre-brl';

/**
 * Lo que el bloque necesita del plugin. Se declara aquí como interfaz para no
 * importar `main.ts` y crear un ciclo entre los dos módulos.
 */
export interface BrlBlockHost {
	cache: BrlCache;
	/**
	 * La app de Obsidian, que `MarkdownRenderChild` no trae y que
	 * `MarkdownRenderer.render` necesita para resolver los enlaces internos.
	 */
	app: App;
	/** Solo para leer: el chip de una entrada mira si hay una operación en curso sobre ella. */
	queue: Pick<OperationQueue, 'pending'>;
	/** Edita una entrada que ya existe: encola, drena y refresca el día. El bloque no habla con la cola. */
	updateEntry(date: string, entryId: string, raw: string, kind: BrlKind, notePath: string): Promise<void>;
	/** Borra una entrada que ya existe: encola, drena y refresca el día. */
	removeEntry(date: string, entryId: string, notePath: string): Promise<void>;
	/** Avisa cuando cambian la cola o los vínculos. Devuelve cómo desuscribirse. */
	onDataChange(listener: () => void): () => void;
	/** Registro de diagnóstico, ya etiquetado como `block`. */
	logger: Logger;
}

export class LumbreBrlBlock extends MarkdownRenderChild {
	private date: string | null = null;
	private snapshot: BrlSnapshot | null = null;
	private parseError: string | null = null;
	private unsubscribeCache: (() => void) | null = null;
	private unsubscribeData: (() => void) | null = null;
	private unloaded = false;

	/** El id de la entrada en edición EN LÍNEA, o `null` si ninguna. */
	private editingId: string | null = null;
	private editingKind: BrlKind = 'note';
	private editingText = '';
	/** Del intento de guardar anterior, si el texto no daba para una entrada. */
	private editingError: string | null = null;

	constructor(
		containerEl: HTMLElement,
		private readonly source: string,
		private readonly notePath: string,
		private readonly host: BrlBlockHost,
	) {
		super(containerEl);
	}

	onload(): void {
		this.containerEl.addClass('lumbre-brl');
		this.containerEl.toggleClass('lumbre-brl--mobile', Platform.isMobile);

		const parsed = parseBrlQuery(this.source);
		if (!parsed.ok) {
			this.parseError = parsed.error;
			// Igual que en el bloque de tareas: el cuerpo de un bloque mal escrito
			// solo sale en `debug`, ver `logInvalidBlock`.
			logInvalidBlock(this.host.logger, 'Consulta del bloque de BRL no válida', {
				notePath: this.notePath,
				error: parsed.error,
				source: this.source,
			});
			this.render();
			return;
		}

		this.date = parsed.date;
		this.host.logger.info('Bloque de BRL montado', { notePath: this.notePath, date: parsed.date });
		this.unsubscribeData = this.host.onDataChange(() => {
			this.render();
		});
		this.unsubscribeCache = this.host.cache.subscribe(parsed.date, (snapshot) => {
			this.snapshot = snapshot;
			this.render();
		});
		this.snapshot = this.host.cache.peek(parsed.date);
		this.render();
		void this.start(parsed.date);
	}

	onunload(): void {
		this.unloaded = true;
		if (this.date !== null) {
			this.host.logger.debug('Bloque de BRL desmontado', {
				notePath: this.notePath,
				date: this.date,
			});
		}
		this.unsubscribeCache?.();
		this.unsubscribeCache = null;
		this.unsubscribeData?.();
		this.unsubscribeData = null;
		this.containerEl.empty();
	}

	private async start(date: string): Promise<void> {
		this.snapshot = await this.host.cache.get(date);
		if (this.unloaded) return;
		this.render();
	}

	private async refresh(): Promise<void> {
		const date = this.date;
		if (date === null) return;
		this.snapshot = await this.host.cache.get(date, true);
		if (this.unloaded) return;
		this.render();
	}

	// ── Pintado ──────────────────────────────────────────────────────────────

	private render(): void {
		const root = this.containerEl;
		root.empty();

		const error = this.parseError;
		if (error !== null) {
			root.createDiv({ cls: 'lumbre-brl__error', text: error });
			return;
		}

		this.renderHeader(root);
		this.renderBody(root);
		this.renderFooter(root);
	}

	private renderHeader(root: HTMLElement): void {
		const header = root.createDiv({ cls: 'lumbre-brl__header' });
		header.createDiv({
			cls: 'lumbre-brl__title',
			text: this.date === null || this.date === BRL_TODAY ? 'Registro de hoy' : `Registro del ${this.date}`,
		});

		const button = header.createEl('button', { cls: 'lumbre-button lumbre-brl__refresh' });
		const icon = button.createSpan({ cls: 'lumbre-button__icon' });
		setIcon(icon, 'refresh-cw');
		button.createSpan({ text: 'Actualizar' });
		button.disabled = this.date === null || this.snapshot?.loading === true;
		this.registerDomEvent(button, 'click', () => {
			void this.refresh();
		});
	}

	private renderBody(root: HTMLElement): void {
		const snapshot = this.snapshot;
		if (snapshot === null || (snapshot.fetchedAt === null && snapshot.error === null)) {
			root.createDiv({ cls: 'lumbre-empty', text: 'Cargando…' });
			return;
		}

		if (snapshot.fetchedAt === null) {
			// Todavía no ha habido ninguna lectura buena y la primera falló: no hay
			// nada anterior que enseñar, así que se enseña el motivo.
			root.createDiv({ cls: 'lumbre-brl__error', text: snapshot.error ?? 'Cargando…' });
			return;
		}

		// La entrada en edición pudo desaparecer (borrada desde otro sitio, o el
		// día ya no la trae): sin fila que pintar, no hay formulario que mostrar.
		if (this.editingId !== null && !snapshot.entries.some((entry) => entry.id === this.editingId)) {
			this.editingId = null;
		}

		const body = root.createDiv({ cls: 'lumbre-brl__body' });
		if (snapshot.entries.length === 0) {
			body.createDiv({ cls: 'lumbre-empty', text: 'El registro de este día está vacío.' });
			return;
		}

		const operations = this.host.queue.pending();
		const list = body.createDiv({ cls: 'lumbre-brl__entries' });
		for (const entry of snapshot.entries) this.renderEntry(list, entry, operations);
	}

	private renderEntry(list: HTMLElement, entry: BrlEntryRow, operations: readonly QueuedOperation[]): void {
		if (this.editingId === entry.id) {
			this.renderEditForm(list, entry);
			return;
		}

		const chip = brlEntryChipState(pendingOperationForEntry(operations, entry.id));
		const row = list.createDiv({ cls: 'lumbre-brl__entry' });
		row.toggleClass('lumbre-brl__entry--thought', brlKindOf(entry.entry) === 'thought');
		row.toggleClass('lumbre-brl__entry--busy', chip.tone === 'pending');
		row.toggleClass('lumbre-brl__entry--deleting', chip.deleting && chip.tone !== null);

		const main = row.createDiv({ cls: 'lumbre-brl__entry-main' });
		if (entry.time.length > 0) {
			main.createSpan({ cls: 'lumbre-brl__entry-time', text: entry.time });
		}

		const text = main.createDiv({ cls: 'lumbre-brl__entry-text' });
		// El mismo motor que el resto de la nota: enlaces internos, listas y citas
		// salen igual que en cualquier otro sitio del vault.
		void MarkdownRenderer.render(this.host.app, stripBrlMarker(entry.entry), text, this.notePath, this);

		if (chip.label !== null) {
			const badge = main.createSpan({
				cls: `lumbre-chip lumbre-chip--${chip.tone ?? 'pending'}`,
				text: chip.label,
			});
			if (chip.reason !== null) badge.setAttribute('title', chip.reason);
		}

		// Solo un ENVÍO en vuelo bloquea los botones: una rechazada o sin confirmar
		// se puede reintentar editando o borrando de nuevo, igual que la casilla de
		// una tarea (`chip.tone === 'pending'` en `task-block.ts`).
		const busy = chip.tone === 'pending';
		const actions = row.createDiv({ cls: 'lumbre-brl__entry-actions' });

		const editButton = actions.createEl('button', { cls: 'lumbre-button lumbre-brl__entry-action' });
		setIcon(editButton.createSpan({ cls: 'lumbre-button__icon' }), 'pencil');
		editButton.setAttribute('aria-label', 'Editar esta entrada');
		editButton.disabled = busy;
		this.registerDomEvent(editButton, 'click', () => {
			this.startEdit(entry);
		});

		const deleteButton = actions.createEl('button', {
			cls: 'lumbre-button lumbre-brl__entry-action lumbre-button--danger',
		});
		setIcon(deleteButton.createSpan({ cls: 'lumbre-button__icon' }), 'trash-2');
		deleteButton.setAttribute('aria-label', 'Borrar esta entrada');
		deleteButton.disabled = busy;
		this.registerDomEvent(deleteButton, 'click', () => {
			this.confirmDelete(entry);
		});
	}

	private startEdit(entry: BrlEntryRow): void {
		this.editingId = entry.id;
		this.editingKind = brlKindOf(entry.entry);
		this.editingText = stripBrlMarker(entry.entry);
		this.editingError = null;
		this.render();
	}

	private cancelEdit(): void {
		this.editingId = null;
		this.editingError = null;
		this.render();
	}

	private renderEditForm(list: HTMLElement, entry: BrlEntryRow): void {
		const originalKind = brlKindOf(entry.entry);
		const row = list.createDiv({ cls: 'lumbre-brl__entry lumbre-brl__entry--editing' });

		const area = row.createEl('textarea', { cls: 'lumbre-brl__entry-input' });
		area.rows = 3;
		area.maxLength = MAX_BRL_ENTRY_LENGTH;
		area.value = this.editingText;
		area.setAttribute('aria-label', 'Texto de la entrada del registro');
		this.registerDomEvent(area, 'input', () => {
			this.editingText = area.value;
		});

		const kinds = row.createDiv({ cls: 'lumbre-brl__entry-kinds' });
		this.renderKindButton(kinds, 'Nota', 'minus', 'note');
		this.renderKindButton(kinds, 'Pensamiento', 'equal', 'thought');

		// Cambiar el marcador CAMBIA EL TIPO de la entrada: hay que decirlo, no
		// dejar que se note solo al releer.
		if (this.editingKind !== originalKind) {
			row.createDiv({
				cls: 'lumbre-brl__entry-hint',
				text: `Se guardará como ${this.editingKind === 'thought' ? 'pensamiento' : 'nota'}: cambia el tipo de la entrada.`,
			});
		}

		if (this.editingError !== null) {
			row.createDiv({ cls: 'lumbre-brl__error', text: this.editingError });
		}

		const actions = row.createDiv({ cls: 'lumbre-brl__entry-actions' });
		const cancel = actions.createEl('button', { cls: 'lumbre-button' });
		cancel.createSpan({ text: 'Cancelar' });
		this.registerDomEvent(cancel, 'click', () => {
			this.cancelEdit();
		});

		const save = actions.createEl('button', { cls: 'lumbre-button lumbre-button--cta' });
		save.createSpan({ text: 'Guardar' });
		this.registerDomEvent(save, 'click', () => {
			void this.saveEdit(entry);
		});

		window.setTimeout(() => {
			area.focus();
		}, 0);
	}

	private renderKindButton(parent: HTMLElement, text: string, icon: string, kind: BrlKind): void {
		const active = this.editingKind === kind;
		const button = parent.createEl('button', {
			cls: `lumbre-button lumbre-brl__entry-kind${active ? ' lumbre-button--cta' : ''}`,
		});
		setIcon(button.createSpan({ cls: 'lumbre-button__icon' }), icon);
		button.createSpan({ text });
		button.setAttribute('aria-pressed', String(active));
		this.registerDomEvent(button, 'click', () => {
			this.editingKind = kind;
			this.render();
		});
	}

	private renderFooter(root: HTMLElement): void {
		const snapshot = this.snapshot;
		const footer = root.createDiv({ cls: 'lumbre-brl__footer' });
		footer.setAttribute('aria-live', 'polite');

		if (snapshot === null) return;
		if (snapshot.fetchedAt !== null) {
			footer.createSpan({ text: `Datos de ${clockText(snapshot.fetchedAt)}` });
		}
		// El motivo REAL: «Sin conexión» para todo escondía el token caducado y el
		// add-on del BRL desactivado, que no se arreglan igual.
		if (snapshot.error !== null && snapshot.fetchedAt !== null) {
			footer.createSpan({ cls: 'lumbre-brl__stale', text: staleNote(snapshot.error) });
		}
	}

	// ── Acciones ─────────────────────────────────────────────────────────────

	/** Guarda la edición en línea. Encola; la fila no se asienta hasta materializar. */
	private async saveEdit(entry: BrlEntryRow): Promise<void> {
		const date = this.date;
		if (date === null) return;

		if (brlEntryText(this.editingText, this.editingKind) === null) {
			this.editingError = 'La entrada no puede quedar vacía.';
			this.render();
			return;
		}

		const raw = this.editingText;
		const kind = this.editingKind;
		this.editingId = null;
		this.editingError = null;
		await this.host.updateEntry(date, entry.id, raw, kind, this.notePath);
		if (this.unloaded) return;
		this.render();
	}

	/** Abre el modal de confirmación y, si se confirma, encola el borrado. */
	private confirmDelete(entry: BrlEntryRow): void {
		const date = this.date;
		if (date === null) return;

		new BrlDeleteEntryModal(this.host.app, {
			preview: stripBrlMarker(entry.entry),
			onConfirm: async () => {
				await this.host.removeEntry(date, entry.id, this.notePath);
				if (this.unloaded) return;
				this.render();
			},
		}).open();
	}
}

/** `HH:MM` en la hora local del dispositivo. */
function clockText(epochMs: number): string {
	return new Date(epochMs).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
