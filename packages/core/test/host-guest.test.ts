import assert from "node:assert/strict";
import { connect } from "node:net";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MultiplayerGuest } from "../src/guest.ts";
import { MultiplayerHost } from "../src/host.ts";
import { listenTcp } from "../src/tcp.ts";
import { can } from "../src/permissions.ts";
import {
	encodeFrame,
	FrameDecoder,
	formatInvite,
	type Participant,
	parseInvite,
	type Role,
	type ServerMessage,
	type SessionEvent,
} from "../src/protocol.ts";

function until<T>(check: () => T | undefined, timeoutMs = 2000): Promise<T> {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const tick = () => {
			const value = check();
			if (value !== undefined && value !== false) return resolve(value);
			if (Date.now() - started > timeoutMs) return reject(new Error("Timed out waiting for condition"));
			setTimeout(tick, 5);
		};
		tick();
	});
}

describe("permissions", () => {
	it("viewers can only view; contributors can view, chat and prompt", () => {
		assert.equal(can("viewer", "view"), true);
		assert.equal(can("viewer", "chat"), false);
		assert.equal(can("viewer", "prompt"), false);
		assert.equal(can("contributor", "view"), true);
		assert.equal(can("contributor", "chat"), true);
		assert.equal(can("contributor", "prompt"), true);
	});
});

describe("invite codes", () => {
	it("round-trip ipv4, hostnames and ipv6", () => {
		for (const host of ["127.0.0.1", "my-laptop.tailnet.ts.net", "::1"]) {
			const invite = { kind: "direct" as const, host, port: 4817, token: "abc_DEF-123" };
			assert.deepEqual(parseInvite(formatInvite(invite)), invite);
		}
	});

	it("round-trips relay invites, including a path prefix", () => {
		for (const url of ["wss://relay.example.com", "ws://127.0.0.1:8787", "wss://example.com/pi-relay"]) {
			const invite = { kind: "relay" as const, url, sessionId: "Sess_1-a", token: "tok_2-b" };
			assert.deepEqual(parseInvite(formatInvite(invite)), invite);
		}
		assert.equal(
			formatInvite({ kind: "relay", url: "wss://relay.example.com", sessionId: "s1", token: "t1" }),
			"pimp+wss://relay.example.com/s/s1/t1",
		);
	});

	it("rejects malformed codes", () => {
		assert.throws(() => parseInvite("pimp+wss://relay.example.com/s1/t1"));
		assert.throws(() => parseInvite("http://x:1/abc"));
		assert.throws(() => parseInvite("pimp://x/abc"));
		assert.throws(() => parseInvite("pimp://x:1/"));
	});
});

