import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import type { RelayHostMessage, RelayServerMessage } from "@pi-multiplayer/core";
import { type RawData, WebSocket, WebSocketServer } from "ws";

export const RELAY_PROTOCOL_VERSION = 1;
export const MIN_TOKEN_LENGTH = 24;

export interface RelayToken {
	/** Shown in logs instead of the token itself. */
	label: string;
	token: string;
}

export interface RelayOptions {
	/** Tokens that may host sessions. Guests never need one; they are admitted by the host's invites. */
	tokens: RelayToken[];
	maxSessionsPerToken?: number;
	maxGuestsPerSession?: number;
	maxMessageBytes?: number;
	/** Use X-Forwarded-For for client addresses (only behind a trusted reverse proxy). */
	trustProxy?: boolean;
	log?: (line: string) => void;
}

interface Session {
	id: string;
	label: string;
	host: WebSocket;
	guests: Map<string, WebSocket>;
	nextConn: number;
}

const AUTH_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = 30_000;
const FAILURE_WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 10;

const digest = (token: string) => createHash("sha256").update(token).digest();

/** Parses `RELAY_TOKENS`: comma-separated `label=token` pairs, or bare tokens. */
export function parseTokens(value: string): RelayToken[] {
	return value
		.split(/[,\n]/)
		.map((item) => item.trim())
		.filter(Boolean)
		.map((item, index) => {
			const eq = item.indexOf("=");
			return eq > 0 ? { label: item.slice(0, eq).trim(), token: item.slice(eq + 1).trim() } : { label: `token-${index + 1}`, token: item };
		});
}

export function generateToken(): string {
	return randomBytes(32).toString("base64url");
}

export class Relay {
	readonly server: Server;
	private readonly wss: WebSocketServer;
	private readonly sessions = new Map<string, Session>();
	private readonly tokenDigests: { label: string; digest: Buffer }[];
	private readonly failures = new Map<string, number[]>();
	private readonly alive = new WeakSet<WebSocket>();
	private heartbeat: NodeJS.Timeout | undefined;
	private readonly options: Required<Omit<RelayOptions, "tokens">>;

