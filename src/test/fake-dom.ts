/**
 * Un DOM de mentira para los tests de bloques: lo justo de la API que Obsidian
 * inyecta en `HTMLElement` (`createDiv`, `createSpan`, `createEl`, `empty`,
 * `addClass`, `toggleClass`, `setAttribute`) y el global `createFragment`, sin
 * tirar de `jsdom`/`happy-dom` (dependencia nueva) para un plugin que no
 * necesita un DOM real en ningún otro test.
 *
 * Solo cubre lo que usan los bloques (`task-block.ts`): no es un DOM completo,
 * y no pretende serlo.
 */

export interface FakeElementOptions {
	cls?: string | string[];
	text?: string;
	attr?: Record<string, string>;
	type?: string;
}

export class FakeElement {
	readonly tagName: string;
	readonly children: FakeElement[] = [];
	parent: FakeElement | null = null;
	textContent = '';
	checked = false;
	disabled = false;
	type = '';

	private readonly classes = new Set<string>();
	private readonly attrs = new Map<string, string>();

	constructor(tagName: string) {
		this.tagName = tagName.toUpperCase();
	}

	private applyOptions(o?: FakeElementOptions | string): void {
		if (o === undefined) return;
		if (typeof o === 'string') {
			this.addClassList(o);
			return;
		}
		if (o.cls !== undefined) {
			for (const cls of Array.isArray(o.cls) ? o.cls : [o.cls]) this.addClassList(cls);
		}
		if (o.text !== undefined) this.textContent = o.text;
		if (o.type !== undefined) this.type = o.type;
		if (o.attr !== undefined) {
			for (const [name, value] of Object.entries(o.attr)) this.setAttribute(name, value);
		}
	}

	/** Como `cls: 'a b'` en Obsidian: cada palabra separada por espacios es SU
	 *  PROPIA clase (`classList.add(...cls.split(/\s+/))`), no una clase con un
	 *  espacio dentro. El código real del plugin depende de esto (`'lumbre-chip
	 *  lumbre-chip--pending'`, por ejemplo). */
	private addClassList(cls: string): void {
		for (const word of cls.split(/\s+/).filter((piece) => piece.length > 0)) this.addClass(word);
	}

	createDiv(o?: FakeElementOptions | string, cb?: (el: FakeElement) => void): FakeElement {
		return this.spawn('div', o, cb);
	}

	createSpan(o?: FakeElementOptions | string, cb?: (el: FakeElement) => void): FakeElement {
		return this.spawn('span', o, cb);
	}

	createEl(
		tag: string,
		o?: FakeElementOptions | string,
		cb?: (el: FakeElement) => void,
	): FakeElement {
		return this.spawn(tag, o, cb);
	}

	/**
	 * Lo que hacen `createDiv`/`createSpan`/`createEl` por dentro, en un único
	 * sitio con un nombre distinto: llamar a `this.createEl('div', ...)` desde
	 * dentro de `createDiv` dispara `obsidianmd/prefer-create-el` (la regla no
	 * distingue "esto ES la implementación" de "esto la está esquivando").
	 */
	private spawn(
		tag: string,
		o?: FakeElementOptions | string,
		cb?: (el: FakeElement) => void,
	): FakeElement {
		const el = new FakeElement(tag);
		el.applyOptions(o);
		this.appendChild(el);
		cb?.(el);
		return el;
	}

	appendChild(el: FakeElement): FakeElement {
		el.parent = this;
		this.children.push(el);
		return el;
	}

	empty(): void {
		this.children.length = 0;
	}

	addClass(cls: string): void {
		this.classes.add(cls);
	}

	toggleClass(cls: string, force: boolean): void {
		if (force) this.classes.add(cls);
		else this.classes.delete(cls);
	}

	hasClass(cls: string): boolean {
		return this.classes.has(cls);
	}

	setAttribute(name: string, value: string): void {
		this.attrs.set(name, value);
	}

	getAttribute(name: string): string | null {
		return this.attrs.get(name) ?? null;
	}

	/** Este elemento y sus descendientes para los que `predicate` da `true`. */
	findAll(predicate: (el: FakeElement) => boolean): FakeElement[] {
		const out: FakeElement[] = [];
		const walk = (el: FakeElement): void => {
			if (predicate(el)) out.push(el);
			for (const child of el.children) walk(child);
		};
		walk(this);
		return out;
	}
}

/** Como el `createFragment()` global de Obsidian: un elemento suelto. */
export function fakeFragment(): FakeElement {
	return new FakeElement('fragment');
}

/**
 * Instala `createFragment` como global, igual que hace el runtime real de
 * Obsidian. Lo llama el test ANTES de montar un bloque; nada más en el
 * paquete depende de esto.
 */
export function installFakeGlobalDom(): void {
	(globalThis as unknown as { createFragment: () => FakeElement }).createFragment = fakeFragment;
}
