import { type EntryRenderer, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import type { SessionEvent } from "@pi-multiplayer/core";

/** Renders a shared session event in a guest's transcript. */
export const renderSessionEvent: EntryRenderer<SessionEvent> = (entry, { expanded }, theme) => {
	const event = entry.data;
	if (!event) return undefined;
	switch (event.kind) {
		case "user":
			return new Text(`${theme.bold(theme.fg("accent", `${event.author} ›`))} ${event.text}`, 1, 1);
		case "assistant": {
			// Same component and theme pi uses for its own assistant messages, so guests see what the host sees.
			const reply = new Container();
			if (event.text.trim()) reply.addChild(new Markdown(event.text.trim(), 1, 0, getMarkdownTheme()));
			const calls = event.toolCalls.map((c) => theme.fg("dim", `→ ${c.name} ${c.args}`));
			if (calls.length > 0) reply.addChild(new Text(calls.join("\n"), 1, 0));
			return reply;
		}
		case "tool": {
			const lines = event.output.split("\n");
			const shown = expanded ? lines : lines.slice(0, 3);
			const more = lines.length > shown.length ? theme.fg("dim", `\n  … ${lines.length - shown.length} more lines`) : "";
			const head = theme.fg(event.isError ? "error" : "success", `${event.isError ? "✗" : "✓"} ${event.name}`);
			return new Text(`${head}\n${theme.fg("muted", shown.join("\n"))}${more}`, 1, 0);
		}
		case "chat":
			return new Text(theme.fg("muted", `💬 ${theme.bold(event.author)}: ${event.text}`), 1, 0);
		case "system":
			return new Text(theme.fg("dim", `• ${event.text}`), 1, 0);
		default:
			return undefined;
	}
};
