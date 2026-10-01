import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import type { SessionEvent } from "@pi-multiplayer/core";
import { renderSessionEvent } from "../src/render.ts";

const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;

function renderPlain(event: SessionEvent, width = 80): string[] {
	const component = renderSessionEvent({ type: "custom", customType: "multiplayer", data: event } as never, { expanded: false }, plainTheme);
	assert.ok(component, "expected a component");
	return component.render(width).map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
}

describe("renderSessionEvent", () => {
	before(() => initTheme());

	it("renders the host's assistant replies as markdown, like the host sees them", () => {
		const lines = renderPlain({
			kind: "assistant",
			text: "- **Multi-provider redundancy:** every tier mixes providers.\n\nPer the repo rules, `appsettings.json` never contains model lists.",
			toolCalls: [],
			ts: 1,
		});
		assert.deepEqual(lines.filter(Boolean), [
			" - Multi-provider redundancy: every tier mixes providers.",
			" Per the repo rules, appsettings.json never contains model lists.",
		]);
	});

	it("lists the assistant's tool calls after its reply", () => {
		const lines = renderPlain({ kind: "assistant", text: "Reading it", toolCalls: [{ name: "read", args: '{"path":"a.ts"}' }], ts: 1 });
		assert.deepEqual(lines.filter(Boolean), [" Reading it", ' → read {"path":"a.ts"}']);
	});
});