	constructor(options: RelayOptions) {
		if (options.tokens.length === 0) throw new Error("At least one host token is required");
		for (const { label, token } of options.tokens) {
			if (token.length < MIN_TOKEN_LENGTH) throw new Error(`Token "${label}" is shorter than ${MIN_TOKEN_LENGTH} characters`);
		}
		this.tokenDigests = options.tokens.map(({ label, token }) => ({ label, digest: digest(token) }));
		this.options = {
			maxSessionsPerToken: options.maxSessionsPerToken ?? 3,
			maxGuestsPerSession: options.maxGuestsPerSession ?? 25,
			maxMessageBytes: options.maxMessageBytes ?? 1024 * 1024,
			trustProxy: options.trustProxy ?? false,
			log: options.log ?? ((line) => console.log(`${new Date().toISOString()} ${line}`)),
		};
		this.wss = new WebSocketServer({ noServer: true, maxPayload: this.options.maxMessageBytes });
		this.server = createServer((req, res) => {
			if (req.url === "/healthz" || req.url?.endsWith("/healthz")) {
				res.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
				return;
			}
			// Counts only; lets supervisors (e.g. the Cloudflare Worker) avoid stopping a relay that is in use.
			if (req.url === "/stats" || req.url?.endsWith("/stats")) {
				res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(this.stats()));
				return;
			}
			res.writeHead(404, { "content-type": "text/plain" }).end("pi-multiplayer relay\n");
		});
		this.server.on("upgrade", (req, socket, head) => this.upgrade(req, socket, head));
	}

	async listen(port: number, host = "0.0.0.0"): Promise<number> {
		await new Promise<void>((resolve, reject) => {
			this.server.once("error", reject);
			this.server.listen(port, host, () => resolve());
		});
		this.heartbeat = setInterval(() => this.ping(), HEARTBEAT_MS);
		const address = this.server.address();
		return typeof address === "object" && address ? address.port : port;
	}

	async close(): Promise<void> {
		clearInterval(this.heartbeat);
		for (const session of this.sessions.values()) this.endSession(session, 1001, "Relay shutting down");
		for (const client of this.wss.clients) client.terminate();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}

	stats() {
		return {
			sessions: this.sessions.size,
			guests: [...this.sessions.values()].reduce((sum, s) => sum + s.guests.size, 0),
		};
	}

	private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
		const path = new URL(req.url ?? "/", "http://relay").pathname;
		const join = /\/join\/([\w-]+)$/.exec(path);
		const refuse = (status: number, message: string) => {
			socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
		};
		if (path.endsWith("/host")) {
			this.wss.handleUpgrade(req, socket, head, (ws) => this.acceptHost(ws, this.clientAddress(req)));
		} else if (join) {
			const session = this.sessions.get(join[1]!);
			if (!session) return refuse(404, "Unknown Session");
			if (session.guests.size >= this.options.maxGuestsPerSession) return refuse(503, "Session Full");
			this.wss.handleUpgrade(req, socket, head, (ws) => this.acceptGuest(session, ws));
		} else {
			refuse(404, "Not Found");
		}
	}

	private acceptHost(ws: WebSocket, address: string): void {
		this.track(ws);
		const send = (message: RelayServerMessage) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(message));
		const fail = (message: string) => {
			send({ type: "error", message });
			ws.close(4001, message.slice(0, 120));
		};
		const timer = setTimeout(() => fail("Timed out waiting for auth"), AUTH_TIMEOUT_MS);
		let session: Session | undefined;

		ws.on("message", (data, isBinary) => {
			const message = parse<RelayHostMessage>(data, isBinary);
			if (!message) return fail("Malformed message");
			if (!session) {
				clearTimeout(timer);
				if (message.type !== "auth") return fail("Expected auth");
				if (this.lockedOut(address)) return fail("Too many failed attempts; try again later");
				const label = this.authenticate(String(message.token ?? ""));
				if (!label) {
					this.recordFailure(address);
					this.options.log(`auth failed from ${address}`);
					return fail("Invalid relay token");
				}
				const active = [...this.sessions.values()].filter((s) => s.label === label).length;
				if (active >= this.options.maxSessionsPerToken) return fail(`Token "${label}" already has ${active} active sessions`);
				session = { id: randomBytes(16).toString("base64url"), label, host: ws, guests: new Map(), nextConn: 1 };
				this.sessions.set(session.id, session);
				this.options.log(`session ${session.id} opened by ${label} (${address})`);
				send({ type: "ready", sessionId: session.id });
				return;
			}
			const guest = "conn" in message ? session.guests.get(message.conn) : undefined;
			if (!guest) return;
			if (message.type === "send") {
				guest.send(JSON.stringify(message.data));
			} else if (message.type === "close") {
				if (message.data) guest.send(JSON.stringify(message.data));
				guest.close(1000, "Closed by host");
			}
		});
		ws.on("close", () => {
			clearTimeout(timer);
			if (session) this.endSession(session, 1001, "Host disconnected");
		});
		ws.on("error", () => {});
	}

	private acceptGuest(session: Session, ws: WebSocket): void {
		this.track(ws);
		const conn = String(session.nextConn++);
		session.guests.set(conn, ws);
		const toHost = (message: RelayServerMessage) => {
			if (session.host.readyState === WebSocket.OPEN) session.host.send(JSON.stringify(message));
		};
		toHost({ type: "open", conn });
		ws.on("message", (data, isBinary) => {
			const message = parse<unknown>(data, isBinary);
			if (message === undefined) return ws.close(1003, "Malformed message");
			toHost({ type: "recv", conn, data: message });
		});
		ws.on("close", () => {
			if (session.guests.delete(conn)) toHost({ type: "closed", conn });
		});
		ws.on("error", () => {});
	}

	private endSession(session: Session, code: number, reason: string): void {
		if (!this.sessions.delete(session.id)) return;
		for (const guest of session.guests.values()) guest.close(code, reason);
		session.guests.clear();
		if (session.host.readyState === WebSocket.OPEN) session.host.close(code, reason);
		this.options.log(`session ${session.id} closed (${reason})`);
	}

	private authenticate(token: string): string | undefined {
		const given = digest(token);
		let match: string | undefined;
		// Compare against every token so timing doesn't reveal which one (if any) matched.
		for (const { label, digest: expected } of this.tokenDigests) {
			if (timingSafeEqual(expected, given) && !match) match = label;
		}
		return match;
	}

	private recentFailures(address: string): number[] {
		const cutoff = Date.now() - FAILURE_WINDOW_MS;
		const recent = (this.failures.get(address) ?? []).filter((t) => t > cutoff);
		if (recent.length) this.failures.set(address, recent);
		else this.failures.delete(address);
		return recent;
	}

	private lockedOut(address: string): boolean {
		return this.recentFailures(address).length >= MAX_FAILURES;
	}

	private recordFailure(address: string): void {
		this.failures.set(address, [...this.recentFailures(address), Date.now()]);
	}

	private clientAddress(req: IncomingMessage): string {
		const forwarded = req.headers["x-forwarded-for"];
		if (this.options.trustProxy && typeof forwarded === "string") return forwarded.split(",")[0]!.trim();
		return req.socket.remoteAddress ?? "unknown";
	}

	private track(ws: WebSocket): void {
		this.alive.add(ws);
		ws.on("pong", () => this.alive.add(ws));
	}

	private ping(): void {
		for (const ws of this.wss.clients) {
			if (!this.alive.has(ws)) {
				ws.terminate();
				continue;
			}
			this.alive.delete(ws);
			ws.ping();
		}
	}
}

function parse<T>(data: RawData, isBinary: boolean): T | undefined {
	if (isBinary) return undefined;
	try {
		return JSON.parse(data.toString()) as T;
	} catch {
		return undefined;
	}
}
