import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { can } from "./permissions.ts";
import {
	type ClientMessage,
	type Participant,
	PROTOCOL_VERSION,
	type Role,
	type ServerMessage,
	type SessionEvent,
} from "./protocol.ts";

const HISTORY_LIMIT = 200;
const HELLO_TIMEOUT_MS = 10_000;

export interface HostOptions {
	hostName: string;
	/** Runs a contributor's prompt against the shared agent. Throwing rejects it and the error is sent back. */
	onPrompt: (from: Participant, text: string) => Promise<void> | void;
	/** Human-readable notices for the host (joins, leaves, rejected actions). */
	onNotice?: (text: string) => void;
}

/** One guest connection as seen by the host, independent of how it arrived (direct TCP or relay). */
export interface PeerLink {
	send(message: ServerMessage): void;
	/** Sends an optional final message, then closes the connection. */
	end(final?: ServerMessage): void;
}

/** What a transport calls into when a peer sends a message or goes away. */
export interface PeerHandle {
	receive(message: unknown): void;
	closed(): void;
}

/** A way guests reach this host. The host closes every transport when it stops. */
export interface HostTransport {
	close(): Promise<void> | void;
}

interface Guest {
	participant: Participant & { role: Role };
	link: PeerLink;
}

export class MultiplayerHost {
	private readonly transports = new Set<HostTransport>();
	private readonly guests = new Map<string, Guest>();
	private readonly invites = new Map<string, Role>();
	private readonly history: SessionEvent[] = [];
	private busy = false;
	private readonly options: HostOptions;

	constructor(options: HostOptions) {
		this.options = options;
	}

	get running(): boolean {
		return this.transports.size > 0;
	}

	addTransport(transport: HostTransport): void {
		this.transports.add(transport);
	}

	/** Drops a transport that died on its own (e.g. the relay went away) and disconnects its guests' bookkeeping. */
	removeTransport(transport: HostTransport): void {
		this.transports.delete(transport);
	}

	async stop(reason = "Host ended the session"): Promise<void> {
		for (const guest of this.guests.values()) guest.link.end({ type: "bye", reason });
		this.guests.clear();
		const transports = [...this.transports];
		this.transports.clear();
		await Promise.all(transports.map((t) => t.close()));
	}

	createInvite(role: Role): string {
		const token = randomBytes(18).toString("base64url");
		this.invites.set(token, role);
		return token;
	}

	/** Revokes invite tokens (all, or only those for one role). Already-connected guests stay connected. */
	revokeInvites(role?: Role): number {
		let revoked = 0;
		for (const [token, inviteRole] of this.invites) {
			if (!role || inviteRole === role) {
				this.invites.delete(token);
				revoked++;
			}
		}
		return revoked;
	}

	participants(): Participant[] {
		return [
			{ id: "host", name: this.options.hostName, role: "host" },
			...[...this.guests.values()].map((guest) => ({ ...guest.participant })),
		];
	}

	setRole(who: string, role: Role): Participant {
		const guest = this.find(who);
		guest.participant.role = role;
		guest.link.send({ type: "role", role });
		this.broadcastParticipants();
		this.publish({ kind: "system", text: `${guest.participant.name} is now a ${role}`, ts: Date.now() });
		return { ...guest.participant };
	}

	kick(who: string): Participant {
		const guest = this.find(who);
		this.guests.delete(guest.participant.id);
		guest.link.end({ type: "bye", reason: "Removed by host" });
		this.broadcastParticipants();
		this.publish({ kind: "system", text: `${guest.participant.name} was removed`, ts: Date.now() });
		return { ...guest.participant };
	}

	/** Broadcasts an event to every guest. Deltas are live-only; everything else is replayed to late joiners. */
	publish(event: SessionEvent): void {
		if (event.kind === "status") this.busy = event.busy;
		if (event.kind !== "delta" && event.kind !== "status") {
			this.history.push(event);
			if (this.history.length > HISTORY_LIMIT) this.history.splice(0, this.history.length - HISTORY_LIMIT);
		}
		for (const guest of this.guests.values()) guest.link.send({ type: "event", event });
	}

