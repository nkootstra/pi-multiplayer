#!/usr/bin/env node
// pi-multiplayer relay server.
//
//   node src/main.ts            start the relay (configured through environment variables)
//   node src/main.ts token      print a fresh host token
//
// Environment:
//   PORT                          listen port (default 8787)
//   HOST                          bind address (default 0.0.0.0)
//   RELAY_TOKENS                  comma-separated host tokens, optionally labelled: "niels=abc…,sam=def…"
//   RELAY_TOKENS_FILE             file with one token (or label=token) per line, instead of RELAY_TOKENS
//   RELAY_MAX_SESSIONS_PER_TOKEN  concurrent sessions per token (default 3)
//   RELAY_MAX_GUESTS              guests per session (default 25)
//   RELAY_TRUST_PROXY             "1" to read client IPs from X-Forwarded-For (behind a trusted proxy only)
import { readFileSync } from "node:fs";
import { generateToken, parseTokens, Relay } from "./relay.ts";

if (process.argv[2] === "token") {
	console.log(generateToken());
	process.exit(0);
}

const env = process.env;
const tokenSource = env.RELAY_TOKENS_FILE ? readFileSync(env.RELAY_TOKENS_FILE, "utf8") : (env.RELAY_TOKENS ?? "");
const tokens = parseTokens(tokenSource);
if (tokens.length === 0) {
	console.error("No host tokens configured. Set RELAY_TOKENS (generate one with `node src/main.ts token`).");
	process.exit(1);
}

const relay = new Relay({
	tokens,
	maxSessionsPerToken: Number(env.RELAY_MAX_SESSIONS_PER_TOKEN) || undefined,
	maxGuestsPerSession: Number(env.RELAY_MAX_GUESTS) || undefined,
	trustProxy: env.RELAY_TRUST_PROXY === "1",
});
const port = await relay.listen(Number(env.PORT) || 8787, env.HOST || "0.0.0.0");
console.log(`pi-multiplayer relay listening on :${port} with ${tokens.length} host token(s): ${tokens.map((t) => t.label).join(", ")}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, async () => {
		await relay.close();
		process.exit(0);
	});
}
