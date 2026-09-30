import { networkInterfaces, userInfo } from "node:os";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	formatInvite,
	hostViaRelay,
	isRole,
	listenTcp,
	MultiplayerGuest,
	MultiplayerHost,
	type Participant,
	parseInvite,
	ROLES,
	type Role,
	type SessionEvent,
} from "@pi-multiplayer/core";
import { maskToken, normalizeRelayUrl, resolveRelay, saveName, savedName, saveRelay } from "./config.ts";
import { attribute, type SharedMessage, toSessionEvent } from "./events.ts";
import { SecretInput } from "./secret-input.ts";

const ENTRY_TYPE = "multiplayer";
const STATUS_KEY = "multiplayer";
const LIVE_WIDGET = "multiplayer-live";
const DEFAULT_PORT = 4817;
const DEFAULT_BIND = "127.0.0.1";
const LIVE_LINES = 8;

const USAGE = [
	"/mp start                         host this session (via your relay if one is configured, else direct)",
	"/mp start direct [port] [bind]    host directly on a TCP port (bind 0.0.0.0 for LAN/tailnet guests)",
	"/mp start relay                   host through the configured relay",
	"/mp relay <url>                   save your relay; asks for the host token with hidden input",
	"/mp relay [off]                   show or clear your relay settings",
	"/mp name [name]                   show or save your default display name",
	"/mp invite <viewer|contributor>   create an invite (prints a ready-to-run `pi --join …`)",
	"/mp who                           list participants and roles",
	"/mp role <name> <viewer|contributor>  change someone's role",
	"/mp kick <name>                   remove a participant",
	"/mp revoke [role]                 invalidate outstanding invites",
	"/mp approve <on|off>              require your approval for guest prompts",
	"/mp stop                          end hosting",
	"/mp join <invite> [name]          join someone else's session (or start pi with --join)",
	"/mp chat <message>                message participants without prompting the agent",
	"/mp leave                         leave the session you joined",
].join("\n");

type Hosting = { kind: "direct"; address: string; port: number } | { kind: "relay"; url: string; sessionId: string };

function advertisedAddress(bind: string): string {
	if (bind !== "0.0.0.0" && bind !== "::") return bind;
	for (const addresses of Object.values(networkInterfaces())) {
		const external = addresses?.find((a) => a.family === "IPv4" && !a.internal);
		if (external) return external.address;
	}
	return "127.0.0.1";
}

function defaultName(): string {
	try {
		return userInfo().username;
	} catch {
		return "pi-user";
	}
}

