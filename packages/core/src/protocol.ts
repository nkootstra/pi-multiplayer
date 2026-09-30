// Wire protocol shared by host and guests: newline-delimited JSON over TCP.

export const PROTOCOL_VERSION = 1;
export const INVITE_SCHEME = "pimp://";
/** Frames larger than this are rejected to keep a misbehaving peer from exhausting memory. */
export const MAX_FRAME_BYTES = 1024 * 1024;

export type Role = "viewer" | "contributor";

export interface Participant {
	id: string;
	name: string;
	role: Role | "host";
}

/** Something that happened in the shared session, as seen by every participant. */
export type SessionEvent =
	| { kind: "user"; author: string; text: string; ts: number }
	| { kind: "assistant"; text: string; toolCalls: { name: string; args: string }[]; ts: number }
	| { kind: "tool"; name: string; isError: boolean; output: string; ts: number }
	| { kind: "chat"; author: string; text: string; ts: number }
	| { kind: "system"; text: string; ts: number }
	| { kind: "status"; busy: boolean; ts: number }
	| { kind: "delta"; text: string; ts: number };

export type ClientMessage =
	| { type: "hello"; protocol: number; token: string; name: string }
	| { type: "prompt"; text: string }
	| { type: "chat"; text: string };

export type ServerMessage =
	| { type: "welcome"; you: Participant; participants: Participant[]; history: SessionEvent[]; busy: boolean }
	| { type: "event"; event: SessionEvent }
	| { type: "participants"; participants: Participant[] }
	| { type: "role"; role: Role }
	| { type: "error"; message: string }
	| { type: "bye"; reason: string };

/** Direct invites point at the host's own TCP port; relay invites point at a session on a relay server. */
export type Invite =
	| { kind: "direct"; host: string; port: number; token: string }
	| { kind: "relay"; url: string; sessionId: string; token: string };

const RELAY_SCHEMES = ["pimp+wss://", "pimp+ws://"];

export function formatInvite(invite: Invite): string {
	if (invite.kind === "relay") {
		const url = invite.url.replace(/\/+$/, "");
		return `pimp+${url}/s/${invite.sessionId}/${invite.token}`;
	}
	const host = invite.host.includes(":") ? `[${invite.host}]` : invite.host;
	return `${INVITE_SCHEME}${host}:${invite.port}/${invite.token}`;
}

export function parseInvite(code: string): Invite {
	const trimmed = code.trim();
	if (RELAY_SCHEMES.some((scheme) => trimmed.startsWith(scheme))) {
		const match = /^pimp\+(wss?:\/\/.+)\/s\/([\w-]+)\/([\w-]+)$/.exec(trimmed);
		if (!match) throw new Error("Malformed relay invite code");
		const [, url, sessionId, token] = match;
		new URL(url!); // validates host/port
		return { kind: "relay", url: url!, sessionId: sessionId!, token: token! };
	}
	if (!trimmed.startsWith(INVITE_SCHEME)) throw new Error(`Invite must start with ${INVITE_SCHEME} or pimp+wss://`);
	const url = new URL(`http://${trimmed.slice(INVITE_SCHEME.length)}`);
	const token = url.pathname.replace(/^\//, "");
	const port = Number(url.port);
	if (!url.hostname || !port || !token) throw new Error("Malformed invite code");
	return { kind: "direct", host: url.hostname.replace(/^\[|\]$/g, ""), port, token };
}

// Relay control channel between a host and the relay server. Guests speak the normal
// ClientMessage/ServerMessage protocol over their WebSocket; the relay only forwards it.

export type RelayHostMessage =
	| { type: "auth"; token: string; protocol: number }
	| { type: "send"; conn: string; data: ServerMessage }
	| { type: "close"; conn: string; data?: ServerMessage };

export type RelayServerMessage =
	| { type: "ready"; sessionId: string }
	| { type: "error"; message: string }
	| { type: "open"; conn: string }
	| { type: "recv"; conn: string; data: unknown }
	| { type: "closed"; conn: string };

/** Splits an incoming byte stream into JSON frames, one per LF-terminated line. */
export class FrameDecoder {
	private buffer = "";

	push(chunk: string): unknown[] {
		this.buffer += chunk;
		const frames: unknown[] = [];
		let newline = this.buffer.indexOf("\n");
		while (newline !== -1) {
			const line = this.buffer.slice(0, newline).replace(/\r$/, "");
			this.buffer = this.buffer.slice(newline + 1);
			if (line.length > 0) frames.push(JSON.parse(line));
			newline = this.buffer.indexOf("\n");
		}
		if (Buffer.byteLength(this.buffer) > MAX_FRAME_BYTES) throw new Error("Frame too large");
		return frames;
	}
}

export function encodeFrame(message: ClientMessage | ServerMessage): string {
	return `${JSON.stringify(message)}\n`;
}
