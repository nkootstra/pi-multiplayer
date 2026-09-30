import { can } from "./permissions.ts";
import {
	type ClientMessage,
	type Invite,
	type Participant,
	PROTOCOL_VERSION,
	type Role,
	type ServerMessage,
	type SessionEvent,
} from "./protocol.ts";
import { openRelayLink } from "./relay-client.ts";
import { openTcpLink } from "./tcp.ts";

/** A guest's connection to a host, independent of transport. */
export interface GuestLink {
	send(message: ClientMessage): void;
	close(): void;
}

export interface LinkHandlers {
	onOpen: () => void;
	onMessage: (message: ServerMessage) => void;
	/** A transport-level problem; the reason is reported if the link then closes. */
	onError: (reason: string) => void;
	onClose: () => void;
}

export interface GuestHandlers {
	onEvent: (event: SessionEvent) => void;
	onParticipants?: (participants: Participant[]) => void;
	onRoleChange?: (role: Role) => void;
	onError?: (message: string) => void;
	onClose?: (reason: string) => void;
}

function openLink(invite: Invite, handlers: LinkHandlers): GuestLink {
	return invite.kind === "relay"
		? openRelayLink(invite.url, invite.sessionId, handlers)
		: openTcpLink(invite.host, invite.port, handlers);
}

export class MultiplayerGuest {
	private link: GuestLink | undefined;
	private closeReason = "Connection closed";
	private readonly handlers: GuestHandlers;
	me: Participant | undefined;
	participants: Participant[] = [];

	constructor(handlers: GuestHandlers) {
		this.handlers = handlers;
	}

	get role(): Role | undefined {
		return this.me?.role === "host" ? undefined : this.me?.role;
	}

	get connected(): boolean {
		return !!this.link && !!this.me;
	}

	/** Connects and resolves once the host has accepted us, with the history it replays. */
	join(invite: Invite, name: string): Promise<{ me: Participant; history: SessionEvent[]; busy: boolean }> {
		if (this.link) return Promise.reject(new Error("Already connected"));
		return new Promise((resolve, reject) => {
			let welcomed = false;
			let closed = false;
			const link = openLink(invite, {
				onOpen: () => link.send({ type: "hello", protocol: PROTOCOL_VERSION, token: invite.token, name }),
				onMessage: (message) => {
					if (message.type === "welcome") {
						welcomed = true;
						this.me = message.you;
						this.participants = message.participants;
						resolve({ me: message.you, history: message.history, busy: message.busy });
					} else if (message.type === "bye") {
						this.closeReason = message.reason;
					} else {
						this.dispatch(message);
					}
				},
				onError: (reason) => {
					if (this.closeReason === "Connection closed") this.closeReason = reason;
				},
				onClose: () => {
					if (closed) return;
					closed = true;
					this.link = undefined;
					this.me = undefined;
					if (!welcomed) reject(new Error(this.closeReason));
					else this.handlers.onClose?.(this.closeReason);
				},
			});
			this.link = link;
		});
	}

	prompt(text: string): void {
		this.requireCapability("prompt");
		this.link?.send({ type: "prompt", text });
	}

	chat(text: string): void {
		this.requireCapability("chat");
		this.link?.send({ type: "chat", text });
	}

	leave(): void {
		this.closeReason = "You left the session";
		this.link?.close();
	}

	/** Local pre-check for fast feedback; the host enforces the same rule authoritatively. */
	private requireCapability(capability: "prompt" | "chat"): void {
		const role = this.role;
		if (!this.connected || !role) throw new Error("Not connected to a session");
		if (!can(role, capability)) throw new Error(`Your role (${role}) cannot ${capability}`);
	}

	private dispatch(message: ServerMessage): void {
		switch (message.type) {
			case "event":
				this.handlers.onEvent(message.event);
				break;
			case "participants":
				this.participants = message.participants;
				this.handlers.onParticipants?.(message.participants);
				break;
			case "role":
				if (this.me) this.me = { ...this.me, role: message.role };
				this.handlers.onRoleChange?.(message.role);
				break;
			case "error":
				this.handlers.onError?.(message.message);
				break;
		}
	}
}
