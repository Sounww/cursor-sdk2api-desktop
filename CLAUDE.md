# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`cursor-sdk2api` is an MIT gateway that exposes the official `@cursor/sdk` (pinned at 1.0.30) as Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses. It is ESM TypeScript and requires Node.js `>=22.19`. Repository invariants live in `BFLABS.md`; `AGENTS.md` only points there.

## Commands

```bash
npm ci
npm run typecheck          # lint: server + web tsc --noEmit
npm test                   # vitest run, include tests/**/*.test.ts
npm test -- tests/contract/messages-tools.test.ts
npm test -- -t "test name"
npm run build              # tsc (tsconfig.build.json) + vite console into dist/
npm run dev                # rebuild console, then node --import tsx src/index.ts
npm run dev:web            # vite console only (web/vite.config.ts)
npm start                  # node dist/index.js, after build
npm run secret:scan        # bash tests/secret-scan.sh
```

CI (`.github/workflows/ci.yml`, Node 22.19) runs `typecheck`, `test`, `build`, and `docker build`. Local contract tests do not prove live model behavior. Live credentials, deployment, npm/GHCR publication, and release need separate authorization.

Live smoke is opt-in and must not run in default CI. The runner reads only environment variables you export in the current shell; it does not load `.env`.

```bash
npm run build
# CURSOR_LIVE_SMOKE=1 and CURSOR_API_KEY in the shell; do not commit or paste the key
npm run live:smoke         # tests/live-smoke/run.ts
npm run live:ordinary      # exact-lineage ordinary follow-up
npm run new-api:smoke      # integrations/new-api/smoke.mjs
```

Default listen is `0.0.0.0:8080`. `AUTH_MODE=managed` requires `GATEWAY_ACCESS_KEY`, and that key must differ from any Cursor key. Default auth is BYOK: the request bearer or `x-api-key` is the Cursor key. `STATE_DIR` defaults under the OS temp dir and is owner-only secret state.

## Architecture

One process owns each live SDK run and its single event-pump consumer. Chat and Responses do not have a second session engine; their parsers convert into canonical `ParsedMessages`, and only the HTTP writer differs.

```
HTTP /v1/messages | /v1/chat/completions | /v1/responses
  -> protocol parse
  -> CursorAgentTurn                         # src/core/cursor-agent-turn.ts
  -> RunCoordinator                          # src/core/run-coordinator.ts
       -> SdkRunDriver                       # only create/resume/send/pump wiring
       -> SessionRegistry                    # fingerprint, model, tool ids, TTL
       -> ToolBridge                         # client tools -> local.customTools
       -> EventPump                          # sole run.stream() consumer
       -> protocol writer                    # Anthropic SSE, Chat chunks, Responses events
  -> SdkRuntime                              # src/sdk/cursor-runtime.ts wraps @cursor/sdk
```

`src/index.ts` loads config, installs the outbound proxy, creates the runtime and an empty workspace, then listens. `src/server/app.ts` builds the coordinator and routes HTTP, including `/v1/models`, `/health`, `/v1/account`, and `/console/`. The HTTP layer must not import `@cursor/sdk` except through that runtime adapter. Tests inject `FakeSdk` from `tests/fixtures/fake-sdk.ts`.

Session states are `Creating -> Running -> AwaitingToolResults -> Resuming -> Running -> ... -> Completed`. Any active state can go to `Failed` or `Cancelled`, then `Closed`. Pending calls are a `Map` keyed by tool-use id.

Continuation:

- An exact ordinary follow-up (no `x-cursor-session-id`, complete transcript) reuses one durable Agent and `send()`s only the current user text and images. Digests live in `STATE_DIR/ordinary-turns.json`. Forks, compact or missing anchors, model/effort/tool-catalog mismatches, and credential rotation cold-rebuild. `ORDINARY_TURN_COORDINATOR=0` restores flatten-every-turn.
- A completed follow-up with `x-cursor-session-id` looks up lineage, checks credential, model, and session policy, then `Agent.resume` + `send` on that store.
- Tool continuation attaches, resumes lineage, or cold-recovers from a complete transcript whose latest assistant tool batch matches the submitted result ids. Historical completed calls are indexed by tool-name/input signature and replayed inside the gateway; they are not sent to the client again.
- Responses continuation is that full transcript plus the trailing `function_call_output` batch. `previous_response_id`, `store=true`, background, conversation, and hosted built-in tools fail closed. `POST /v1/responses/compact` returns one gateway-local `csgw1.` HMAC item and does not Send again.

