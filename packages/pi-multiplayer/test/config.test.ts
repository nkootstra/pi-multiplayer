import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CONFIG_FILE, maskToken, normalizeRelayUrl, resolveRelay, saveName, savedName, saveRelay } from "../src/config.ts";

describe("relay config", () => {
	it("prefers flags, then environment, then the saved file", () => {
		const dir = mkdtempSync(join(tmpdir(), "mp-config-"));
		assert.equal(resolveRelay(dir, {}, {}), undefined);

		saveRelay(dir, { url: "wss://saved", token: "saved-token" });
		assert.equal(resolveRelay(dir, {}, {})?.url, "wss://saved");
		assert.equal(statSync(join(dir, CONFIG_FILE)).mode & 0o777, 0o600);

		const env = { PI_MULTIPLAYER_RELAY_URL: "wss://env", PI_MULTIPLAYER_RELAY_TOKEN: "env-token" };
		assert.equal(resolveRelay(dir, {}, env)?.url, "wss://env");
		assert.equal(resolveRelay(dir, { url: "wss://flag", token: "flag-token" }, env)?.url, "wss://flag");

		saveRelay(dir, undefined);
		assert.equal(resolveRelay(dir, {}, {}), undefined);
	});

	it("masks tokens", () => {
		assert.equal(maskToken("abcdefghijklmnop"), "abcd…mnop");
		assert.equal(maskToken("short"), "••••");
	});

	it("accepts https relay addresses and converts them to WebSocket URLs", () => {
		assert.equal(normalizeRelayUrl("https://pi-multiplayer-relay.example.workers.dev/"), "wss://pi-multiplayer-relay.example.workers.dev");
		assert.equal(normalizeRelayUrl("http://localhost:8787"), "ws://localhost:8787");
		assert.equal(normalizeRelayUrl("wss://relay.example.com/prefix"), "wss://relay.example.com/prefix");
		assert.throws(() => normalizeRelayUrl("ftp://x"));
	});

	it("stores a default name next to the relay settings", () => {
		const dir = mkdtempSync(join(tmpdir(), "mp-config-"));
		saveRelay(dir, { url: "wss://r", token: "t" });
		saveName(dir, "niels");
		assert.equal(savedName(dir), "niels");
		assert.equal(resolveRelay(dir, {}, {})?.url, "wss://r");
		saveName(dir, undefined);
		assert.equal(savedName(dir), undefined);
	});
});
