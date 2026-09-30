import { type Component, decodeKittyPrintable, matchesKey, type TUI } from "@earendil-works/pi-tui";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

interface Styles {
	title: (text: string) => string;
	dim: (text: string) => string;
}

/** Single-line input that never renders what was typed or pasted — for secrets such as relay tokens. */
export class SecretInput implements Component {
	private value = "";
	private pasting = false;
	private readonly title: string;
	private readonly tui: TUI;
	private readonly styles: Styles;
	private readonly done: (value: string | undefined) => void;

	constructor(title: string, tui: TUI, styles: Styles, done: (value: string | undefined) => void) {
		this.title = title;
		this.tui = tui;
		this.styles = styles;
		this.done = done;
	}

	handleInput(data: string): void {
		if (data.includes(PASTE_START) || this.pasting) {
			this.pasting = !data.includes(PASTE_END);
			this.append(data.replace(PASTE_START, "").replace(PASTE_END, ""));
		} else if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			this.done(this.value.trim() || undefined);
			return;
		} else if (matchesKey(data, "escape")) {
			this.done(undefined);
			return;
		} else if (matchesKey(data, "backspace")) {
			this.value = this.value.slice(0, -1);
		} else if (matchesKey(data, "ctrl+u")) {
			this.value = "";
		} else {
			this.append(decodeKittyPrintable(data) ?? data);
		}
		this.tui.requestRender();
	}

	private append(text: string): void {
		this.value += text.replace(/[^\x21-\x7e]/g, "");
	}

	render(width: number): string[] {
		const dots = "•".repeat(Math.min(this.value.length, Math.max(8, width - 20)));
		return [
			this.styles.title(this.title),
			`  ${dots || this.styles.dim("(paste or type — input is hidden)")}${this.value ? this.styles.dim(`  ${this.value.length} chars`) : ""}`,
			this.styles.dim("  enter to save · esc to cancel · ctrl+u to clear"),
		];
	}

	invalidate(): void {}
}
