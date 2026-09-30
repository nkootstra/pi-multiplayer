// Relay transport: host and guests both dial out to a relay server over WebSocket, so nobody has to
// open ports. The relay authenticates hosts with a relay token and only forwards messages; invites,
// roles and permissions are still enforced by the host.
import type { GuestLink, LinkHandlers } from "./guest.ts";
import type { MultiplayerHost } from "./host.ts";
import {
	type ClientMessage,
	PROTOCOL_VERSION,
	type RelayHostMessage,
	type RelayServerMessage,
	type ServerMessage,
} from "./protocol.ts";

const CONNECT_TIMEOUT_MS = 15_000;

function endpoint(relayUrl: string, path: string): string {
	const url = new URL(relayUrl);
	if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error("Relay URL must start with ws:// or wss://");
	url.pathname = `${url.pathname.replace(/\/+$/, "")}${path}`;
	return url.toString();
}

function text(data: unknown): string {
	return typeof data === "string" ? data : Buffer.from(data as ArrayBuffer).toString("utf8");
}

export interface RelayHosting {
	sessionId: string;
}

/**
 * Registers the host with a relay. Resolves with the relay session id once the relay accepted the
 * token. `onLost` fires if the relay connection drops later (guests are disconnected by the relay).
 */
export function hostViaRelay(
	host: MultiplayerHost,
	relayUrl: string,
	relayToken: string,
	onLost: (reason: string) => void,
): Promise<RelayHosting> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(endpoint(relayUrl, "/host"));
		const peers = new Map<string, ReturnType<MultiplayerHost["connect"]>>();
		let ready = false;
		let closing = false;
		const send = (message: RelayHostMessage) => {
			if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
		};
		const transport = {
			close: () => {
				closing = true;
				ws.close(1000, "Host ended the session");
			},
		};
		const timer = setTimeout(() => {
			ws.close();
			reject(new Error("Timed out connecting to the relay"));
		}, CONNECT_TIMEOUT_MS);

		ws.addEventListener("open", () => send({ type: "auth", token: relayToken, protocol: PROTOCOL_VERSION }));
		ws.addEventListener("message", (event) => {
			let message: RelayServerMessage;
			try {
				message = JSON.parse(text(event.data));
			} catch {
				return;
			}
			switch (message.type) {
				case "ready":
					ready = true;
					clearTimeout(timer);
					host.addTransport(transport);
					resolve({ sessionId: message.sessionId });
					return;
				case "error":
					if (!ready) {
						clearTimeout(timer);
						reject(new Error(`Relay refused: ${message.message}`));
					}
					return;
				case "open": {
					const conn = message.conn;
					peers.set(
						conn,
						host.connect({
							send: (data) => send({ type: "send", conn, data }),
							end: (data) => {
								send({ type: "close", conn, data });
								peers.get(conn)?.closed();
								peers.delete(conn);
							},
						}),
					);
					return;
				}
				case "recv":
					peers.get(message.conn)?.receive(message.data);
					return;
				case "closed":
					peers.get(message.conn)?.closed();
					peers.delete(message.conn);
					return;
			}
		});
		// A refused handshake only fires "error" (no "close") in Node's WebSocket.
		ws.addEventListener("error", () => {
			if (ready) return;
			clearTimeout(timer);
			reject(new Error(`Could not connect to relay at ${relayUrl}`));
		});
		ws.addEventListener("close", (event) => {
			clearTimeout(timer);
			for (const peer of peers.values()) peer.closed();
			peers.clear();
			if (!ready) {
				reject(new Error(event.reason || `Could not connect to relay (code ${event.code})`));
				return;
			}
			host.removeTransport(transport);
			if (!closing) onLost(event.reason || "Relay connection lost");
		});
	});
}

export function openRelayLink(relayUrl: string, sessionId: string, handlers: LinkHandlers): GuestLink {
	const ws = new WebSocket(endpoint(relayUrl, `/join/${encodeURIComponent(sessionId)}`));
	let opened = false;
	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		handlers.onClose();
	};
	ws.addEventListener("open", () => {
		opened = true;
		handlers.onOpen();
	});
	ws.addEventListener("message", (event) => {
		try {
			handlers.onMessage(JSON.parse(text(event.data)) as ServerMessage);
		} catch {
			ws.close();
		}
	});
	ws.addEventListener("error", () => {
		// A refused handshake (unknown session, session full) only fires "error" in Node's WebSocket.
		if (opened) return;
		handlers.onError("Could not join: the relay is unreachable, or the session has ended or is full");
		close();
	});
	ws.addEventListener("close", (event) => {
		if (event.reason) handlers.onError(event.reason);
		close();
	});
	return {
		send: (message: ClientMessage) => {
			if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
		},
		close: () => ws.close(1000, "Guest left"),
	};
}
