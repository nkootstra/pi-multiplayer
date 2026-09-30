import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	formatInvite,
	hostViaRelay,
	type Invite,
	MultiplayerGuest,
	MultiplayerHost,
	type Participant,
	parseInvite,
	type SessionEvent,
} from "@pi-multiplayer/core";
import { generateToken, parseTokens, Relay } from "../src/relay.ts";

const TOKEN = generateToken();
const OTHER_TOKEN = generateToken();

function until<T>(check: () => T | undefined | false, timeoutMs = 3000): Promise<T> {
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

describe("token config", () => {
	it("parses labelled and bare tokens", () => {
		assert.deepEqual(parseTokens("niels=aaa, bbb\nsam=ccc"), [
			{ label: "niels", token: "aaa" },
			{ label: "token-2", token: "bbb" },
			{ label: "sam", token: "ccc" },
		]);
	});

	it("refuses to start without strong tokens", () => {
		assert.throws(() => new Relay({ tokens: [] }), /required/);
		assert.throws(() => new Relay({ tokens: [{ label: "weak", token: "short" }] }), /shorter/);
	});
});

describe("relay", () => {
	let relay: Relay;
	let url: string;
	const hosts: MultiplayerHost[] = [];
	const guests: MultiplayerGuest[] = [];
	const prompts: { from: Participant; text: string }[] = [];

	beforeEach(async () => {
		prompts.length = 0;
		relay = new Relay({
			tokens: [
				{ label: "niels", token: TOKEN },
				{ label: "sam", token: OTHER_TOKEN },
			],
			maxSessionsPerToken: 2,
			maxGuestsPerSession: 2,
			log: () => {},
		});
		url = `ws://127.0.0.1:${await relay.listen(0, "127.0.0.1")}`;
	});

	afterEach(async () => {
		for (const guest of guests.splice(0)) guest.leave();
		for (const host of hosts.splice(0)) await host.stop();
		await relay.close();
	});

	async function startHost(token = TOKEN, lost: string[] = []) {
		const host = new MultiplayerHost({ hostName: "alice", onPrompt: (from, text) => void prompts.push({ from, text }) });
		hosts.push(host);
		const { sessionId } = await hostViaRelay(host, url, token, (reason) => lost.push(reason));
		return { host, sessionId };
	}

	async function join(invite: Invite, name: string) {
		const events: SessionEvent[] = [];
		const errors: string[] = [];
		const closes: string[] = [];
		const guest = new MultiplayerGuest({
			onEvent: (e) => events.push(e),
			onError: (m) => errors.push(m),
			onClose: (r) => closes.push(r),
		});
		guests.push(guest);
		const welcome = await guest.join(invite, name);
		return { guest, events, errors, closes, welcome };
	}

	it("reports session counts on /stats", async () => {
		const stats = async () => (await fetch(`${url.replace("ws:", "http:")}/stats`)).json();
		assert.deepEqual(await stats(), { sessions: 0, guests: 0 });
		const { host, sessionId } = await startHost();
		await join({ kind: "relay", url, sessionId, token: host.createInvite("viewer") }, "bob");
		assert.deepEqual(await stats(), { sessions: 1, guests: 1 });
	});

	it("rejects hosts without a valid relay token", async () => {
		await assert.rejects(startHost("x".repeat(43)), /Invalid relay token/);
		assert.equal(relay.stats().sessions, 0);
	});

	it("locks out an address after repeated bad tokens", async () => {
		for (let i = 0; i < 10; i++) await assert.rejects(startHost("bad"), /Invalid relay token/);
		await assert.rejects(startHost(TOKEN), /Too many failed attempts/);
	});

	it("limits concurrent sessions per token", async () => {
		await startHost();
		await startHost();
		await assert.rejects(startHost(), /already has 2 active sessions/);
		await startHost(OTHER_TOKEN); // other tokens are unaffected
	});

	it("carries a full session: invites, events, contributor prompts and viewer blocks", async () => {
		const { host, sessionId } = await startHost();
		const code = (role: "viewer" | "contributor") =>
			parseInvite(formatInvite({ kind: "relay", url, sessionId, token: host.createInvite(role) }));

		const bob = await join(code("viewer"), "bob");
		const carol = await join(code("contributor"), "carol");
		assert.equal(bob.welcome.me.role, "viewer");
		assert.equal(carol.welcome.me.role, "contributor");

		host.publish({ kind: "assistant", text: "hello via relay", toolCalls: [], ts: 1 });
		await until(() => bob.events.find((e) => e.kind === "assistant" && e.text === "hello via relay"));

		carol.guest.prompt("do the thing");
		const prompt = await until(() => prompts[0]);
		assert.equal(prompt.from.name, "carol");

		// A viewer that bypasses its local check is still refused by the host.
		(bob.guest as unknown as { link: { send: (m: unknown) => void } }).link.send({ type: "prompt", text: "sneaky" });
		await until(() => bob.errors[0]);
		assert.match(bob.errors[0]!, /Permission denied/);
		assert.equal(prompts.length, 1);
	});

	it("does not let a relay invite without the host's token in", async () => {
		const { sessionId } = await startHost();
		const guest = new MultiplayerGuest({ onEvent: () => {} });
		await assert.rejects(guest.join({ kind: "relay", url, sessionId, token: "guessed" }, "mallory"), /Invalid or revoked invite/);
	});

	it("rejects unknown sessions", async () => {
		const guest = new MultiplayerGuest({ onEvent: () => {} });
		await assert.rejects(guest.join({ kind: "relay", url, sessionId: "nope", token: "t" }, "mallory"));
	});

	it("caps guests per session", async () => {
		const { host, sessionId } = await startHost();
		const invite = () => ({ kind: "relay" as const, url, sessionId, token: host.createInvite("viewer") });
		await join(invite(), "a");
		await join(invite(), "b");
		const third = new MultiplayerGuest({ onEvent: () => {} });
		await assert.rejects(third.join(invite(), "c"));
	});

	it("kicks through the relay", async () => {
		const { host, sessionId } = await startHost();
		const bob = await join({ kind: "relay", url, sessionId, token: host.createInvite("contributor") }, "bob");
		host.kick("bob");
		await until(() => bob.closes[0]);
		assert.equal(bob.closes[0], "Removed by host");
		await until(() => relay.stats().guests === 0 || undefined);
	});

	it("disconnects guests when the host leaves and frees the session", async () => {
		const { host, sessionId } = await startHost();
		const bob = await join({ kind: "relay", url, sessionId, token: host.createInvite("viewer") }, "bob");
		await host.stop();
		await until(() => bob.closes[0]);
		assert.equal(relay.stats().sessions, 0);
	});

	it("tells the host when the relay goes away", async () => {
		const lost: string[] = [];
		const { host } = await startHost(TOKEN, lost);
		await relay.close();
		await until(() => lost[0]);
		assert.equal(host.running, false);
		relay = new Relay({ tokens: [{ label: "x", token: TOKEN }], log: () => {} });
		await relay.listen(0, "127.0.0.1");
	});
});
