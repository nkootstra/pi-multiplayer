import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { attribute, toSessionEvent, truncate } from "../src/events.ts";

const hostAuthor = (text: string) => ({ author: "alice", text });

describe("toSessionEvent", () => {
	it("shares user prompts with their author", () => {
		assert.deepEqual(toSessionEvent({ role: "user", content: "hi" }, hostAuthor, 1), {
			kind: "user",
			author: "alice",
			text: "hi",
			ts: 1,
		});
		assert.deepEqual(
			toSessionEvent({ role: "user", content: [{ type: "text", text: "a" }, { type: "image" }] }, hostAuthor, 1),
			{ kind: "user", author: "alice", text: "a", ts: 1 },
		);
	});

	it("shares assistant text and tool calls but not thinking", () => {
		const event = toSessionEvent(
			{
				role: "assistant",
				content: [
					{ type: "thinking", text: "secret" },
					{ type: "text", text: "Reading it" },
					{ type: "toolCall", name: "read", arguments: { path: "a.ts" } },
				],
			},
			hostAuthor,
			1,
		);
		assert.deepEqual(event, {
			kind: "assistant",
			text: "Reading it",
			toolCalls: [{ name: "read", args: '{"path":"a.ts"}' }],
			ts: 1,
		});
	});

	it("truncates long tool output", () => {
		const event = toSessionEvent(
			{ role: "toolResult", toolName: "bash", isError: false, content: [{ type: "text", text: "x".repeat(5000) }] },
			hostAuthor,
		);
		assert.equal(event?.kind, "tool");
		assert.ok(event?.kind === "tool" && event.output.length < 2100);
	});

	it("skips messages with nothing to show", () => {
		assert.equal(toSessionEvent({ role: "assistant", content: [] }, hostAuthor), undefined);
		assert.equal(toSessionEvent({ role: "custom" }, hostAuthor), undefined);
	});

	it("formats attribution and truncation", () => {
		assert.equal(attribute("bob", "do x"), "[bob] do x");
		assert.equal(truncate("abcdef", 3), "abc… (3 more chars)");
	});
});