Text and thinking stream through official `SendOptions.onDelta`. When onDelta is active, `run.stream()` assistant/thinking snapshots are not forwarded again. `customTool.execute` is the authority for client-visible `tool_use`; SDK `tool_call` stream events are diagnostic and de-duplicated by call id. Callbacks that fire during resume or send are queued on the Session and drained only after the pump is attached. The coordinator does not remap tools or call `Agent.resume` itself.

`STATE_DIR` holds:

- `sdk-store/<fingerprint>` — official `JsonlLocalAgentStore`, plus a private empty workspace per credential
- `lineage` — resume metadata only (session id, agent id, fingerprint, model parameters, policy and tool-catalog digests, pending tool ids). No prompts, tool payloads, or assistant bodies. Schema v2 quarantines older or incomplete records.
- `auths` — managed-mode Cursor keys, owner-only files
- optional SQLite `runtime.db` when `RUNTIME_LEDGER_V2=1` — claims one logical request, keeps observing after disconnect, and finalizes one receipt. Metadata and numeric usage only.

Runtime profiles: default `sdk`. Explicit `sand` requires a Grok Bot grant, the hash-guarded 1.0.30 loader, and an isolated store/workspace. There is no SDK↔Sand fallback.

When `HTTP_PROXY` or `HTTPS_PROXY` is set, Agent traffic switches to HTTP/1.1 with `proxy-agent`, and SDK fetch (`models.list`, account lookup) uses Undici `EnvHttpProxyAgent`. Both honor `NO_PROXY`. SOCKS and PAC fail closed. Health reports the transport mode and never the proxy URL.

The operator console is the Vite React app in `web/`. `npm run build:web` emits it to `dist/console`, and the same process serves it at `/console/`. Account import is `/v0/management/*` and has no separate access key.

## Invariants

Read `docs/SECURITY.md` before changing credentials, account pooling, state, logging, the console, proxy, or continuation.

- The Cursor SDK is the only Cursor execution engine. Ambient shell, read, edit, and task stay disabled. Hosted `webSearch` / `webFetch` stay off unless `HOSTED_SEARCH_MODE=auto` and the client sends a bare live web_search tool. Filters, required or named choice, Chat `web_search_options`, and `x_search` fail closed. This route does not provide native xAI `x_search`.
- Client tools execute in the client workspace. The gateway workspace is an empty directory owned by this process.
- A session binds to the credential fingerprint, model, and pending tool-id batch. A live tool-result delivery may accept a drifted request tool catalog because it only resolves callbacks already registered on the running Agent. Restart resume, explicit session follow-up, and ordinary Agent reuse still require the exact tool catalog. A different tool result for the same batch fails closed. Never re-execute a completed external tool.
- Managed mode may try one other account only before any semantic output. After headers or deltas start, there is no retry. Continuations stay pinned to the original credential.
- Do not log API keys, cookies, prompts, thinking, tool schemas, arguments, results, or proxy URLs. Do not enable `DEBUG=*` or `DEBUG=proxy-agent`.
- Browser cookies, private Cursor HTTP protocols, and BeefAPI user tokens are forbidden.
- Unsupported hosted tools and continuation features fail closed. The management API and console stay loopback-only unless an authenticated reverse proxy is explicitly designed.

## Where to read next

`docs/ARCHITECTURE.md` for run ownership and restart, `docs/PROTOCOL_COMPATIBILITY.md` for wire gaps, `docs/SECURITY.md`, and `docs/DEPLOYMENT.md`. Tests split into `tests/contract` (HTTP shapes), `tests/integration` (coordinator, lineage, recovery, account pool), and `tests/sdk` (dashboard, proxy, sand loader).
