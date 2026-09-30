# pi-multiplayer

> [!WARNING]
> This project was created in early August 2026 as an experiment. It is not intended for production use.

Invite people into your live [pi](https://pi.dev) session. Everyone sees the conversation, tool calls and results as they happen. **Viewers** can only watch. **Contributors** can also prompt the shared agent and chat.

```
packages/
  core/          @pi-multiplayer/core — protocol, invites, roles, direct (TCP) and relay transports
  pi-multiplayer/  the pi extension (commands, flags, rendering) + end-to-end test
  relay/         @pi-multiplayer/relay — self-hostable relay server (Node or Docker)
                 deploy/  Docker Compose + Caddy, systemd, Cloudflare Containers, Fly.io
```

Turborepo drives the workspace: `npm test`, `npm run typecheck`, `npm run e2e`.

## Install

```bash
npm install
pi install ./packages/pi-multiplayer
```

## Quick start

```bash
# host
pi --share --as alice             # or run /mp start inside pi
/mp invite contributor            # → multiplayer contributor invite: pi --join pimp+wss://relay.example.com/s/…/…
/mp invite viewer

# guest: paste the command from the invite
pi --join pimp+wss://relay.example.com/s/<session>/<token> --as bob
```

Your display name comes from `--as <name>` for a single run, otherwise from the default you saved with `/mp name <name>`, otherwise from your OS username. (`--name` is taken: pi uses it for the session name.)

## Two ways to connect

**Through a relay (works across networks).** The host and guests both connect out to a relay server over WebSocket, so nobody opens ports. You need a relay token to *host* a session. Guests only need an invite.

```text
/mp relay https://relay.example.com               # asks for your host token (hidden input); saved to ~/.pi/agent/multiplayer.json (mode 600)
/mp start                                          # shares via the relay whenever one is configured
/mp relay                                          # show the current settings (token masked)
/mp relay off                                      # forget them
```

The relay settings can also come from `PI_MULTIPLAYER_RELAY_URL` and `PI_MULTIPLAYER_RELAY_TOKEN`, or from `--mp-relay` and `--mp-relay-token`. Order of precedence: flags, then environment, then the saved file.

### Using a remote relay: who needs what

There are two separate secrets:

| Secret | Who has it | What it allows |
|---|---|---|
| **Relay token** | The relay operator creates one per person allowed to host and lists it in `RELAY_TOKENS` on the server | Creating sessions on that relay. Without one, the relay refuses to start a session. |
| **Invite** (`pimp+wss://relay/s/<session>/<invite-secret>`) | The host creates one per role with `/mp invite` and shares it with guests | Joining that one session with that role. The host checks the invite secret, not the relay. |

Setup, step by step:

1. **Operator:** generate a token for each host (`docker run --rm pi-multiplayer-relay token`) and add it to the relay as `RELAY_TOKENS="niels=<token>,sam=<token>"`. Send each person their own token privately, for example through a password manager.
2. **Host, once:** `/mp relay https://relay.example.com`, then paste your token into the hidden prompt. It's saved to `~/.pi/agent/multiplayer.json`, which only you can read. Or set `PI_MULTIPLAYER_RELAY_URL` and `PI_MULTIPLAYER_RELAY_TOKEN`, for example from a secrets manager. The `niels=` label in `RELAY_TOKENS` only appears in the relay's logs; pi sends just the token.
3. **Host, each session:** `pi --share` (or `/mp start`), then `/mp invite contributor` or `/mp invite viewer`.
4. **Guest:** run the printed `pi --join pimp+wss://…`. Guests need no relay token and no configuration.

Consequences:
- Without a relay token, you can join sessions but never create one. Wrong tokens are rejected, and repeated attempts get the address locked out.
- An invite is a bearer link: anyone who has it can join with its role until you run `/mp revoke`. Knowing only the session ID isn't enough, because the host checks the invite secret.
- Tokens never appear in invites, and invite secrets aren't relay tokens. Sharing an invite never lets a guest host on your relay.
- To remove someone's hosting access, delete their token from `RELAY_TOKENS` and restart the relay. Their existing invites stop working when their session ends.

**Direct (same network or VPN).** The host listens on a TCP port and guests connect to it directly. Use this on a LAN, over Tailscale/WireGuard, or through `ssh -L`.

```text
/mp start direct                  # 127.0.0.1:4817
/mp start direct 4817 0.0.0.0     # accept LAN / tailnet guests
```

## Commands

```text
/mp start [relay | direct [port] [bind]]   start hosting
/mp relay [<url> | off]                     show, save (hidden token prompt) or clear relay settings
/mp name [<name> | off]                     show, save or clear your default display name
/mp invite <viewer|contributor>             create an invite (prints a ready-to-run pi --join …)
/mp who                                     participants and roles
/mp role <name> <viewer|contributor>        promote or demote, takes effect immediately
/mp kick <name>
/mp revoke [viewer|contributor]             invalidate outstanding invites
/mp approve <on|off>                        confirm each guest prompt before it runs
/mp stop
/mp join <invite> [name]                    same as starting pi with --join
/mp chat <message>                          message participants without prompting the agent
/mp leave
```

## Permissions

| Capability              | viewer | contributor | host |
|-------------------------|:------:|:-----------:|:----:|
| See transcript & tools  | ✓      | ✓           | ✓    |
| Chat                    |        | ✓           | ✓    |
| Prompt the agent        |        | ✓           | ✓    |
| Invite, change roles, kick, approve |  |         | ✓    |

The role comes from the invite that was used. Checks run in the guest for fast feedback, but the host enforces them on every message, whichever transport is used. A modified client can't bypass them, and neither can the relay. Guest prompts are sent to the agent as `[name] text` and are never expanded as slash commands on the host.

## Running a relay

The relay runs anywhere you can run a container or Node ≥ 22.18. It's one small process with one dependency (`ws`). It reads `PORT`, serves `GET /healthz`, and keeps sessions in memory. Invites and roles stay with the host; the relay only forwards messages.

Requirements for any platform:
- **WebSockets** must pass through your proxy or load balancer (the `Upgrade` header).
- **TLS** must be terminated in front of the relay, so clients use `wss://`.
- **Exactly one instance.** Sessions live in memory, so don't scale out or put it on scale-to-zero.
- **`RELAY_TOKENS`** should be set as a secret.

Generate host tokens (one per person who may host):

```bash
cd packages/relay && docker build -t pi-multiplayer-relay .
docker run --rm pi-multiplayer-relay token          # or: node src/main.ts token
```

Pick whichever fits your setup (examples in `packages/relay/deploy/`):

| Where | How |
|---|---|
| **Any server with Docker** | `deploy/compose`: relay + Caddy with automatic Let's Encrypt HTTPS. Copy `.env.example` to `.env`, set `RELAY_DOMAIN` and `RELAY_TOKENS`, then run `docker compose up -d`. |
| **Any server without Docker** | `deploy/systemd`: runs `node src/main.ts` as a hardened systemd service bound to localhost; put Caddy or nginx in front for TLS. |
| **Container platforms** (Railway, Render, Fly.io, Cloud Run, ECS, Kubernetes, …) | Deploy `packages/relay/Dockerfile`, set `RELAY_TOKENS`, `RELAY_TRUST_PROXY=1` and a single always-on instance, and use the platform's HTTPS URL as `wss://…`. `deploy/fly/fly.toml` is a ready example for Fly.io. |
| **Cloudflare Containers** | `deploy/cloudflare`: a Worker fronts one relay container. Run `npm install`, then `npx wrangler secret put RELAY_TOKENS`, then `npm run deploy`. Use `wss://pi-multiplayer-relay.<account>.workers.dev`. Needs the Workers Paid plan. The container only sleeps when no sessions are open, and the Worker passes the real client IP to the relay. |
| **Just running it** | `docker run -d -p 8787:8787 -e RELAY_TOKENS="niels=<token>" pi-multiplayer-relay` |

### Cloudflare Containers notes

- Every request goes to one named container (`max_instances: 1`).
- WebSocket messages keep the container awake. When its 15-minute idle timer runs out, the Worker checks `/stats` and only lets it sleep if no sessions are open.
- The Worker overwrites `X-Forwarded-For` with `CF-Connecting-IP`, so the relay's lockout applies per user rather than to everyone at once.
- Cloudflare restarts container hosts from time to time, and `wrangler deploy` replaces the running container. Either one drops open sessions. The host is told and runs `/mp start` again; invites must be re-sent because the session ID changes.
- After the container has slept, the first connection has a cold start of a few seconds.
- To try it locally, put `RELAY_TOKENS=niels=<token>` in `deploy/cloudflare/.dev.vars`, run `npm run dev`, and connect to `ws://localhost:8787`.

### nginx

nginx needs WebSocket upgrades enabled:

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 1h;
}
```

| Variable | Default | |
|---|---|---|
| `RELAY_TOKENS` | — | `label=token` pairs (comma-separated). Tokens must be at least 24 characters. |
| `RELAY_TOKENS_FILE` | — | One `label=token` per line, instead of `RELAY_TOKENS` |
| `RELAY_MAX_SESSIONS_PER_TOKEN` | 3 | Concurrent sessions per token |
| `RELAY_MAX_GUESTS` | 25 | Guests per session |
| `RELAY_TRUST_PROXY` | off | Read client IPs from `X-Forwarded-For` |
| `PORT` / `HOST` | 8787 / 0.0.0.0 | |

HTTP endpoints: `GET /healthz` returns `ok`. `GET /stats` returns `{"sessions":n,"guests":n}` (counts only). Hosts connect to `/host` over WebSocket, and guests to `/join/<session>`.

Relay protections:
- Tokens are compared in constant time against SHA-256 digests and never logged; logs show the label.
- An IP address is locked out for 15 minutes after 10 failed attempts.
- Session IDs are random 128-bit values.
- Messages are capped at 1 MB.
- Unauthenticated connections time out after 10 seconds, and dead connections are dropped by a 30-second heartbeat.

To revoke someone's hosting access, remove their token and restart the relay.

## Security notes

- A contributor's prompt runs tools **on the host's machine** with the host's permissions. Only give contributor invites to people you'd let use your terminal, or turn on `/mp approve on`.
- Invites are random 144-bit bearer tokens. Anyone holding one can join, so revoke them after use.
- The relay can read session traffic (TLS protects it only on the network). Run your own relay if that matters. Direct mode uses plain TCP, so use it over a VPN or SSH.
- The session stays shared while it's open. `/new`, `/resume` and `/reload` end hosting. If the relay connection drops, you're told and guests are disconnected; run `/mp start` again to reshare.

## Tests

- `packages/core`: 16 tests covering invites (direct and relay formats), roles, broadcast, promote/demote, kick, and a tampered client.
- `packages/relay`: 13 tests covering host token auth, lockout, per-token session limits, `/stats`, a full session through the relay, a viewer bypassing its local check, unknown sessions, guest cap, kick, host leave and relay loss.
- `packages/pi-multiplayer`: 12 unit tests (including the hidden token input), plus `test/e2e.ts`. The e2e starts real pi processes over RPC with a real model behind the host (`opencode-go/deepseek-v4.1-flash`; override with `MULTIPLAYER_MODEL`). It runs every scenario twice: direct, and through a relay running as a separate process. To test an existing relay (a container or your deployment), run:

  ```bash
  MULTIPLAYER_SUITES=relay MULTIPLAYER_RELAY_URL=wss://relay.example.com MULTIPLAYER_RELAY_TOKEN=<token> npm run e2e
  ```

  The transcript of a passing run is in [`docs/e2e-transcript.log`](docs/e2e-transcript.log).

  The relay suite has passed against a local relay process, the Docker image, the Compose + Caddy stack, and the Cloudflare Worker + container under `wrangler dev`. It hasn't been run against the systemd unit, Fly.io, or a real Cloudflare deployment yet.