export default function multiplayer(pi: ExtensionAPI) {
	let ctx: ExtensionContext | undefined;
	let host: MultiplayerHost | undefined;
	let hosting: Hosting | undefined;
	let requireApproval = false;
	let guest: MultiplayerGuest | undefined;
	let liveText = "";
	/** Attributed texts of guest prompts we injected, so the echoed user message can be credited. */
	const pendingGuestPrompts: { author: string; text: string; injected: string }[] = [];

	pi.registerFlag("share", { description: "Share this session on startup (via the configured relay, else direct)", type: "boolean", default: false });
	pi.registerFlag("join", { description: "Join a shared pi session: pi --join <invite>", type: "string" });
	pi.registerFlag("as", { description: "Your display name when sharing or joining (default: OS username)", type: "string" });
	pi.registerFlag("mp-port", { description: "Port for direct sharing", type: "string", default: String(DEFAULT_PORT) });
	pi.registerFlag("mp-bind", { description: "Bind address for direct sharing", type: "string", default: DEFAULT_BIND });
	pi.registerFlag("mp-relay", { description: "Relay URL (overrides saved config)", type: "string" });
	pi.registerFlag("mp-relay-token", { description: "Relay host token (overrides saved config)", type: "string" });

	const displayName = () => (pi.getFlag("as") as string | undefined) || savedName(getAgentDir()) || defaultName();

	/** Asks for a secret without echoing it (TUI), falling back to a plain dialog in RPC mode. */
	const askSecret = async (title: string): Promise<string | undefined> => {
		if (!ctx?.hasUI) throw new Error("Pass the token as an argument or set PI_MULTIPLAYER_RELAY_TOKEN");
		if (ctx.mode === "tui") {
			const theme = ctx.ui.theme;
			return ctx.ui.custom<string | undefined>((tui, _theme, _keys, done) =>
				new SecretInput(title, tui, { title: (t) => theme.bold(theme.fg("accent", t)), dim: (t) => theme.fg("dim", t) }, done),
			);
		}
		return (await ctx.ui.input(title))?.trim() || undefined;
	};
	const relaySettings = () =>
		resolveRelay(getAgentDir(), {
			url: pi.getFlag("mp-relay") as string | undefined,
			token: pi.getFlag("mp-relay-token") as string | undefined,
		});

	const notify = (text: string, level: "info" | "warning" | "error" = "info") => {
		if (ctx?.hasUI) ctx.ui.notify(text, level);
	};

	const setStatus = () => {
		if (!ctx?.hasUI) return;
		if (host?.running && hosting) {
			const count = host.participants().length - 1;
			const where = hosting.kind === "relay" ? "via relay" : `:${hosting.port}`;
			ctx.ui.setStatus(STATUS_KEY, `⇄ hosting ${where} · ${count} guest${count === 1 ? "" : "s"}${requireApproval ? " · approval" : ""}`);
		} else if (guest?.connected && guest.me) {
			ctx.ui.setStatus(STATUS_KEY, `⇄ ${guest.me.name} (${guest.me.role})`);
		} else {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	};

	// ---------------------------------------------------------------- rendering (guest side)

	pi.registerEntryRenderer<SessionEvent>(ENTRY_TYPE, (entry, { expanded }, theme) => {
		const event = entry.data;
		if (!event) return undefined;
		switch (event.kind) {
			case "user":
				return new Text(`${theme.bold(theme.fg("accent", `${event.author} ›`))} ${event.text}`, 1, 1);
			case "assistant": {
				const calls = event.toolCalls.map((c) => theme.fg("dim", `→ ${c.name} ${c.args}`));
				return new Text([event.text, ...calls].filter(Boolean).join("\n"), 1, 0);
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
	});

	const renderLive = () => {
		if (!ctx?.hasUI) return;
		if (!liveText) return ctx.ui.setWidget(LIVE_WIDGET, undefined);
		const lines = liveText.split("\n").slice(-LIVE_LINES);
		ctx.ui.setWidget(LIVE_WIDGET, [ctx.ui.theme.fg("dim", "host agent is responding…"), ...lines]);
	};

	const receive = (event: SessionEvent) => {
		switch (event.kind) {
			case "delta":
				liveText += event.text;
				renderLive();
				return;
			case "status":
				if (!event.busy) {
					liveText = "";
					renderLive();
				}
				if (ctx?.hasUI) ctx.ui.setWorkingMessage(event.busy ? "host agent working…" : undefined);
				return;
			case "assistant":
				liveText = "";
				renderLive();
				break;
		}
		pi.appendEntry(ENTRY_TYPE, event);
	};

	// ---------------------------------------------------------------- hosting

	type StartMode = { kind: "auto" } | { kind: "relay" } | { kind: "direct"; port: number; bind: string };

	/** Starts hosting and returns a one-line description of where guests connect. */
	const startHosting = async (mode: StartMode): Promise<string> => {
		if (host?.running) throw new Error("Already hosting; /mp stop first");
		if (guest?.connected) throw new Error("Leave the session you joined before hosting");
		const relay = relaySettings();
		if (mode.kind === "relay" && !relay) throw new Error("No relay configured; run /mp relay <url> <token>");
		const instance = new MultiplayerHost({
			hostName: displayName(),
			onNotice: (text) => {
				notify(`multiplayer: ${text}`);
				setStatus();
			},
			onPrompt: (from, text) => deliverGuestPrompt(from, text),
		});
		let description: string;
		if (mode.kind !== "direct" && relay) {
			const { sessionId } = await hostViaRelay(instance, relay.url, relay.token, (reason) => {
				if (host !== instance) return;
				void instance.stop(reason);
				host = undefined;
				hosting = undefined;
				notify(`multiplayer: lost the relay connection (${reason}); guests were disconnected. /mp start to share again`, "error");
				setStatus();
			});
			hosting = { kind: "relay", url: relay.url, sessionId };
			description = `sharing via relay ${relay.url}`;
		} else {
			const port = mode.kind === "direct" ? mode.port : Number(pi.getFlag("mp-port")) || DEFAULT_PORT;
			const bind = mode.kind === "direct" ? mode.bind : (pi.getFlag("mp-bind") as string) || DEFAULT_BIND;
			const bound = await listenTcp(instance, port, bind);
			hosting = { kind: "direct", address: advertisedAddress(bind), port: bound };
			description = `sharing directly on ${hosting.address}:${bound}`;
		}
		host = instance;
		seedHistory(instance);
		setStatus();
		return description;
	};

	const createInvite = (role: Role): string => {
		const h = requireHost();
		const token = h.createInvite(role);
		if (!hosting) throw new Error("Not hosting");
		return hosting.kind === "relay"
			? formatInvite({ kind: "relay", url: hosting.url, sessionId: hosting.sessionId, token })
			: formatInvite({ kind: "direct", host: hosting.address, port: hosting.port, token });
	};

	/** Replays the conversation so far so that guests joining mid-session see what happened. */
	const seedHistory = (instance: MultiplayerHost) => {
		if (!ctx) return;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const event = toSessionEvent(entry.message as SharedMessage, (text) => ({ author: displayName(), text }), entry.timestamp ? Date.parse(entry.timestamp) : Date.now());
			if (event) instance.publish(event);
		}
	};

	const deliverGuestPrompt = async (from: Participant, text: string) => {
		if (requireApproval) {
			if (!ctx?.hasUI) throw new Error("Host cannot approve prompts right now");
			const ok = await ctx.ui.confirm(`Prompt from ${from.name}`, text);
			if (!ok) throw new Error("The host declined your prompt");
		}
		const injected = attribute(from.name, text);
		pendingGuestPrompts.push({ author: from.name, text, injected });
		if (ctx && !ctx.isIdle()) pi.sendUserMessage(injected, { deliverAs: "followUp" });
		else pi.sendUserMessage(injected);
		notify(`multiplayer: prompt from ${from.name}`);
	};

	const authorFor = (text: string) => {
		const index = pendingGuestPrompts.findIndex((p) => p.injected === text);
		if (index === -1) return { author: displayName(), text };
		const [match] = pendingGuestPrompts.splice(index, 1);
		return { author: match!.author, text: match!.text };
	};

	pi.on("message_end", (event) => {
		if (!host?.running) return;
		const shared = toSessionEvent(event.message as SharedMessage, authorFor);
		if (shared) host.publish(shared);
	});

	pi.on("message_update", (event) => {
		if (!host?.running) return;
		const update = event.assistantMessageEvent;
		if (update.type === "text_delta") host.publish({ kind: "delta", text: update.delta, ts: Date.now() });
	});

	pi.on("agent_start", () => host?.publish({ kind: "status", busy: true, ts: Date.now() }));
	pi.on("agent_settled", () => host?.publish({ kind: "status", busy: false, ts: Date.now() }));

	// ---------------------------------------------------------------- joining

	const join = async (code: string, name: string) => {
		if (host?.running) throw new Error("Stop hosting before joining another session");
		if (guest?.connected) throw new Error("Already in a session; /mp leave first");
		const invite = parseInvite(code);
		const client = new MultiplayerGuest({
			onEvent: receive,
			onParticipants: () => setStatus(),
			onRoleChange: (role) => {
				notify(`multiplayer: the host made you a ${role}`, "warning");
				setStatus();
			},
			onError: (message) => notify(`multiplayer: ${message}`, "error"),
			onClose: (reason) => {
				notify(`multiplayer: disconnected (${reason})`, "warning");
				guest = undefined;
				liveText = "";
				renderLive();
				if (ctx?.hasUI) ctx.ui.setWorkingMessage(undefined);
				setStatus();
			},
		});
		const welcome = await client.join(invite, name);
		guest = client;
		pi.appendEntry(ENTRY_TYPE, {
			kind: "system",
			text: `Joined ${invite.kind === "relay" ? `${new URL(invite.url).host} (relay)` : `${invite.host}:${invite.port}`} as ${welcome.me.name} (${welcome.me.role})`,
			ts: Date.now(),
		} satisfies SessionEvent);
		for (const event of welcome.history) pi.appendEntry(ENTRY_TYPE, event);
		if (welcome.busy && ctx?.hasUI) ctx.ui.setWorkingMessage("host agent working…");
		setStatus();
		return welcome.me;
	};

	// While joined, whatever the guest types goes to the host's agent instead of the local one.
	pi.on("input", (event) => {
		if (!guest?.connected || event.source === "extension") return { action: "continue" };
		const text = event.text.trim();
		if (!text) return { action: "handled" };
		try {
			guest.prompt(text);
		} catch (error) {
			notify(`multiplayer: ${(error as Error).message}. You can watch, but not prompt.`, "warning");
		}
		return { action: "handled" };
	});

	// ---------------------------------------------------------------- commands

	pi.registerCommand("mp", {
		description: "Share this session (host) or join someone else's (guest)",
		getArgumentCompletions: (prefix) => {
			const subs = ["start", "relay", "name", "invite", "who", "role", "kick", "revoke", "approve", "stop", "join", "chat", "leave"];
			const items = subs.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
			return items.length ? items : null;
		},
		handler: async (args, commandCtx) => {
			ctx = commandCtx;
			const [sub = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			try {
				switch (sub) {
					case "start": {
						let mode: StartMode = { kind: "auto" };
						if (rest[0] === "relay") mode = { kind: "relay" };
						else if (rest[0] === "direct" || /^\d+$/.test(rest[0] ?? "")) {
							const args = rest[0] === "direct" ? rest.slice(1) : rest;
							mode = { kind: "direct", port: args[0] ? Number(args[0]) : DEFAULT_PORT, bind: args[1] ?? DEFAULT_BIND };
						}
						const where = await startHosting(mode);
						notify(`multiplayer: ${where}. Create invites with /mp invite viewer|contributor`);
						return;
					}
					case "relay": {
						if (rest[0] === "off") {
							saveRelay(getAgentDir(), undefined);
							notify("multiplayer: relay settings cleared");
						} else if (rest.length >= 1) {
							const url = normalizeRelayUrl(rest[0]!);
							const token = rest[1] ?? (await askSecret(`Host token for ${url}`));
							if (!token) throw new Error("No token entered; relay not saved");
							saveRelay(getAgentDir(), { url, token });
							notify(`multiplayer: relay saved (${url}, token ${maskToken(token)}). /mp start now shares through it`);
						} else {
							const relay = relaySettings();
							notify(relay ? `multiplayer relay: ${relay.url} (token ${maskToken(relay.token)}, from ${relay.source})` : "multiplayer: no relay configured; /mp relay <url>");
						}
						return;
					}
					case "name": {
						if (rest[0] === "off") {
							saveName(getAgentDir(), undefined);
							notify(`multiplayer: default name cleared; using ${displayName()}`);
						} else if (rest[0]) {
							const name = rest.join(" ").slice(0, 40);
							saveName(getAgentDir(), name);
							notify(`multiplayer: default name set to ${name}${pi.getFlag("as") ? " (--as overrides it for this run)" : ""}`);
						} else {
							notify(`multiplayer: your name is ${displayName()}. Change it with /mp name <name>`);
						}
						return;
					}
					case "invite": {
						const role = rest[0] ?? "";
						if (!isRole(role)) throw new Error(`Role must be one of: ${ROLES.join(", ")}`);
						notify(`multiplayer ${role} invite: pi --join ${createInvite(role)}`);
						return;
					}
					case "who": {
						const list = host?.running ? host.participants() : guest?.participants;
						if (!list) throw new Error("Not in a multiplayer session");
						notify(`multiplayer participants:\n${list.map((p) => `  ${p.name} (${p.role})`).join("\n")}`);
						return;
					}
					case "role": {
						const [who, role = ""] = rest;
						if (!who || !isRole(role)) throw new Error(`Usage: /mp role <name> <${ROLES.join("|")}>`);
						const p = requireHost().setRole(who, role);
						notify(`multiplayer: ${p.name} is now a ${p.role}`);
						return;
					}
					case "kick": {
						if (!rest[0]) throw new Error("Usage: /mp kick <name>");
						const p = requireHost().kick(rest[0]);
						notify(`multiplayer: removed ${p.name}`);
						setStatus();
						return;
					}
					case "revoke": {
						const role = rest[0];
						if (role && !isRole(role)) throw new Error(`Role must be one of: ${ROLES.join(", ")}`);
						const count = requireHost().revokeInvites(role as never);
						notify(`multiplayer: revoked ${count} invite${count === 1 ? "" : "s"}`);
						return;
					}
					case "approve": {
						requireHost();
						if (rest[0] !== "on" && rest[0] !== "off") throw new Error("Usage: /mp approve <on|off>");
						requireApproval = rest[0] === "on";
						notify(`multiplayer: guest prompts ${requireApproval ? "need your approval" : "run without approval"}`);
						setStatus();
						return;
					}
					case "stop": {
						const stopping = requireHost();
						host = undefined;
						hosting = undefined;
						await stopping.stop();
						notify("multiplayer: stopped hosting");
						setStatus();
						return;
					}
					case "join": {
						if (!rest[0]) throw new Error("Usage: /mp join <invite> [name]");
						const me = await join(rest[0], rest[1] ?? displayName());
						notify(`multiplayer: joined as ${me.name} (${me.role})`);
						return;
					}
					case "chat": {
						const text = rest.join(" ");
						if (!text) throw new Error("Usage: /mp chat <message>");
						if (host?.running) host.publish({ kind: "chat", author: displayName(), text, ts: Date.now() });
						else if (guest?.connected) guest.chat(text);
						else throw new Error("Not in a multiplayer session");
						return;
					}
					case "leave": {
						if (!guest?.connected) throw new Error("Not in a joined session");
						guest.leave();
						return;
					}
					default:
						notify(USAGE);
				}
			} catch (error) {
				notify(`multiplayer: ${(error as Error).message}`, "error");
			}
		},
	});

	const requireHost = () => {
		if (!host?.running) throw new Error("Not hosting; run /mp start first");
		return host;
	};

	// ---------------------------------------------------------------- lifecycle

	pi.on("session_start", async (_event, startCtx) => {
		ctx = startCtx;
		try {
			const joinCode = pi.getFlag("join") as string | undefined;
			if (pi.getFlag("share") && !host?.running) {
				const where = await startHosting({ kind: "auto" });
				notify(`multiplayer: ${where}. Create invites with /mp invite viewer|contributor`);
			} else if (joinCode && !guest?.connected) {
				const me = await join(joinCode, displayName());
				notify(`multiplayer: joined as ${me.name} (${me.role})`);
			}
		} catch (error) {
			notify(`multiplayer: ${(error as Error).message}`, "error");
		}
	});

	// Other handlers get fresh contexts; keep the latest so socket callbacks can reach the UI.
	const remember = (_event: unknown, eventCtx: ExtensionContext) => {
		ctx = eventCtx;
	};
	pi.on("agent_start", remember);
	pi.on("turn_start", remember);

	pi.on("session_shutdown", async () => {
		guest?.leave();
		guest = undefined;
		await host?.stop("Host session closed");
		host = undefined;
		ctx = undefined;
	});
}
