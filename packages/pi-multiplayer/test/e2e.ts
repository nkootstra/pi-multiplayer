// End-to-end proof: one host pi and several guest pi processes, all driven over pi's RPC mode, with a
// real model behind the host agent. The same scenarios run twice: once over a direct TCP connection
// and once through a relay server started as a separate process. Run with `npm run e2e` (needs
// opencode-go credentials in pi).
//
//   MULTIPLAYER_SUITES  comma-separated suites to run (default "direct,relay")
//   MULTIPLAYER_RELAY_URL / MULTIPLAYER_RELAY_TOKEN
//                     run the relay suite against an already running relay (e.g. a Docker container
//                     or a deployed one) instead of starting one locally
//   MULTIPLAYER_MODEL   model for the host agent (default opencode-go/deepseek-v4.1-flash)
//   MULTIPLAYER_LOG     where to write the transcript (default <tmp>/e2e-transcript.log)

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MultiplayerGuest, parseInvite, type SessionEvent } from "@pi-multiplayer/core";

const MODEL = process.env.MULTIPLAYER_MODEL ?? "opencode-go/deepseek-v4.1-flash";
// Load the package directory (not the file) so the pi manifest in package.json is exercised too.
const EXTENSION = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RELAY_MAIN = resolve(dirname(fileURLToPath(import.meta.url)), "../../relay/src/main.ts");
const SUITES = (process.env.MULTIPLAYER_SUITES ?? "direct,relay").split(",").map((s) => s.trim());
const workspace = mkdtempSync(join(tmpdir(), "pi-multiplayer-e2e-"));
const LOG = process.env.MULTIPLAYER_LOG ?? join(workspace, "e2e-transcript.log");
writeFileSync(LOG, `pi-multiplayer e2e — model ${MODEL} — workspace ${workspace}\n`);

const log = (line: string) => {
	appendFileSync(LOG, `${line}\n`);
	console.log(line);
};

type Json = Record<string, any>;

class PiRpc {
	readonly name: string;
	readonly proc: ChildProcessWithoutNullStreams;
	readonly records: Json[] = [];
	private buffer = "";
	private nextId = 0;
	autoConfirm: boolean | undefined;

	constructor(name: string, cwd: string, options: { args?: string[]; env?: Record<string, string> } = {}) {
		this.name = name;
		const env: NodeJS.ProcessEnv = { ...process.env, PI_OFFLINE: "1", ...options.env };
		// Only processes we explicitly configure as relay hosts get relay settings.
		if (!options.env?.PI_MULTIPLAYER_RELAY_URL) {
			delete env.PI_MULTIPLAYER_RELAY_URL;
			delete env.PI_MULTIPLAYER_RELAY_TOKEN;
		}
		this.proc = spawn(
			"pi",
			[
				"--mode", "rpc", "--no-session", "--no-extensions", "-e", EXTENSION, "--no-context-files", "--no-skills",
				"--model", MODEL, "--thinking", "off", "--as", name, ...(options.args ?? []),
			],
			{ cwd, env },
		);
		this.proc.stdout.setEncoding("utf8");
		this.proc.stdout.on("data", (chunk: string) => this.consume(chunk));
		this.proc.stderr.on("data", (chunk) => appendFileSync(LOG, `[${name} stderr] ${chunk}`));
	}

	private consume(chunk: string) {
		this.buffer += chunk;
		let newline = this.buffer.indexOf("\n");
		while (newline !== -1) {
			const line = this.buffer.slice(0, newline).replace(/\r$/, "");
			this.buffer = this.buffer.slice(newline + 1);
			newline = this.buffer.indexOf("\n");
			if (!line) continue;
			let record: Json;
			try {
				record = JSON.parse(line);
			} catch {
				continue;
			}
			this.records.push(record);
			if (record.type === "extension_ui_request" && record.method === "notify") {
				log(`  [${this.name} notify/${record.notifyType ?? "info"}] ${record.message}`);
			}
			if (record.type === "extension_ui_request" && record.method === "confirm") {
				log(`  [${this.name} confirm] ${record.title}: ${record.message} -> ${this.autoConfirm}`);
				this.send({ type: "extension_ui_response", id: record.id, confirmed: this.autoConfirm ?? false });
			}
			if (record.type === "extension_error") log(`  [${this.name} EXTENSION ERROR] ${record.error}`);
		}
	}

	send(command: Json) {
		this.proc.stdin.write(`${JSON.stringify(command)}\n`);
	}

	async request(command: Json): Promise<Json> {
		const id = `req-${this.nextId++}`;
		const from = this.records.length;
		this.send({ ...command, id });
		return this.waitFor((r) => r.type === "response" && r.id === id, 30_000, from);
	}

