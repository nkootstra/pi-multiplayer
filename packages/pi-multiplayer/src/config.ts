import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface RelayConfig {
	url: string;
	token: string;
}

interface StoredConfig {
	relay?: RelayConfig;
	/** Default display name when sharing or joining. */
	name?: string;
}

export const CONFIG_FILE = "multiplayer.json";

function read(dir: string): StoredConfig {
	const path = join(dir, CONFIG_FILE);
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf8")) as StoredConfig;
	} catch {
		return {};
	}
}

function write(dir: string, config: StoredConfig): void {
	const path = join(dir, CONFIG_FILE);
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	chmodSync(path, 0o600); // the file holds a relay token
}

/** Relay settings, from (highest first) CLI flags, environment variables, then the saved config. */
export function resolveRelay(
	dir: string,
	flags: { url?: string; token?: string },
	env: NodeJS.ProcessEnv = process.env,
): (RelayConfig & { source: string }) | undefined {
	if (flags.url && flags.token) return { url: flags.url, token: flags.token, source: "flags" };
	if (env.PI_MULTIPLAYER_RELAY_URL && env.PI_MULTIPLAYER_RELAY_TOKEN) {
		return { url: env.PI_MULTIPLAYER_RELAY_URL, token: env.PI_MULTIPLAYER_RELAY_TOKEN, source: "environment" };
	}
	const saved = read(dir).relay;
	return saved ? { ...saved, source: join(dir, CONFIG_FILE) } : undefined;
}

export function saveRelay(dir: string, relay: RelayConfig | undefined): void {
	const config = read(dir);
	if (relay) config.relay = relay;
	else delete config.relay;
	write(dir, config);
}

export function savedName(dir: string): string | undefined {
	return read(dir).name;
}

export function saveName(dir: string, name: string | undefined): void {
	const config = read(dir);
	if (name) config.name = name;
	else delete config.name;
	write(dir, config);
}

/** Accepts the relay's https:// address as shown by the host platform and turns it into a WebSocket URL. */
export function normalizeRelayUrl(input: string): string {
	const url = new URL(input.trim());
	if (url.protocol === "https:") url.protocol = "wss:";
	else if (url.protocol === "http:") url.protocol = "ws:";
	if (url.protocol !== "wss:" && url.protocol !== "ws:") throw new Error("Relay URL must start with https://, wss:// (or ws:// for local testing)");
	return url.toString().replace(/\/+$/, "");
}

export function maskToken(token: string): string {
	return token.length <= 8 ? "••••" : `${token.slice(0, 4)}…${token.slice(-4)}`;
}