	/** Registers a new, not yet authenticated peer. It must send a valid hello before anything else. */
	connect(link: PeerLink): PeerHandle {
		let guest: Guest | undefined;
		let done = false;
		const helloTimer = setTimeout(() => link.end({ type: "bye", reason: "Timed out waiting for hello" }), HELLO_TIMEOUT_MS);
		return {
			receive: (message) => {
				if (done) return;
				if (!guest) {
					clearTimeout(helloTimer);
					guest = this.handshake(link, message as ClientMessage);
					if (!guest) done = true;
				} else {
					this.handle(guest, message as ClientMessage);
				}
			},
			closed: () => {
				done = true;
				clearTimeout(helloTimer);
				if (guest && this.guests.get(guest.participant.id) === guest) {
					this.guests.delete(guest.participant.id);
					this.broadcastParticipants();
					this.publish({ kind: "system", text: `${guest.participant.name} left`, ts: Date.now() });
					this.options.onNotice?.(`${guest.participant.name} left`);
				}
			},
		};
	}

	private find(who: string): Guest {
		const needle = who.toLowerCase();
		const guest = [...this.guests.values()].find(
			(g) => g.participant.id === who || g.participant.name.toLowerCase() === needle,
		);
		if (!guest) throw new Error(`No participant named "${who}"`);
		return guest;
	}

	private handshake(link: PeerLink, message: ClientMessage): Guest | undefined {
		const reject = (reason: string) => {
			link.end({ type: "bye", reason });
			return undefined;
		};
		if (message?.type !== "hello") return reject("Expected hello");
		if (message.protocol !== PROTOCOL_VERSION) return reject(`Unsupported protocol version ${message.protocol}`);
		const role = this.lookupInvite(String(message.token ?? ""));
		if (!role) {
			this.options.onNotice?.("Rejected a connection with an invalid invite");
			return reject("Invalid or revoked invite");
		}
		const name = this.uniqueName(String(message.name ?? "").trim().slice(0, 40) || "guest");
		const guest: Guest = { participant: { id: randomUUID(), name, role }, link };
		this.guests.set(guest.participant.id, guest);
		link.send({
			type: "welcome",
			you: { ...guest.participant },
			participants: this.participants(),
			history: [...this.history],
			busy: this.busy,
		});
		this.broadcastParticipants();
		this.publish({ kind: "system", text: `${name} joined as ${role}`, ts: Date.now() });
		this.options.onNotice?.(`${name} joined as ${role}`);
		return guest;
	}

	private handle(guest: Guest, message: ClientMessage): void {
		const { participant, link } = guest;
		switch (message?.type) {
			case "prompt": {
				if (!can(participant.role, "prompt")) {
					link.send({ type: "error", message: "Permission denied: viewers cannot prompt the agent" });
					this.options.onNotice?.(`Blocked prompt from viewer ${participant.name}`);
					return;
				}
				const text = String(message.text ?? "").trim();
				if (!text) return;
				Promise.resolve()
					.then(() => this.options.onPrompt({ ...participant }, text))
					.catch((error: unknown) => {
						link.send({ type: "error", message: error instanceof Error ? error.message : String(error) });
					});
				return;
			}
			case "chat": {
				if (!can(participant.role, "chat")) {
					link.send({ type: "error", message: "Permission denied: viewers cannot chat" });
					return;
				}
				const text = String(message.text ?? "").trim();
				if (text) this.publish({ kind: "chat", author: participant.name, text, ts: Date.now() });
				return;
			}
			default:
				link.send({ type: "error", message: "Unknown message" });
		}
	}

	private lookupInvite(token: string): Role | undefined {
		const given = Buffer.from(token);
		for (const [candidate, role] of this.invites) {
			const expected = Buffer.from(candidate);
			if (expected.length === given.length && timingSafeEqual(expected, given)) return role;
		}
		return undefined;
	}

	private uniqueName(name: string): string {
		const taken = new Set(this.participants().map((p) => p.name.toLowerCase()));
		if (!taken.has(name.toLowerCase())) return name;
		for (let n = 2; ; n++) if (!taken.has(`${name}-${n}`.toLowerCase())) return `${name}-${n}`;
	}

	private broadcastParticipants(): void {
		const participants = this.participants();
		for (const guest of this.guests.values()) guest.link.send({ type: "participants", participants });
	}
}