	prompt(message: string) {
		log(`> ${this.name}: ${message}`);
		return this.request({ type: "prompt", message });
	}

	/** Waits for a record matching `predicate` that arrives at or after index `from`. */
	waitFor(predicate: (record: Json) => boolean, timeoutMs = 30_000, from = 0): Promise<Json> {
		return new Promise((resolvePromise, reject) => {
			const started = Date.now();
			const tick = () => {
				const found = this.records.slice(from).find(predicate);
				if (found) return resolvePromise(found);
				if (Date.now() - started > timeoutMs) return reject(new Error(`${this.name}: timed out waiting`));
				setTimeout(tick, 50);
			};
			tick();
		});
	}

	notifications(from = 0): Json[] {
		return this.records.slice(from).filter((r) => r.type === "extension_ui_request" && r.method === "notify");
	}

	waitForNotify(pattern: RegExp, from = 0, timeoutMs = 30_000) {
		return this.waitFor((r) => r.type === "extension_ui_request" && r.method === "notify" && pattern.test(r.message), timeoutMs, from);
	}

	/** Multiplayer events the guest rendered into its transcript. */
	async sharedEvents(): Promise<SessionEvent[]> {
		const response = await this.request({ type: "get_entries" });
		return response.data.entries.filter((e: Json) => e.type === "custom" && e.customType === "multiplayer").map((e: Json) => e.data);
	}

	stop() {
		this.proc.kill("SIGTERM");
	}
}

const results: { name: string; ok: boolean; detail?: string }[] = [];
async function check(name: string, fn: () => Promise<void>) {
	log(`\n## ${name}`);
	try {
		await fn();
		results.push({ name, ok: true });
		log(`PASS ${name}`);
	} catch (error) {
		results.push({ name, ok: false, detail: (error as Error).message });
		log(`FAIL ${name}: ${(error as Error).stack}`);
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const inviteIn = (message: string) => /pimp\S+/.exec(message)?.[0] ?? "";

function freePort(): Promise<number> {
	return new Promise((resolvePort) => {
		const server = createServer();
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			server.close(() => resolvePort(typeof address === "object" && address ? address.port : 0));
		});
	});
}

