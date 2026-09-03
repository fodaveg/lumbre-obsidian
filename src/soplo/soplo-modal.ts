/**
 * Modal de «Soplo con la selección».
 *
 * La regla del lote, y la única que importa aquí: **la IA propone y el usuario
 * confirma**. Nada se aplica sin el clic en «Aplicar». El servidor ya lo
 * garantiza por su lado (`POST /api/agent` corre siempre en modo
 * previsualización y no encola nada), y este modal es la otra mitad: enseña el
 * texto que se mandó, la lista de acciones con su casilla, y solo manda las
 * marcadas.
 *
 * Tres estados y los tres se ven:
 *
 * - Cargando: Soplo tarda (es una llamada a un modelo), así que el modal se abre
 *   YA, con el texto arriba y «Preguntando a Soplo…» debajo. Antes de mandar el
 *   texto se pregunta por el consentimiento: si Lumbre dice que falta, el texto
 *   de la nota NO sale del dispositivo.
 * - Error: se pinta DENTRO del modal, no en un Notice que se va solo. Si el
 *   fallo es la falta de consentimiento, con el enlace a los ajustes de la web.
 * - Enviando: los botones se deshabilitan mientras se encola.
 *
 * El modal no habla con la red: recibe una función que pregunta y otra que
 * aplica, las dos inyectadas por `main.ts`.
 */

import { Modal, setIcon, type App } from 'obsidian';

import type { AgentConsentState, AgentPlan, LumbreResult } from '../lumbre/client';

/** Dónde se retira o se da el consentimiento de Soplo, en la web de Lumbre. */
export const SOPLO_SETTINGS_PATH = '/settings';

export interface SoploModalOptions {
	/** El texto que se manda, ya recortado al tope del servidor. */
	text: string;
	/** `true` si hubo que recortarlo: se avisa arriba, no en silencio. */
	truncated: boolean;
	/**
	 * Si la cuenta ha dado ya el consentimiento de Soplo. Se consulta ANTES de
	 * mandar nada; `unknown` significa "no se ha podido saber" y se sigue igual.
	 */
	consent(): Promise<AgentConsentState>;
	/** Pregunta a Soplo. Se llama una vez al abrir, y otra por cada «Reintentar». */
	ask(): Promise<LumbreResult<AgentPlan>>;
	/** Aplica las acciones marcadas, por sus índices dentro del plan. */
	apply(plan: AgentPlan, checked: boolean[]): Promise<void>;
	/** Abre una URL. En el plugin es `window.open`. */
	openUrl(url: string): void;
	/** Origen web de Lumbre, para el enlace de los ajustes. */
	webOrigin(): string;
}

type ModalState = 'loading' | 'ready' | 'error' | 'applying';

export class SoploModal extends Modal {
	private state: ModalState = 'loading';
	private plan: AgentPlan | null = null;
	private checked: boolean[] = [];
	private error: string | null = null;
	/** `true` cuando el fallo es que falta el consentimiento (un 403 del endpoint). */
	private needsConsent = false;
	private closed = false;

	constructor(
		app: App,
		private readonly options: SoploModalOptions,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass('lumbre-soplo');
		this.setTitle('Soplo');

		// Enter aplica lo marcado; el Esc que cierra lo pone Obsidian. Dentro de una
		// casilla NO, que ahí Enter es "marcar" y aplicaría sin querer.
		this.contentEl.addEventListener('keydown', (event: KeyboardEvent) => {
			if (event.key !== 'Enter' || event.isComposing) return;
			if (event.target instanceof HTMLInputElement) return;
			if (this.state !== 'ready') return;
			event.preventDefault();
			void this.apply();
		});

		this.render();
		void this.ask();
	}

	onClose(): void {
		this.closed = true;
		this.contentEl.empty();
	}

	// ── Preguntar ────────────────────────────────────────────────────────────

	private async ask(): Promise<void> {
		this.state = 'loading';
		this.error = null;
		this.needsConsent = false;
		this.render();

		// Con el consentimiento sabido que FALTA, el texto de la nota no se manda:
		// la respuesta ya se conoce (un 403) y mandarlo sería sacar del dispositivo
		// algo que Lumbre va a rechazar. Con `unknown` se sigue como siempre, que es
		// mandar y tratar el 403 del POST: `unknown` no autoriza a decidir nada.
		const consent = await this.options.consent();
		if (this.closed) return;
		if (consent === 'missing') {
			this.state = 'error';
			this.needsConsent = true;
			this.error = 'Soplo necesita tu consentimiento antes de mandarle texto.';
			this.render();
			return;
		}

		const result = await this.options.ask();
		if (this.closed) return;

		if (!result.ok) {
			this.state = 'error';
			// El 403 de la propia llamada sigue siendo señal de que falta: es lo que
			// cubre a un Lumbre que todavía no acepta el Bearer en `/api/agent/consent`
			// y por tanto devuelve `unknown` ahí arriba.
			this.needsConsent = result.reason === 'unauthorized' && result.status === 403;
			this.error = this.needsConsent
				? 'Soplo necesita tu consentimiento antes de mandarle texto.'
				: describeAskFailure(result.reason, result.status);
			this.render();
			return;
		}

		this.plan = result.value;
		// Todas marcadas: lo que Soplo propone es lo que suele querer aplicarse, y
		// desmarcar lo que sobra es menos trabajo que marcar lo que vale.
		this.checked = result.value.plan.map(() => true);
		this.state = 'ready';
		this.render();
	}

	// ── Pintado ──────────────────────────────────────────────────────────────

	private render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass('lumbre-soplo__content');

		this.renderSource(root);

