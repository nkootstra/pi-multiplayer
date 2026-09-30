import type { SessionEvent } from "@pi-multiplayer/core";

const TOOL_OUTPUT_LIMIT = 2000;
const TOOL_ARGS_LIMIT = 300;

/** The subset of pi's AgentMessage shapes the extension shares with guests. */
export type SharedMessage =
	| { role: "user"; content: string | { type: string; text?: string }[] }
	| { role: "assistant"; content: { type: string; text?: string; name?: string; arguments?: unknown }[]; errorMessage?: string }
	| { role: "toolResult"; toolName: string; isError: boolean; content: { type: string; text?: string }[] }
	| { role: string };

export function truncate(text: string, limit: number): string {
	return text.length > limit ? `${text.slice(0, limit)}… (${text.length - limit} more chars)` : text;
}

function textOf(content: string | { type: string; text?: string }[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((part) => part.type === "text" && part.text)
		.map((part) => part.text)
		.join("\n");
}

/** Prefix that attributes a guest's prompt in the shared transcript and in the agent's context. */
export function attribute(author: string, text: string): string {
	return `[${author}] ${text}`;
}

/**
 * Converts a finalized pi message into a shareable event. `authorFor` resolves who wrote a user
 * message (guest prompts are injected by the extension, host prompts are typed locally).
 */
export function toSessionEvent(
	message: SharedMessage,
	authorFor: (text: string) => { author: string; text: string },
	ts = Date.now(),
): SessionEvent | undefined {
	if (message.role === "user" && "content" in message) {
		const text = textOf(message.content as string | { type: string; text?: string }[]);
		if (!text) return undefined;
		return { kind: "user", ...authorFor(text), ts };
	}
	if (message.role === "assistant" && "content" in message && Array.isArray(message.content)) {
		const content = message.content as { type: string; text?: string; name?: string; arguments?: unknown }[];
		const text = textOf(content as { type: string; text?: string }[]);
		const toolCalls = content
			.filter((part) => part.type === "toolCall")
			.map((part) => ({ name: String(part.name), args: truncate(JSON.stringify(part.arguments ?? {}), TOOL_ARGS_LIMIT) }));
		const error = "errorMessage" in message && message.errorMessage ? `\n[error] ${message.errorMessage}` : "";
		if (!text && toolCalls.length === 0 && !error) return undefined;
		return { kind: "assistant", text: text + error, toolCalls, ts };
	}
	if (message.role === "toolResult" && "toolName" in message) {
		return {
			kind: "tool",
			name: message.toolName,
			isError: message.isError,
			output: truncate(textOf(message.content), TOOL_OUTPUT_LIMIT),
			ts,
		};
	}
	return undefined;
}
