import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TUI } from "@earendil-works/pi-tui";
import { SecretInput } from "../src/secret-input.ts";

function setup() {
	const results: (string | undefined)[] = [];
	const tui = { requestRender: () => {} } as unknown as TUI;
	const input = new SecretInput("Token", tui, { title: (t) => t, dim: (t) => t }, (v) => results.push(v));
	return { input, results };
}

describe("SecretInput", () => {
	it("never renders the secret, only its length", () => {
		const { input, results } = setup();
		input.handleInput("\x1b[200~super-secret-token\x1b[201~");
		const screen = input.render(80).join("\n");
		assert.doesNotMatch(screen, /super|secret/);
		assert.match(screen, /18 chars/);
		input.handleInput("\r");
		assert.deepEqual(results, ["super-secret-token"]);
	});

	it("handles typing, backspace, clearing and cancel", () => {
		const { input, results } = setup();
		for (const ch of "abcd") input.handleInput(ch);
		input.handleInput("\x7f");
		input.handleInput("\r");
		assert.deepEqual(results, ["abc"]);

		const second = setup();
		second.input.handleInput("abc");
		second.input.handleInput("\x15"); // ctrl+u
		second.input.handleInput("\x1b");
		assert.deepEqual(second.results, [undefined]);
	});

	it("drops whitespace and control characters from pastes", () => {
		const { input, results } = setup();
		input.handleInput("\x1b[200~ tok\nen \x1b[201~");
		input.handleInput("\r");
		assert.deepEqual(results, ["token"]);
	});
});