		switch (this.state) {
			case 'loading':
				root.createDiv({ cls: 'lumbre-empty', text: 'Preguntando a Soplo…' });
				return;
			case 'error':
				this.renderError(root);
				return;
			case 'ready':
			case 'applying':
				this.renderPlan(root);
		}
	}

	private renderSource(root: HTMLElement): void {
		const block = root.createDiv({ cls: 'lumbre-soplo__source' });
		block.createDiv({ cls: 'lumbre-soplo__label', text: 'Lo que se manda' });
		block.createDiv({ cls: 'lumbre-soplo__text', text: this.options.text });
		if (this.options.truncated) {
			block.createDiv({
				cls: 'lumbre-soplo__warning',
				text: 'El texto era más largo de 4000 caracteres y se ha recortado.',
			});
		}
	}

	private renderError(root: HTMLElement): void {
		const box = root.createDiv({ cls: 'lumbre-notice lumbre-notice--error' });
		box.createSpan({ text: this.error ?? 'Soplo no ha podido responder.' });

		const actions = root.createDiv({ cls: 'lumbre-soplo__actions' });
		if (this.needsConsent) {
			this.button(actions, {
				text: 'Abrir los ajustes de Lumbre',
				icon: 'external-link',
				cta: true,
				onClick: () => {
					const origin = this.options.webOrigin().replace(/\/+$/, '');
					this.options.openUrl(`${origin}${SOPLO_SETTINGS_PATH}`);
				},
			});
		} else {
			this.button(actions, {
				text: 'Reintentar',
				icon: 'rotate-ccw',
				onClick: () => {
					void this.ask();
				},
			});
		}
		this.button(actions, {
			text: 'Cerrar',
			onClick: () => {
				this.close();
			},
		});
	}

	private renderPlan(root: HTMLElement): void {
		const plan = this.plan;
		if (plan === null) return;

		if (plan.summary !== null && plan.summary.length > 0) {
			root.createDiv({ cls: 'lumbre-soplo__summary', text: plan.summary });
		}

		if (plan.preview.length === 0) {
			root.createDiv({ cls: 'lumbre-empty', text: 'Soplo no ha encontrado acciones.' });
			const actions = root.createDiv({ cls: 'lumbre-soplo__actions' });
			this.button(actions, {
				text: 'Cerrar',
				onClick: () => {
					this.close();
				},
			});
			return;
		}

		const list = root.createDiv({ cls: 'lumbre-soplo__list' });
		const applying = this.state === 'applying';
		for (const [index, item] of plan.preview.entries()) {
			const row = list.createDiv({ cls: 'lumbre-soplo__item' });
			const box = row.createEl('input', { type: 'checkbox', cls: 'lumbre-soplo__check' });
			box.checked = this.checked[index] === true;
			box.disabled = applying;
			box.setAttribute('aria-label', `Aplicar: ${item.text}`);
			box.addEventListener('change', () => {
				this.checked[index] = box.checked;
				this.updateApplyButton();
			});
			row.createSpan({ cls: 'lumbre-soplo__item-text', text: item.text });
		}

		const actions = root.createDiv({ cls: 'lumbre-soplo__actions' });
		this.button(actions, {
			text: 'Cancelar',
			onClick: () => {
				this.close();
			},
		}).disabled = applying;
		const apply = this.button(actions, {
			text: applying ? 'Aplicando…' : 'Aplicar',
			icon: 'check',
			cta: true,
			onClick: () => {
				void this.apply();
			},
		});
		apply.addClass('lumbre-soplo__apply');
		apply.disabled = applying || this.checkedCount() === 0;

		// El foco entra en la primera casilla: desde ahí se recorre la lista con el
		// tabulador y se aplica con Enter, sin tocar el ratón.
		if (!applying) {
			window.setTimeout(() => {
				list.querySelector<HTMLInputElement>('.lumbre-soplo__check')?.focus();
			}, 0);
		}
	}

	/** Refresca solo el botón de aplicar: repintar entero perdería el foco. */
	private updateApplyButton(): void {
		const apply = this.contentEl.querySelector<HTMLButtonElement>('.lumbre-soplo__apply');
		if (apply === null) return;
		apply.disabled = this.state === 'applying' || this.checkedCount() === 0;
	}

	private checkedCount(): number {
		return this.checked.filter((flag) => flag).length;
	}

	// ── Aplicar ──────────────────────────────────────────────────────────────

	private async apply(): Promise<void> {
		const plan = this.plan;
		if (plan === null || this.checkedCount() === 0) return;

		this.state = 'applying';
		this.render();

		await this.options.apply(plan, [...this.checked]);
		if (this.closed) return;
		this.close();
	}

	private button(
		parent: HTMLElement,
		options: { text: string; icon?: string; cta?: boolean; onClick: () => void },
	): HTMLButtonElement {
		const button = parent.createEl('button', {
			cls: options.cta === true ? 'lumbre-button lumbre-button--cta' : 'lumbre-button',
		});
		if (options.icon !== undefined) {
			const icon = button.createSpan({ cls: 'lumbre-button__icon' });
			setIcon(icon, options.icon);
		}
		button.createSpan({ text: options.text });
		button.addEventListener('click', options.onClick);
		return button;
	}
}

/** El motivo del fallo, con el matiz que le toca a esta llamada. */
function describeAskFailure(reason: string, status?: number): string {
	if (reason === 'rate_limited') return 'Soplo está recibiendo demasiadas peticiones; espera un momento.';
	if (reason === 'network') return 'No se pudo conectar con Lumbre.';
	if (reason === 'no_token') return 'Falta el token personal de Lumbre.';
	if (reason === 'unauthorized') return 'El token no vale o ha caducado.';
	if (status === 503) return 'Soplo no está disponible ahora mismo en tu servidor de Lumbre.';
	return status === undefined
		? 'Soplo respondió con un error.'
		: `Soplo respondió con un error (${status}).`;
}