describe("host and guests", () => {
	let host: MultiplayerHost;
	let port: number;
	const prompts: { from: Participant; text: string }[] = [];
	const guests: MultiplayerGuest[] = [];

	beforeEach(async () => {
		prompts.length = 0;
		host = new MultiplayerHost({ hostName: "alice", onPrompt: (from, text) => void prompts.push({ from, text }) });
		port = await listenTcp(host, 0, "127.0.0.1");
	});

	afterEach(async () => {
		for (const guest of guests.splice(0)) guest.leave();
		await host.stop();
	});

	async function join(role: Role, name: string) {
		const events: SessionEvent[] = [];
		const errors: string[] = [];
		const closes: string[] = [];
		const guest = new MultiplayerGuest({
			onEvent: (event) => events.push(event),
			onError: (message) => errors.push(message),
			onClose: (reason) => closes.push(reason),
		});
		guests.push(guest);
		const welcome = await guest.join({ kind: "direct", host: "127.0.0.1", port, token: host.createInvite(role) }, name);
		return { guest, events, errors, closes, welcome };
	}

	it("rejects invalid invites", async () => {
		const guest = new MultiplayerGuest({ onEvent: () => {} });
		await assert.rejects(guest.join({ kind: "direct", host: "127.0.0.1", port, token: "nope" }, "mallory"), /Invalid or revoked invite/);
	});

	it("rejects revoked invites but keeps existing guests connected", async () => {
		const bob = await join("contributor", "bob");
		const token = host.createInvite("viewer");
		assert.equal(host.revokeInvites(), 2);
		const guest = new MultiplayerGuest({ onEvent: () => {} });
		await assert.rejects(guest.join({ kind: "direct", host: "127.0.0.1", port, token }, "carol"), /Invalid or revoked/);
		assert.equal(bob.guest.connected, true);
	});

	it("assigns the invite's role and replays history to late joiners", async () => {
		host.publish({ kind: "user", author: "alice", text: "hello", ts: 1 });
		host.publish({ kind: "delta", text: "live-only", ts: 2 });
		const { welcome } = await join("viewer", "bob");
		assert.equal(welcome.me.role, "viewer");
		assert.deepEqual(
			welcome.history.map((e) => e.kind),
			["user"],
		);
	});

	it("broadcasts session events to every guest", async () => {
		const bob = await join("viewer", "bob");
		const carol = await join("contributor", "carol");
		host.publish({ kind: "assistant", text: "hi all", toolCalls: [], ts: 3 });
		for (const g of [bob, carol]) {
			await until(() => g.events.find((e) => e.kind === "assistant" && e.text === "hi all"));
		}
	});

	it("forwards contributor prompts to the host agent", async () => {
		const carol = await join("contributor", "carol");
		carol.guest.prompt("write a haiku");
		const prompt = await until(() => prompts[0]);
		assert.equal(prompt.text, "write a haiku");
		assert.equal(prompt.from.name, "carol");
		assert.equal(prompt.from.role, "contributor");
	});

	it("blocks viewers from prompting, client-side and server-side", async () => {
		const bob = await join("viewer", "bob");
		assert.throws(() => bob.guest.prompt("rm -rf /"), /viewer/);
		assert.throws(() => bob.guest.chat("hi"), /viewer/);

		// A tampered client that skips the local check must still be refused by the host.
		const raw = connect({ host: "127.0.0.1", port });
		const decoder = new FrameDecoder();
		const received: ServerMessage[] = [];
		raw.setEncoding("utf8");
		raw.on("data", (chunk: string) => received.push(...(decoder.push(chunk) as ServerMessage[])));
		raw.write(encodeFrame({ type: "hello", protocol: 1, token: host.createInvite("viewer"), name: "mallory" }));
		await until(() => received.find((m) => m.type === "welcome"));
		raw.write(encodeFrame({ type: "prompt", text: "rm -rf /" }));
		raw.write(encodeFrame({ type: "chat", text: "sneaky" }));
		await until(() => received.filter((m) => m.type === "error").length === 2 || undefined);
		raw.destroy();

		assert.equal(prompts.length, 0);
		assert.ok(!bob.events.some((e) => e.kind === "chat"));
	});

	it("lets contributors chat without prompting the agent", async () => {
		const bob = await join("viewer", "bob");
		const carol = await join("contributor", "carol");
		carol.guest.chat("looks good");
		await until(() => bob.events.find((e) => e.kind === "chat" && e.author === "carol"));
		assert.equal(prompts.length, 0);
	});

	it("promotes and demotes participants live", async () => {
		const bob = await join("viewer", "bob");
		host.setRole("bob", "contributor");
		await until(() => bob.guest.role === "contributor" || undefined);
		bob.guest.prompt("now I can");
		await until(() => prompts[0]);

		host.setRole("bob", "viewer");
		await until(() => bob.guest.role === "viewer" || undefined);
		assert.throws(() => bob.guest.prompt("not anymore"));
	});

	it("enforces demotion on the host even if the client ignores it", async () => {
		const bob = await join("contributor", "bob");
		host.setRole("bob", "viewer");
		await until(() => bob.guest.role === "viewer" || undefined);
		// Bypass the client-side check by writing the frame directly.
		(bob.guest as unknown as { link: { send: (m: unknown) => void } }).link.send({ type: "prompt", text: "sneaky" });
		await until(() => bob.errors[0]);
		assert.match(bob.errors[0]!, /Permission denied/);
		assert.equal(prompts.length, 0);
	});

	it("kicks participants", async () => {
		const bob = await join("contributor", "bob");
		host.kick("bob");
		await until(() => bob.closes[0]);
		assert.equal(bob.closes[0], "Removed by host");
		assert.deepEqual(
			host.participants().map((p) => p.name),
			["alice"],
		);
	});

	it("de-duplicates names", async () => {
		await join("viewer", "bob");
		const second = await join("viewer", "bob");
		assert.equal(second.welcome.me.name, "bob-2");
	});

	it("returns prompt handler errors to the guest", async () => {
		await host.stop();
		host = new MultiplayerHost({
			hostName: "alice",
			onPrompt: () => {
				throw new Error("Host declined your prompt");
			},
		});
		port = await listenTcp(host, 0, "127.0.0.1");
		const carol = await join("contributor", "carol");
		carol.guest.prompt("please");
		await until(() => carol.errors[0]);
		assert.equal(carol.errors[0], "Host declined your prompt");
	});
});
