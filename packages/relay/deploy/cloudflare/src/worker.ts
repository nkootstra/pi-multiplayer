// Fronts the relay container: every request goes to one named container instance, with the real
// client IP passed along so the relay's per-IP lockout works.
import { Container, getContainer } from "@cloudflare/containers";

interface Env {
	RELAY: DurableObjectNamespace<RelayContainer>;
	RELAY_TOKENS: string;
	RELAY_MAX_SESSIONS_PER_TOKEN?: string;
	RELAY_MAX_GUESTS?: string;
}

const RELAY_PORT = 8787;

export class RelayContainer extends Container<Env> {
	defaultPort = RELAY_PORT;
	// WebSocket messages renew this timer; onActivityExpired below also keeps busy relays up.
	sleepAfter = "15m";

	constructor(ctx: DurableObjectState<{}>, env: Env) {
		super(ctx, env);
		this.envVars = {
			PORT: String(RELAY_PORT),
			RELAY_TOKENS: env.RELAY_TOKENS,
			RELAY_TRUST_PROXY: "1",
			RELAY_MAX_SESSIONS_PER_TOKEN: env.RELAY_MAX_SESSIONS_PER_TOKEN ?? "3",
			RELAY_MAX_GUESTS: env.RELAY_MAX_GUESTS ?? "25",
		};
	}

	/** Only sleep when nobody is connected: a quiet session with no messages must not be cut off. */
	override async onActivityExpired(): Promise<void> {
		try {
			const stats = (await (await this.containerFetch("http://relay/stats")).json()) as { sessions: number };
			if (stats.sessions > 0) {
				this.renewActivityTimeout();
				return;
			}
		} catch {
			// Relay not answering: stopping lets the next request start a fresh one.
		}
		await this.stop();
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (!env.RELAY_TOKENS) return new Response("RELAY_TOKENS secret is not set\n", { status: 500 });
		const headers = new Headers(request.headers);
		// Overwrite rather than append, so clients can't spoof their address.
		headers.set("X-Forwarded-For", request.headers.get("CF-Connecting-IP") ?? "unknown");
		return getContainer(env.RELAY, "relay").fetch(new Request(request, { headers }));
	},
};