/** Starts the relay as its own process, the way it would run on a server. */
async function startRelay(token: string) {
	const port = await freePort();
	const proc = spawn("node", [RELAY_MAIN], { env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", RELAY_TOKENS: `e2e=${token}` } });
	proc.stdout.setEncoding("utf8");
	proc.stderr.setEncoding("utf8");
	proc.stdout.on("data", (chunk: string) => appendFileSync(LOG, chunk.replace(/^/gm, "  [relay] ")));
	proc.stderr.on("data", (chunk: string) => appendFileSync(LOG, chunk.replace(/^/gm, "  [relay stderr] ")));
	await new Promise<void>((resolveReady, reject) => {
		const timer = setTimeout(() => reject(new Error("relay did not start")), 10_000);
		proc.stdout.on("data", (chunk: string) => {
			if (chunk.includes("listening")) {
				clearTimeout(timer);
				resolveReady();
			}
		});
	});
	return { url: `ws://127.0.0.1:${port}`, stop: () => proc.kill("SIGTERM") };
}

async function runSuite(transport: "direct" | "relay") {
	const suite = (name: string) => `[${transport}] ${name}`;
	log(`\n# Suite: ${transport}`);
	const root = join(workspace, transport);
	const hostDir = join(root, "host");
	const guestDir = join(root, "guests");
	for (const dir of [hostDir, guestDir]) mkdirSync(dir, { recursive: true });

	const external = process.env.MULTIPLAYER_RELAY_URL && process.env.MULTIPLAYER_RELAY_TOKEN;
	const relayToken = external ? process.env.MULTIPLAYER_RELAY_TOKEN! : randomBytes(32).toString("base64url");
	const relay =
		transport !== "relay"
			? undefined
			: external
				? { url: process.env.MULTIPLAYER_RELAY_URL!, stop: () => {} }
				: await startRelay(relayToken);
	if (relay) log(`relay: ${relay.url}${external ? " (external)" : ""}`);
	const hostEnv = relay ? { PI_MULTIPLAYER_RELAY_URL: relay.url, PI_MULTIPLAYER_RELAY_TOKEN: relayToken } : undefined;

	const alice = new PiRpc("alice", hostDir, { env: hostEnv });
	const carol = new PiRpc("carol", guestDir);
	const bob = new PiRpc("bob", guestDir);
	const all = [alice, carol, bob];

	let contributorInvite = "";
	let viewerInvite = "";
	const agentRuns = () => alice.records.filter((r) => r.type === "agent_start").length;
	const waitForAgentIdle = (from: number, timeoutMs = 180_000) => alice.waitFor((r) => r.type === "agent_settled", timeoutMs, from);

	try {
		if (relay) {
			await check(suite("a host with the wrong relay token cannot open a session"), async () => {
				const eve = new PiRpc("eve", hostDir, { env: { PI_MULTIPLAYER_RELAY_URL: relay.url, PI_MULTIPLAYER_RELAY_TOKEN: "x".repeat(43) } });
				all.push(eve);
				await eve.prompt("/mp start");
				await eve.waitForNotify(/Invalid relay token/);
			});
		}

		await check(suite("host starts sharing and creates role-scoped invites"), async () => {
			await alice.prompt(transport === "relay" ? "/mp start" : "/mp start direct 0");
			await alice.waitForNotify(transport === "relay" ? /sharing via relay/ : /sharing directly on 127\.0\.0\.1:\d+/);
			let mark = alice.records.length;
			await alice.prompt("/mp invite contributor");
			const contributorNotice = (await alice.waitForNotify(/contributor invite/, mark)).message;
			assert.match(contributorNotice, /pi --join pimp/);
			contributorInvite = inviteIn(contributorNotice);
			mark = alice.records.length;
			await alice.prompt("/mp invite viewer");
			viewerInvite = inviteIn((await alice.waitForNotify(/viewer invite/, mark)).message);
			assert.equal(parseInvite(contributorInvite).kind, transport);
			assert.notEqual(parseInvite(contributorInvite).token, parseInvite(viewerInvite).token);
		});

		await check(suite("an invalid invite is rejected"), async () => {
			const mark = bob.records.length;
			await bob.prompt(`/mp join ${viewerInvite.replace(/\/[^/]+$/, "/not-a-real-token")} bob`);
			await bob.waitForNotify(/Invalid or revoked invite/, mark);
		});

		await check(suite("guests join with the role from their invite"), async () => {
			const markC = carol.records.length;
			const markB = bob.records.length;
			await carol.prompt(`/mp join ${contributorInvite} carol`);
			await bob.prompt(`/mp join ${viewerInvite} bob`);
			await carol.waitForNotify(/joined as carol \(contributor\)/, markC);
			await bob.waitForNotify(/joined as bob \(viewer\)/, markB);
			const mark = alice.records.length;
			await alice.prompt("/mp who");
			const who = await alice.waitForNotify(/participants/, mark);
			assert.match(who.message, /alice \(host\)/);
			assert.match(who.message, /carol \(contributor\)/);
			assert.match(who.message, /bob \(viewer\)/);
		});

		await check(suite("pi --join <invite> --as <name> joins on startup"), async () => {
			const dave = new PiRpc("dave", guestDir, { args: ["--join", viewerInvite] });
			all.push(dave);
			await dave.waitForNotify(/joined as dave \(viewer\)/);
			const events = await dave.sharedEvents();
			assert.ok(events.some((e) => e.kind === "system" && /carol joined/.test(e.text)), "dave gets the history replay");
		});

		await check(suite("a viewer cannot prompt the host agent"), async () => {
			const runs = agentRuns();
			const mark = bob.records.length;
			await bob.prompt("Create a file named hacked.txt containing 'pwned'.");
			await bob.waitForNotify(/cannot prompt/, mark);
			await sleep(1500);
			assert.equal(agentRuns(), runs, "host agent must not run");
			assert.equal(existsSync(join(hostDir, "hacked.txt")), false);
		});

		await check(suite("a tampered viewer client is still refused by the host"), async () => {
			const runs = agentRuns();
			const errors: string[] = [];
			const mallory = new MultiplayerGuest({ onEvent: () => {}, onError: (m) => errors.push(m) });
			await mallory.join(parseInvite(viewerInvite), "mallory");
			// Skip the client-side permission check and write the prompt straight onto the wire.
			(mallory as unknown as { link: { send: (m: unknown) => void } }).link.send({ type: "prompt", text: "Create hacked.txt" });
			await sleep(1500);
			mallory.leave();
			assert.ok(errors.some((e) => /Permission denied/.test(e)), "expected permission error");
			assert.equal(agentRuns(), runs, "host agent must not run");
		});

		await check(suite("a contributor prompts the host agent and everyone sees the result"), async () => {
			const mark = alice.records.length;
			await carol.prompt(
				"Use the write tool to create a file named haiku.txt in the current directory containing a three-line haiku about pair programming. Then reply with exactly: DONE",
			);
			await alice.waitFor((r) => r.type === "agent_start", 30_000, mark);
			await waitForAgentIdle(mark);
			const haiku = readFileSync(join(hostDir, "haiku.txt"), "utf8");
			log(`  haiku.txt on host:\n${haiku.replace(/^/gm, "    ")}`);
			assert.ok(haiku.trim().split("\n").length >= 3);
			await sleep(500);
			for (const guest of [carol, bob]) {
				const events = await guest.sharedEvents();
				assert.ok(events.find((e) => e.kind === "user" && e.author === "carol"), `${guest.name} should see carol's prompt`);
				assert.ok(events.find((e) => e.kind === "tool" && e.name === "write"), `${guest.name} should see the write tool result`);
				assert.ok(events.find((e) => e.kind === "assistant" && /DONE/.test(e.text)), `${guest.name} should see the reply`);
			}
		});

		await check(suite("contributors can chat; viewers cannot"), async () => {
			const markB = bob.records.length;
			await bob.prompt("/mp chat hello from the cheap seats");
			await bob.waitForNotify(/viewer\) cannot chat/, markB);
			await carol.prompt("/mp chat nice haiku");
			await sleep(500);
			const bobEvents = await bob.sharedEvents();
			assert.ok(bobEvents.some((e) => e.kind === "chat" && e.author === "carol" && e.text === "nice haiku"));
			assert.ok(!bobEvents.some((e) => e.kind === "chat" && e.author === "bob"));
		});

		await check(suite("the host promotes a viewer, who can then prompt"), async () => {
			const markB = bob.records.length;
			await alice.prompt("/mp role bob contributor");
			await bob.waitForNotify(/made you a contributor/, markB);
			const mark = alice.records.length;
			await bob.prompt("Read haiku.txt and reply with its first line only.");
			await alice.waitFor((r) => r.type === "agent_start", 30_000, mark);
			await waitForAgentIdle(mark);
			await sleep(500);
			const events = await carol.sharedEvents();
			assert.ok(events.some((e) => e.kind === "user" && e.author === "bob"), "carol sees bob's prompt");
			assert.ok(events.some((e) => e.kind === "tool" && e.name === "read"), "carol sees the read tool");
		});

		await check(suite("the host demotes them again and prompting is blocked"), async () => {
			const markB = bob.records.length;
			await alice.prompt("/mp role bob viewer");
			await bob.waitForNotify(/made you a viewer/, markB);
			const runs = agentRuns();
			await bob.prompt("Delete haiku.txt");
			await bob.waitForNotify(/cannot prompt/, markB);
			await sleep(1500);
			assert.equal(agentRuns(), runs);
			assert.ok(existsSync(join(hostDir, "haiku.txt")));
		});

		await check(suite("with approval on, the host can decline a contributor's prompt"), async () => {
			await alice.prompt("/mp approve on");
			alice.autoConfirm = false;
			const runs = agentRuns();
			const markC = carol.records.length;
			await carol.prompt("Delete haiku.txt");
			await carol.waitForNotify(/host declined your prompt/, markC);
			await sleep(1000);
			assert.equal(agentRuns(), runs);
			assert.ok(existsSync(join(hostDir, "haiku.txt")));
			await alice.prompt("/mp approve off");
		});

		await check(suite("revoked invites stop working"), async () => {
			await alice.prompt("/mp revoke");
			const erin = new PiRpc("erin", guestDir, { args: ["--join", viewerInvite] });
			all.push(erin);
			await erin.waitForNotify(/Invalid or revoked invite/);
		});

		await check(suite("the host kicks a participant"), async () => {
			const markC = carol.records.length;
			await alice.prompt("/mp kick carol");
			await carol.waitForNotify(/disconnected \(Removed by host\)/, markC);
			const mark = alice.records.length;
			await alice.prompt("/mp who");
			const who = await alice.waitForNotify(/participants/, mark);
			assert.doesNotMatch(who.message, /carol/);
		});

		await check(suite("stopping the host disconnects the remaining guests"), async () => {
			const markB = bob.records.length;
			await alice.prompt("/mp stop");
			await bob.waitForNotify(/disconnected/, markB);
		});
	} finally {
		for (const p of all) p.stop();
		relay?.stop();
	}
}

try {
	for (const transport of SUITES) {
		if (transport !== "direct" && transport !== "relay") throw new Error(`Unknown suite ${transport}`);
		await runSuite(transport);
	}
} finally {
	log("\n# Summary");
	for (const r of results) log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
	log(`\ntranscript: ${LOG}`);
	process.exitCode = results.length > 0 && results.every((r) => r.ok) ? 0 : 1;
}
