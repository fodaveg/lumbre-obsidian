/**
 * Modal que abre un adjunto SIN escribirlo en el vault.
 *
 * Límite de producto fijado por David el 3 sep 2026: los adjuntos se ABREN, no
 * se guardan en el vault. `app.openWithDefaultApp` no sirve porque exige un
 * fichero QUE YA ESTÉ en el vault, justo lo contrario.
 *
 * La vía elegida: un `Modal` que pide los bytes con `LumbreClient.getAttachment`,
 * los mete en un `Blob` EN MEMORIA y los pinta con `URL.createObjectURL`, sin
 * tocar el vault ni el disco. Un `<img>` pinta una imagen, un `<iframe>` un
 * PDF y un `<pre>` un texto; lo que `viewKindFor` no reconoce se enseña como
 * "no se puede previsualizar", con su nombre, tamaño y tipo
 * (`unsupportedPreviewMessage`).
 *
 * ESTO NO SE HA PROBADO EN OBSIDIAN DE VERDAD, ni en escritorio ni en móvil:
 * el entorno de esta tarea no tiene Obsidian instalado. `Blob`,
 * `URL.createObjectURL` y `<img>`/`<iframe>` son APIs estándar del navegador
 * (Obsidian de escritorio es Electron y Obsidian móvil es un WebView, los dos
 * navegador), así que no deberían depender de una superficie nativa que a
 * `requestUrl` u otras piezas de Obsidian sí les falta en algún sitio. Pero es
 * una inferencia, no una medida: la iframe con un `blob:` puede toparse con
 * `Content-Security-Policy` del propio Obsidian, y un PDF de varios MB en
 * memoria en un móvil puede pesar de más. Queda como pendiente explícito de
 * QA manual, en escritorio y en un dispositivo, antes de darlo por cerrado.
 *
 * No pide los bytes hasta que el usuario pulsa «Abrir»: un adjunto puede pesar
 * hasta `MAX_ATTACHMENT_BYTES` (25 MB) y cargarlo antes de que haga falta
 * sería gastar red y memoria sin motivo. El blob se libera al cerrar el modal
 * (`URL.revokeObjectURL`), así que no queda memoria retenida más allá de su
 * vida.
 */

import { Component, Modal, type App } from 'obsidian';

import { describeFailure, type LumbreClient } from '../lumbre/client';
import type { LumbreAttachment } from '../lumbre/types';
import { unsupportedPreviewMessage, viewKindFor, type AttachmentViewKind } from './attachment-viewer';

export interface AttachmentPreviewModalOptions {
	client: LumbreClient;
	attachment: LumbreAttachment;
}

export class AttachmentPreviewModal extends Modal {
	/**
	 * Los listeners del DOM. `Modal` NO es un `Component` y no tiene
	 * `registerDomEvent`, así que el modal lleva el suyo: se carga al abrir y se
	 * descarga al cerrar, y con él se sueltan todos de una vez.
	 */
	private readonly events = new Component();
	/** El blob en memoria, para liberarlo al cerrar (`URL.revokeObjectURL`). */
	private objectUrl: string | null = null;
	/** `true` tras `onClose`: corta la carga en vuelo si el usuario cierra antes. */
	private closed = false;

	constructor(
		app: App,
		private readonly options: AttachmentPreviewModalOptions,
	) {
		super(app);
	}

	onOpen(): void {
		this.events.load();
		this.modalEl.addClass('lumbre-attachment-modal');
		this.setTitle(this.options.attachment.filename);
		void this.load();
	}

	onClose(): void {
		this.closed = true;
		this.events.unload();
		this.releaseBlob();
		this.contentEl.empty();
	}

	private releaseBlob(): void {
		if (this.objectUrl === null) return;
		URL.revokeObjectURL(this.objectUrl);
		this.objectUrl = null;
	}

	private async load(): Promise<void> {
		const { attachment } = this.options;
		const { contentEl } = this;
		contentEl.empty();

		const kind = viewKindFor(attachment.mime);
		if (kind === null) {
			contentEl.createDiv({
				cls: 'lumbre-attachment-modal__unsupported',
				text: unsupportedPreviewMessage(attachment),
			});
			return;
		}

		contentEl.createDiv({ cls: 'lumbre-attachment-modal__loading', text: 'Cargando…' });
		const read = await this.options.client.getAttachment(attachment.id);
		if (this.closed) return;
		contentEl.empty();

		if (!read.ok) {
			contentEl.createDiv({
				cls: 'lumbre-attachment-modal__error',
				text: `No se pudo abrir el adjunto. ${describeFailure(read.reason, read.status)}`,
			});
			return;
		}

		this.render(contentEl, kind, attachment.mime, read.value);
	}

	private render(
		root: HTMLElement,
		kind: AttachmentViewKind,
		mime: string,
		bytes: ArrayBuffer,
	): void {
		const blob = new Blob([bytes], { type: mime });
		const url = URL.createObjectURL(blob);
		this.objectUrl = url;

		if (kind === 'image') {
			const img = root.createEl('img', { cls: 'lumbre-attachment-modal__image' });
			img.src = url;
			img.alt = this.options.attachment.filename;
			return;
		}
		if (kind === 'pdf') {
			const frame = root.createEl('iframe', { cls: 'lumbre-attachment-modal__pdf' });
			frame.src = url;
			return;
		}
		const pre = root.createEl('pre', { cls: 'lumbre-attachment-modal__text' });
		pre.setText(new TextDecoder().decode(bytes));
	}
}
