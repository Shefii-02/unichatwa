# OpenWA Backend (`backend-node`) — Project Documentation

> **Purpose of this document:** a file-by-file, function-by-function, route-by-route map of the `backend-node` codebase, written so a new engineer can get oriented without reading the entire source tree first. For product vision, requirements, and high-level architecture diagrams, see the existing `docs/01-project-overview.md` … `docs/08-development-guidelines.md` series — this document is the engineering-level companion to those.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Repository Layout](#2-repository-layout)
3. [Request Lifecycle & Bootstrap](#3-request-lifecycle--bootstrap)
4. [Core Infrastructure](#4-core-infrastructure) — `app.module.ts`, `main.ts`, `src/config/`, `src/common/`, `src/database/`, `src/core/`
5. [Engine Layer](#5-engine-layer) — `src/engine/` (the pluggable WhatsApp-library abstraction)
6. [Modules — Core Messaging](#6-modules--core-messaging) — auth, session, message, channel, chat-media, media, call, events, webhook, status, status-store
7. [Modules — Contacts & Social](#7-modules--contacts--social) — contact, group, label, catalog, template, takeover, wa-chat, profile, staff-notify
8. [Modules — Automation, Integration & Ops](#8-modules--automation-integration--ops) — automation, integration, plugins, mcp, queue, search, settings, metrics, audit, health, infra, docker, stats
9. [Finding Your Way Around](#9-finding-your-way-around) — onboarding tips, conventions, where to look for X

---

## 1. Project Overview

**OpenWA** (package name `openwa`) is a free, open-source, self-hosted **WhatsApp API Gateway**. It exposes WhatsApp automation (sending/receiving messages, media, groups, contacts, catalogs, statuses, calls, etc.) as a REST + WebSocket HTTP API, so that other systems (CRMs, chatbots, support desks, n8n workflows, custom backends) can integrate with WhatsApp without talking to the WhatsApp Web protocol directly.

Key architectural facts every new engineer should know up front:

- **Framework:** [NestJS](https://nestjs.com/) (Express-based), written in TypeScript, Node.js ≥ 22.13.
- **Pluggable "engine" layer:** OpenWA does not implement the WhatsApp protocol itself. It wraps two underlying community libraries — **Baileys** (a WebSocket-based multi-device client) and **whatsapp-web.js** (a Puppeteer/browser-automation client) — behind a single internal contract (`IWhatsAppEngine` in `src/engine/interfaces/`). Every session picks one engine; the rest of the app is engine-agnostic. See [Section 5](#5-engine-layer).
- **Two databases, two purposes:**
  - A `main` TypeORM connection holds boot-critical data: API keys and audit logs (`src/modules/auth`, `src/modules/audit`). Defaults to SQLite; `MAIN_DATABASE_TYPE=mysql` switches it to MySQL (always `synchronize`d — there's no MySQL-dialect migration for it yet, see `src/database/migrations-main/`).
  - A `data` TypeORM connection (SQLite by default, Postgres optional) holds everything else: sessions, messages, webhooks, templates, engine state, integrations, status-store, automation rules.
- **Pluggable infrastructure everywhere else too:** storage backend (local disk / S3), cache (disabled / Redis), rate-limit storage (in-memory / Redis), via config rather than code changes.
- **Multi-session:** one OpenWA instance can run many independent WhatsApp sessions (phone numbers) concurrently.
- **Opt-in subsystems gated by env flags**, wired conditionally in `src/app.module.ts` so disabled features add zero runtime/DI cost:
  - `QUEUE_ENABLED=true` → mounts `QueueModule` (BullMQ background jobs, needs Redis).
  - `MCP_ENABLED=true` → mounts `McpModule` (Model Context Protocol server at `/mcp`, for AI agent tool-calling).
  - `SEARCH_ENABLED=false` → **disables** the global message-search module (on by default).
  - `SERVE_DASHBOARD=false` → disables serving the bundled React dashboard SPA from this same process/port.
- **Bundled dashboard:** `dashboard/` is a separate React/Vite SPA (session, webhook, API-key management UI) that, once built, is served by this same NestJS process (`ServeStaticModule` + custom handling in `main.ts` for CSP nonces). It is a separate frontend project, not documented file-by-file here.
- **A "wa-chat" module** (`src/modules/wa-chat/`) bridges this Node gateway to a separate **Laravel/MySQL** system ("Flowexa") for per-company multi-tenant scoping, shared auth tokens, and message logging. If you're porting a feature between the Laravel backend and this one, check which backend actually owns the data first.
- **Plugin system:** a sandboxed plugin architecture (`src/core/plugins/`) lets third-party/official plugins (Chatwoot, Typebot, FAQ bot, etc., see `data/plugins/*/dist/index.js`) hook into message events without being compiled into core.
- **Agent tools:** `src/core/agent-tools/` exposes a protocol-neutral tool registry (used by the MCP server and potentially other AI-agent integrations) so an LLM agent can call OpenWA capabilities as "tools."

---

## 2. Repository Layout

```
backend-node/
├── src/                  # NestJS application source (documented in full below)
├── dist/                 # Compiled JS output (nest build) — generated, not hand-edited
├── dashboard/            # Separate React/Vite SPA (session/webhook/API-key admin UI)
├── data/                 # Runtime data dir: SQLite files, uploaded media, plugin bundles (data/plugins/*/dist)
├── docs/                 # Product-level docs: 01-project-overview.md … 08-development-guidelines.md, numbered topic docs
├── scripts/               # Build/CI/maintenance scripts (postinstall patches, doc/version/contract checkers, backup.sh)
├── sdk/                  # Generated client SDKs: go, java, javascript, php, python
├── charts/openwa/        # Helm chart for Kubernetes deployment
├── test/                 # Jest e2e specs (*.e2e-spec.ts) + fixtures/mocks, run via `npm run test:e2e`
├── docker-compose.yml, docker-compose.dev.yml, Dockerfile, docker-entrypoint.sh
├── nest-cli.json, tsconfig*.json, eslint.config.mjs
├── openapi.json           # Exported OpenAPI contract (npm run openapi:export / openapi:check)
└── package.json
```

Inside `src/`, the convention is:

```
src/
├── app.module.ts, main.ts        # Bootstrap (Section 4)
├── config/                       # Env loading & validation, feature flags (Section 4)
├── common/                       # Cross-cutting: cache, errors, interceptors, media, metrics,
│                                  # middleware, openapi, security, services, storage, throttler,
│                                  # transformers, utils (Section 4)
├── database/                     # Data sources, migrations, boot-time DB setup (Section 4)
├── core/                         # agent-tools, hooks, plugins (sandboxed plugin runtime) (Section 4)
├── engine/                       # Pluggable WhatsApp engine abstraction + Baileys/whatsapp-web.js
│                                  # implementations (Section 5)
└── modules/                      # One NestJS module per feature/domain (Sections 6–8), each
                                   # typically shaped as:
                                   #   <module>/
                                   #     <module>.module.ts
                                   #     <module>.controller.ts   (HTTP routes)
                                   #     <module>.service.ts      (business logic)
                                   #     dto/                     (request/response shapes)
                                   #     entities/                (TypeORM entities, if it owns tables)
```

---

## 3. Request Lifecycle & Bootstrap

1. **`src/main.ts`** creates the Nest app, applies global config (CSP/security headers, body-size limits, Swagger/OpenAPI docs, static dashboard serving with CSP nonce injection), and starts listening.
2. **`src/app.module.ts`** is the application's root module. It:
   - Loads and validates env config (`ConfigModule` + `src/config/configuration.ts` + `src/config/env.validation.ts`).
   - Registers the two TypeORM connections (`main` and `data`, see above).
   - Registers rate limiting (`ThrottlerModule`, in-memory or Redis-backed).
   - Imports every feature module (`SessionModule`, `MessageModule`, `WebhookModule`, …) — the full import list doubles as the authoritative module inventory.
   - Conditionally imports `QueueModule` / `McpModule` / `SearchModule` / dashboard static-serving based on env flags (see Section 1).
3. Each feature module under `src/modules/**` wires its own Controller (HTTP routes) → Service (logic) → Entity/DTO (data shape), and talks to the `data` or `main` TypeORM connection as appropriate.
4. Messaging/engine operations are dispatched through `src/engine/**`, which routes the call to whichever underlying engine (Baileys or whatsapp-web.js) that session is configured to use.
5. Outbound side-effects fan out via: webhooks (`src/modules/webhook/`), WebSocket events (`src/modules/events/`), the hook system (`src/core/hooks/`) for plugins, and optionally a message queue (`src/modules/queue/`) when `QUEUE_ENABLED=true`.

For full detail on every file in `src/`, continue to the sections below — each was authored by reading every non-test source file in its scope.

---


## 4. Core Infrastructure

This section documents the root bootstrap files, `src/config/**`, `src/common/**`, `src/database/**`, and `src/core/**`. Together these form the "plumbing" of the gateway: how the process boots, how configuration and secrets are resolved, cross-cutting services shared by every feature module (logging, caching, storage, security, metrics), the two TypeORM database connections and their migrations, and the plugin/hook/agent-tool runtime that lets first-party and third-party code extend the gateway safely.

---

#### 1. Root bootstrap (`src/app.module.ts`, `src/main.ts`, `src/configure-app.ts`)

These three files are what actually starts the process: `main.ts` is the entry point, `configure-app.ts` holds the Express/HTTP middleware stack shared between production and e2e tests, and `app.module.ts` is the NestJS root module wiring every feature module together.

##### `src/main.ts`
Process entry point. Sets log level from `LOG_LEVEL`, installs uncaught-exception/unhandled-rejection monitors, runs the production-secret guard (`assertNoDefaultSecretsInProduction`), resolves/creates the storage root before Nest boots, creates the Nest app with `bodyParser: false` (so a custom size cap can be applied), wires the Redis Socket.IO adapter, calls `configureApp()` for the HTTP stack, sets up graceful shutdown on `SIGTERM`/`SIGINT` via `ShutdownService`, applies global DTO validation, conditionally mounts Swagger (`/api/docs`), protects the Bull Board UI (`/api/admin/queues`) with `BullBoardAuthMiddleware`, applies HTTP server timeouts, and finally calls `app.listen(port)`. The whole `bootstrap()` function is run through `runBootstrapOrExit` so any failure (including a post-`listen()` bind failure) logs, best-effort tears down the app, and exits non-zero rather than leaving a zombie process.
- `bootstrap()` — the full boot sequence described above.
- Module-scope `appInstance` — exposed so the fatal-exit handler can best-effort `app.close()` even if `NestFactory.create` already finished.

##### `src/configure-app.ts`
Exports `configureApp(app, options?)`, the shared HTTP middleware stack applied identically by production (`main.ts`) and by the e2e test harness (which could not otherwise exercise it, since `main.ts` boots on import). Order is load-bearing: in-flight body budget → body parsers (`json`/`urlencoded`, capturing `req.rawBody` for HMAC verification) → request-context middleware (request ID) → CSP nonce → Helmet (CSP directives, HSTS, referrer policy) → dashboard SPA document handler (injects the per-response CSP nonce into `index.html`) → CORS.
- `configureApp(app, options)` — installs the whole stack; returns `{ bodyLimit, inflightBudgetBytes }` for boot logging.
- Exports `DashboardSource`, `ConfigureAppOptions`, `AppliedBodyCaps` interfaces.

##### `src/app.module.ts`
The NestJS root `@Module`. Registers `ConfigModule` (global, validated via `validateEnv`), two separate `TypeOrmModule.forRootAsync` connections:
- **`main`** connection — `better-sqlite3` by default (holds `auth`/`audit` entities, migrations in `migrations-main/`; `synchronize` defaults on, and when off `migrationsRun` takes over), or `mysql` when `MAIN_DATABASE_TYPE=mysql` (always `synchronize`s — `migrations-main/` is SQLite-only SQL, not MySQL-compatible).
- **`data`** connection — pluggable (`sqlite` or `postgres`), holds session/webhook/message/template/engine/integration/status-store/automation entities, migrations in `migrations/`. For Postgres, `dataSourceFactory: createBootDataSource` runs boot migrations under a cross-replica advisory lock instead of TypeORM's built-in `migrationsRun`.

Also registers `ThrottlerModule` (Redis-backed storage when `REDIS_ENABLED=true`, else in-memory), and imports nearly every feature module in the codebase (`SessionModule`, `MessageModule`, `WebhookModule`, `AuthModule`, `EngineModule`, `HooksModule`, `PluginsModule`, `AgentToolsModule`, `IntegrationModule`, `WaChatModule`, `StaffNotifyModule`, etc.). Several module groups are conditionally included based on env flags: `QueueModule` (`QUEUE_ENABLED`), `SearchModule` (`SEARCH_ENABLED`, default on), `McpModule` (`MCP_ENABLED`), and `ServeStaticModule` (serves the bundled dashboard SPA when `SERVE_DASHBOARD!=false` and a build is present). Provides `SqlitePermissionsBoot`, which tightens SQLite file permissions once every DataSource has initialized.
- Exports `DASHBOARD_DIST` (resolved path to `dashboard/dist`), `dashboardServingEnabled`, `dashboardBuildPresent` — consumed by `main.ts` and `configure-app.ts`.

---

#### 2. `src/config/**`

Everything that resolves environment variables into typed configuration, validates them at boot, and implements the handful of pure boot-time security/behavior decisions (CORS policy, Swagger gating, default-secret refusal, CSP). This directory is the single source of truth for "what does this env var mean" — almost every other module reads configuration through `ConfigService` populated from `configuration.ts`, not `process.env` directly.

##### `src/config/load-env.ts`
Populates `process.env` from three layers **before any other module is imported** (imported first by `main.ts`): process env (highest priority) → `.env` → `data/.env.generated` (dashboard-managed, created with sane defaults on first run). Uses `dotenv.config({ override: false })` for both files so higher layers always win. Tightens secret files to `0600`, clears blank dashboard-forwarded keys so they don't shadow lower layers, and snapshots which keys came from the OS vs. are "pinned" by a higher layer (used by the dashboard's save-config guard).
- `loadEnvironment()` — runs the full load sequence; called immediately on import (side effect).

##### `src/config/env-precedence.ts`
Support for `load-env.ts`'s layering model.
- `BLANK_SHADOWED_ENV_KEYS` — the full list of env keys the bundled `docker-compose.yml` forwards as `${KEY:-}` (blank when unset); a huge, deliberately-exhaustive array checked against the compose file by a spec.
- `clearBlankEnv(env, keys)` — deletes a key from `env` if present but blank, so a blank compose-forward doesn't shadow `.env`/`data/.env.generated`.
- `recordOsEnvKeys(env)` / `isOsProvidedEnv(key)` — snapshot + query of which keys came from the real host/orchestrator (used by the dashboard's save-config boot guard).
- `recordPinnedEnvKeys(env)` / `isEnvPinned(key)` — snapshot + query of which keys are already set before `data/.env.generated` loads (host env + `.env`), i.e. which keys a dashboard save cannot actually change until that layer is edited.

##### `src/config/configuration.ts`
The `ConfigModule.forRoot({ load: [configuration] })` factory — the single function that turns `process.env` into the nested config object every service reads via `ConfigService.get('namespace.key', default)`. Covers: `port`, `dataDir`, `http` (timeouts + in-flight body budget), `search`, `stats`, `features` (delegates to `feature-flags.ts`), `sendPacing` (delegates to `message/send-pacing.config.ts`), `redis`, `queue`, `cache`, `database` (main/SQLite), `dataDatabase` (pluggable), `engine` (puppeteer args, Baileys auth dir), `sessions`, `webhook`, `api.rateLimit`, `websocket` (delegates to `events/ws-rate-limit.ts`), `security.trustedProxies`, `plugins`, `ingress`, `status`, `chatMedia`, `session` (ownership/lease config), `automation`, `mediaConversion`, `template`, `storage`.
- `resolveNonNegativeIntEnv(raw, fallback)` — shared parser: blank → fallback, `0` is a valid explicit opt-out, non-decimal → fallback.
- `withPinnedBrowserLocale(args)` — appends `--lang=en-US` to Puppeteer args unless the operator already set one (returns a new array, never mutates).
- Exports `DEFAULT_DATA_DIR`, `DEFAULT_PLUGINS_DIR`, `LEGACY_PLUGINS_DIR`, `PINNED_BROWSER_LOCALE`.

##### `src/config/env.validation.ts`
`validateEnv(config)` — the `ConfigModule.forRoot({ validate })` callback. Fails boot fast (throws, aggregating every error) rather than silently coercing bad input. Validates: `DATABASE_TYPE` enum, `ENGINE_TYPE`/`STORAGE_TYPE` enums, `NODE_ENV` enum (but unset stays legal), Postgres-required fields + the `DATABASE_SYNCHRONIZE=true` + Postgres incompatibility, `POSTGRES_SCHEMA` identifier shape, the SQLite main/data file-collision guard, `DATABASE_NAME` SQLite-path-shape heuristic, a long list of port/non-negative-int/positive-int/signed-int numeric knobs, `BAILEYS_WA_VERSION` shape, the session-lease heartbeat-vs-TTL margin, `NODE_URL` shape (absolute http(s), no embedded credentials), and a long allowlist of strict-boolean env vars (`'true'`/`'false'` only) plus the one lenient-boolean exception (`MEDIA_DOWNLOAD_ENABLED`, which its read site normalizes more forgivingly) and the `SEARCH_PROVIDER` enum.
- `sqliteDataMainPathCollision(config)` — shared by both the app boot validator and the migration CLI data-sources: refuses a `DATABASE_NAME` that resolves to the same file as the main (auth/audit) SQLite DB.
- `validateEnv(config)` — the full validator described above.

##### `src/config/app-validation.ts`
- `GLOBAL_VALIDATION_OPTIONS` — the shared `ValidationPipe` options object (`whitelist`, `forbidNonWhitelisted`, `transform`, implicit conversion) that both production and specs must use identically.
- `applyGlobalValidation(app)` — sets the global `/api` prefix and installs the `ValidationPipe`, with `disableErrorMessages` resolved from `VALIDATION_ERROR_DETAIL`/`NODE_ENV` via `bootstrap-security.ts`.

##### `src/config/bootstrap-security.ts`
Pure, unit-tested boot-time security decisions, each with an explicit-env-wins / environment-dependent-default pattern:
- `resolveCorsPolicy(corsOriginsEnv, nodeEnv)` — wildcard CORS is refused outright in production.
- `isSwaggerEnabled`, `isValidationErrorDetailEnabled`, `isUpgradeInsecureRequestsEnabled` — each: explicit `'true'`/`'false'` wins; otherwise a production-aware default.
- `isDashboardCspUpgradeTrapLikely(env)` — detects the scenario where CSP `upgrade-insecure-requests` is on but the dashboard may be served over plain HTTP (the "#731" blank-dashboard trap); used to print a boot warning.
- `resolveBodyLimit(bodySizeEnv)` — parses `BODY_SIZE_LIMIT` (e.g. `25mb`); any unparseable value silently falls back to `'25mb'` rather than disabling the cap.
- `isApiKeyPepperMissingInProduction`, `isNodeEnvUnset` — advisory-only boot warnings.
- `assertNoDefaultSecretsInProduction(env)` — **throws** (refuses to boot) in any environment that isn't `development`/`test`/unset if `DATABASE_PASSWORD`, `S3_ACCESS_KEY`/`S3_SECRET_KEY`, `API_MASTER_KEY`, or `REDIS_PASSWORD` is empty or a known placeholder (`'openwa'`, `'minioadmin'`, `'changeme'`, etc.), with built-in-datastore exemptions for the bundled Postgres/MinIO on their internal hostnames. Also refuses `ALLOW_DEV_API_KEY=true` in production.

##### `src/config/dashboard-csp.ts`
- `DASHBOARD_CSP_NONCE_PLACEHOLDER` — the literal string baked into the bundled dashboard HTML.
- `injectDashboardCspNonce(html, nonce)` — replaces every occurrence of the placeholder with the per-response CSP nonce (used by `configure-app.ts`'s SPA document handler).

##### `src/config/feature-flags.ts`
Centralizes every runtime feature-flag env var in one typed object (`FeatureFlags`), surfaced through `ConfigService` as `features.*`.
- `computeFeatureFlags(env?)` — derives `autoStartSessions`, `storeEphemeralMessages`, `resolveLidToPhone`, `simulateTyping`, `simulateTypingMaxMs` from env, preserving the exact original comparison semantics (`=== 'true'` vs `!== 'false'`).
- `resolveFeatureFlags(configService?)` — prefers the `ConfigService`-loaded snapshot, falls back to a live `process.env` read (used by unit tests that mutate env without a `ConfigModule`).

##### `src/config/http-timeouts.ts`
- `applyHttpTimeouts(server, cfg)` — writes `requestTimeout`/`headersTimeout`/`keepAliveTimeout` onto the real Node `http.Server` (not the Express app), bumping `headersTimeout` above `keepAliveTimeout` when needed (Node requires the former to exceed the latter) and returning the resolved report for boot logging.

##### `src/config/inflight-body-budget.ts`
Implements the aggregate in-flight request-body DoS guard described in `configure-app.ts`: bounds total buffered request-body bytes across **all** connections (not just one request), refusing new requests with `503 + Retry-After` before a single body byte is read once the budget (or a per-client share of it) is exhausted. Runs *before* the body parser so a compressed (`Content-Encoding != identity`) body is refused with `415` rather than being admitted at its compressed size and inflated past the budget. Includes a stall reaper that destroys a connection that sent headers then went silent, and per-client fairness via a capped `Map` of client→in-flight-bytes.
- `parseBodyLimitBytes(limit)` — parses a body-limit string (`'25mb'`, etc.) to bytes.
- `resolveInflightBodyBudgetBytes(budgetEnv, bodyLimitEnv)` — resolves the aggregate budget; defaults to 4× the per-request limit.
- `createInflightBodyBudget(budgetBytes, options?)` — returns `{ middleware, currentBytes, clientBytes }`.

##### `src/config/process-error-monitor.ts`
- `registerUncaughtExceptionMonitor(logger)` — routes an uncaught exception's stack through the structured logger *before* Node's default print+exit (via `uncaughtExceptionMonitor`, which does not swallow — the crash-and-restart posture is unchanged).
- `registerUnhandledRejectionHandler(logger)` — backstop for stray promise rejections; keeps the process alive, but downgrades a specific known-benign Puppeteer "page context lost" rejection pattern to a `warn` instead of an `error` so it doesn't read as a crash.

##### `src/config/storage-root.ts`
- `DEFAULT_STORAGE_ROOT` — `'./data/media'`.
- `isStorageRootWritable(root)` — probes writability (not just existence) by `mkdir`+`accessSync`.
- `resolveStorageRoot(options)` — fails fast (throws) if the configured `STORAGE_LOCAL_PATH` is unwritable, **except** for a specific known-bad fossil value (`./uploads`/`uploads`, left over from a pre-v0.7.4 bug) which is silently migrated to the default with a warning. Called by `main.ts` before `NestFactory.create` so `configuration.ts` sees the resolved value.

##### `src/config/swagger.config.ts`
- `API_KEY_SECURITY_SCHEME`, `METRICS_BEARER_SCHEME` — named security schemes.
- `PUBLIC_PATHS` — the hand-maintained list of `@Public()` routes whose OpenAPI operations must publish `security: []` (health checks, infra health, the plugin ingress wildcard route).
- `dropUnexpressibleOperations(document)` — strips path-item fields OpenAPI 3.0's schema can't express (notably the `search` HTTP method, which NestJS's Swagger explorer expands but OpenAPI 3.0 has no field for).
- `exemptPublicOperations(document)` — sets `security: []` on every operation under `PUBLIC_PATHS`.
- `createSwaggerConfig()` — builds the full `DocumentBuilder` config (title, description, API-key + bearer schemes, ~20 tags, two servers — relative `'/'` first so Swagger UI's "Try it" calls the serving origin, then a templated absolute one for display).

---

#### 3. `src/common/**`

Cross-cutting infrastructure shared by every feature module: caching, typed domain errors, interceptors/middleware for metrics and request context, SSRF-safe networking, storage abstraction (local + S3), Redis-backed throttling, and small focused utilities (IP resolution, pagination, path safety, concurrency limiting, etc.). Nothing here depends on a specific feature module.

##### 3.1 `src/common/cache/`

Optional Redis-backed cache for session status/info/QR/list/stats, used as a best-effort read-through layer — every method fails safe to `null`/no-op when Redis is unavailable.

**`cache.module.ts`** — `@Global()` module; provides/exports `CacheService`.

**`cache.service.ts`** — `CacheService implements OnModuleDestroy`
- `isAvailable()` — lazily creates the Redis client (`lazyConnect`, `enableOfflineQueue:false`, bounded retry backoff that never gives up) and pings it; returns `false` whenever disabled or unreachable, never throws.
- `getSessionStatus`/`setSessionStatus`, `getSessionInfo`/`setSessionInfo`, `getSessionQR`/`setSessionQR`, `getSessionsList`/`setSessionsList`, `getSessionsStats`/`setSessionsStats` — all best-effort get/setex pairs with fixed TTLs (5min–30s); every failure is caught and logged at `warn`, never thrown.
- `onModuleDestroy()` — races a graceful `quit()` against a 2s deadline, then force-`disconnect()`s regardless, so shutdown never blocks on a dead Redis.

**`index.ts`** — barrel re-exporting the module + service.

##### 3.2 `src/common/errors/`

One small `NotFoundException`/`ConflictException`/etc. subclass per domain failure mode, each mapped to a specific HTTP status purely by extending the right NestJS built-in exception (no custom filter needed):

| File | Class | HTTP | When thrown |
|---|---|---|---|
| `call-not-found.error.ts` | `CallNotFoundError` | 404 | A call id isn't (or no longer) ringing. |
| `channel-media-not-supported.error.ts` | `ChannelMediaNotSupportedError` | 501 | Media send to a `@newsletter` channel on whatsapp-web.js (upstream bug). |
| `channel-not-found.error.ts` | `ChannelNotFoundError` | 404 | Channel id not among the session's subscribed channels. |
| `chat-labels-unsupported.error.ts` | `ChatLabelsUnsupportedError` | 422 | Label write on a non-Business account or unsupported chat type. |
| `engine-not-ready.error.ts` | `EngineNotReadyError` | 409 | Engine exists but isn't `READY`. |
| `engine-not-supported.error.ts` | `EngineNotSupportedError` | 501 | Method in the `IWhatsAppEngine` contract but unimplemented by the active engine. |
| `engine-refused.error.ts` | `EngineRefusedError` | 403 | WhatsApp itself refused an otherwise well-formed operation. |
| `engine-transport.error.ts` | `EngineTransportError` | 503 | Transport-level failure (dead page/socket), distinct from a 404 "not found". |
| `group-not-found.error.ts` | `GroupNotFoundError` | 404 | Group id doesn't resolve to a group chat. |
| `invalid-invite-code.error.ts` | `InvalidInviteCodeError` | 400 | Invite code invalid/expired/revoked. |
| `label-not-found.error.ts` | `LabelNotFoundError` | 404 | Label id unknown. |
| `message-not-found.error.ts` | `MessageNotFoundError` | 404 | Message id outside the adapter's lookup window or revoked. |
| `recipient-unreachable.error.ts` | `RecipientUnreachableError` | 400 | WhatsApp cannot resolve the recipient to an addressable id (surfaces the LID-migration `getNumberId` null case instead of a raw 500). |

##### 3.3 `src/common/interceptors/`

**`request-metrics.interceptor.ts`** — `RequestMetricsInterceptor implements NestInterceptor`. Records one HTTP RED (rate/errors/duration) observation per request by listening for the response's `finish`/`close` (so it sees the *final* status code, written after exception filters run), using the Express route pattern as the metric label (falling back to `Controller#handler`). Skips `/api/health*` and `/api/metrics`. Calls `claimHttpRequestMetrics(req)` synchronously so the companion boundary middleware (3.4) doesn't double-count requests that reach this layer.

##### 3.4 `src/common/media/`

**`load-remote-media.ts`** — `loadRemoteMediaBuffer(url)`: fetches remote media as a `Buffer` for engine sends, through the SSRF guard (`withSafeFetch`), with a byte cap (`MEDIA_DOWNLOAD_MAX_BYTES`, default 50MB) enforced while streaming (not relying on `Content-Length`) and a timeout (`MEDIA_DOWNLOAD_TIMEOUT_MS`, default 30s). Engine-neutral — returns `{ data, mimetype }`.

##### 3.5 `src/common/metrics/`

Dependency-free, in-process Prometheus-style metric stores (no `prom-client`), each reset only on process restart.

- **`request-metrics.ts`** — `recordHttpRequest(method, route, status, durationSeconds)` / `renderHttpRequestMetrics()` / `resetHttpRequestMetrics()` (test-only). Maintains `http_requests_total` (counter, labeled `method,route,status`) and `http_request_duration_seconds` (histogram with fixed buckets).
- **`send-pacing-metrics.ts`** — `incrementSendPacingRefusals(reason)` / `getSendPacingRefusals()` / `resetSendPacingRefusals()`. Counts sends refused by the pacing governor, keyed by `'daily_cap' | 'cold_daily_cap' | 'breaker_open'`.
- **`session-reconnect-metrics.ts`** — `incrementSessionReconnectAttempts()` / `getSessionReconnectAttemptsTotal()`, `incrementSessionReconnectLoopAlerts()` / `getSessionReconnectLoopAlertsTotal()`.
- **`session-restriction-metrics.ts`** — a gauge (not counter) for "sessions WhatsApp is currently restricting". `setRestrictedSessionCount(count)` / `registerRestrictedSessionRecount(fn)` (lets `SessionRestrictionStore` register a live recount that supersedes the mirrored value, so an expiry that isn't a mutation doesn't go stale) / `getRestrictedSessionCount()`.
- **`webhook-delivery-metrics.ts`** — `incrementWebhookDeliveryFailures()` / `getWebhookDeliveryFailuresTotal()`. Counts terminal (all-retries-exhausted) webhook delivery failures.

##### 3.6 `src/common/middleware/`

- **`request-context.middleware.ts`** — `requestContextMiddleware(req, res, next)`: assigns a request id (accepts a sane client-supplied `X-Request-ID`, else generates a UUID), echoes it on the response header, and runs the whole downstream chain inside `runWithRequestId` (an `AsyncLocalStorage` scope — see `services/request-context.ts`) so every log line/audit row can carry it.
- **`request-metrics.middleware.ts`** — `requestMetricsBoundaryMiddleware(req, res, next)`: the companion to `RequestMetricsInterceptor`. Runs *before* guards/interceptors (per Nest's pipeline), so it records requests rejected earlier (429 from the throttler, 401/403 from the API-key guard) that never reach the interceptor. Exports `claimHttpRequestMetrics(req)` / the `HTTP_REQUEST_METRICS_CLAIMED` symbol so the two layers agree on exactly-once counting.

##### 3.7 `src/common/openapi/`

**`engine-status-responses.ts`** — a set of shared, carefully-worded OpenAPI response-description string constants (`ENGINE_NOT_READY_409`, `PAIRING_NOT_READY_409`, `SESSION_NOT_STARTED_404`, `RECIPIENT_UNREACHABLE_400`, `ENGINE_REFUSED_403`, `MESSAGE_NOT_FOUND_404`, `CHANNEL_NOT_FOUND_404`, `CHANNEL_INVITE_NOT_FOUND_404`, `CUSTOM_LINK_PREVIEW_501`, `GROUP_NOT_FOUND_404`, `LABEL_NOT_FOUND_404`, `ENGINE_NOT_SUPPORTED_501`, `CHANNEL_MEDIA_501`) reused across many controllers' `@ApiResponse` decorators so the documented behavior of a shared error class can't drift between the many routes that can throw it.

##### 3.8 `src/common/security/`

The SSRF guard, constant-time comparison, proxy-aware rate limiting, session-scope resolution, and the Bull Board auth middleware — the security-critical primitives most of the rest of the codebase builds on.

**`bull-board-auth.middleware.ts`** — `BullBoardAuthMiddleware implements NestMiddleware`. Protects `/api/admin/queues` (mounted as raw Express middleware by `@bull-board/nestjs`, outside the global `ApiKeyGuard`'s reach). Requires a valid **ADMIN**-role API key (header or Bearer, no `?apiKey` query fallback — avoids leaking into logs), a pre-auth per-IP rate limit (`KeyRateLimiter`, shared config with the MCP mount), and refuses session-restricted keys outright (the board has no session dimension to scope against). Audits auth failures (`WARN API_KEY_AUTH_FAILED`) and non-GET/HEAD mutations (`INFO QUEUE_BOARD_MUTATED`).

**`constantTimeEqual.ts`** — `constantTimeEqual(a, b)`: hashes both inputs with a per-process random key (fixed-length SHA-256 digests) before `timingSafeEqual`, so the comparison never leaks the expected value's *length* through an early-return timing channel (which `timingSafeEqual` alone would do on mismatched lengths).

**`proxy-aware-throttler.guard.ts`** — `ProxyAwareThrottlerGuard extends ThrottlerGuard`. Overrides `getTracker` to key rate-limit buckets on the trusted-proxy-aware resolved client IP (via `resolveClientIp`) instead of `req.ip`, which behind an unconfigured reverse proxy would collapse every client onto one shared bucket (self-DoS); warns once per process if `X-Forwarded-For` is seen with no `TRUSTED_PROXIES` configured. Overrides `shouldSkip` so a bare `@SkipThrottle()` (which writes a decorator key the base guard's per-tier check never matches, given this app's named tiers) actually skips every configured tier.

**`session-scope.ts`**
- `resolveSessionScope(allowedSessions, requestedSessionId?)` — narrows (never broadens) a scoped key's session filter for query-param-based session scoping (endpoints the route-param-only `ApiKeyGuard` fence doesn't cover, e.g. audit/webhook-failures list endpoints).
- `sessionScopeVisible(allowedSessions, sessionScope)` — whether a resource's session binding (which may travel in the body or a persisted row) falls inside a scoped key's `allowedSessions`.

**`ssrf-guard.ts`** — the core outbound-network security primitive, used by webhook delivery, media downloads, plugin `net.fetch`, and plugin downloads.
- `SsrfBlockedError` — thrown on a blocked destination.
- `SSRF_BLOCKED_CLIENT_MESSAGE` / `redactSsrfError(error, logger?, site?)` — redacts the internal-IP detail from an `SsrfBlockedError` (and OS-level connect-error hostnames) before it can reach an HTTP response, a persisted DLQ row, or a webhook payload; logs the real detail server-side.
- `isSsrfProtectionEnabled()` — reads `WEBHOOK_SSRF_PROTECT` (default on).
- `isBlockedAddress(ip)` — classifies an IPv4/IPv6 literal against hand-maintained blocklists (RFC1918, loopback, link-local/cloud-metadata, CGNAT, multicast, reserved) using Node's `net.BlockList`, including a full IPv4-in-IPv6 decapsulation ladder (`::ffff:`, 6to4, NAT64, IPv4-compatible, RFC6052) so an embedded public IPv4 is still evaluated correctly and an embedded private one is still blocked; unrecognizable input fails closed (blocked).
- `resolveSafeFetchTarget(rawUrl, signal?)` — validates scheme + host (allowlist escape hatch via `SSRF_ALLOWED_HOSTS`) and resolves DNS **once** (bounded by a timeout), returning the vetted addresses so the caller can pin the connection and defeat a DNS-rebind TOCTOU window.
- `assertSafeFetchUrl(rawUrl, signal?)` — throw-only form, used at webhook registration time.
- `pinnedLookup(addresses)` — builds a `net`-style lookup function that never re-resolves DNS, for use with an undici `Agent`.
- `withSafeFetch(rawUrl, init, use, opts?)` — the main entry point: validates+pins the connection, refuses redirects by default (the guard only validated the original host), has a `followRedirects` mode that re-validates **every** hop before connecting (used for plugin downloads, with an https→http downgrade refusal unless explicitly opted into), and always cancels an unread response body before tearing the dispatcher down (avoids an unhandled `ECONNRESET`-class crash, #887).

##### 3.9 `src/common/services/`

**`logger.module.ts`** — `@Global()` module providing/exporting `LoggerService` and `ShutdownService`.

**`logger.service.ts`**
- `LoggerService implements NestLoggerService` (`@Injectable({ scope: Scope.TRANSIENT })`) — structured logger with a static process-wide log level/format. `log`/`error`/`warn`/`debug`/`verbose` each redact secret-named keys (password/token/api-key/etc., recursively, depth-bounded) from any structured context before emitting, stamp the active request id (from `request-context.ts`) when present, and render as either JSON (production default) or a human-readable colorized line (NestJS-lookalike format, dev default) depending on `LOG_FORMAT`/`NODE_ENV`/TTY detection.
- `createLogger(context)` — factory that constructs a `LoggerService` and sets its context in one call; this is the idiom used almost everywhere else in the codebase instead of DI-injecting the logger.
- `LogLevel`, `LogFormat` enums; `LogContext` interface.

**`request-context.ts`** — per-request `AsyncLocalStorage<RequestContext>` carrying `requestId`, and (once resolved) `apiKeyId`/`apiKeyName`/`ipAddress`.
- `runWithRequestId(requestId, fn)` — entry point (called by the request-context middleware).
- `getRequestId()` — read the active request id (or `undefined` outside a request scope).
- `setRequestActor(actor)` — stamps the resolved API key + IP once a guard/middleware has authenticated the request, so deep service code can attribute audit-log writes without threading the key through every call. No-op outside a request scope.
- `getRequestActor()` — reads the stamped actor.

**`shutdown.service.ts`** — `ShutdownService`. Owns the graceful-drain state machine `main.ts`'s signal handlers drive.
- `setShutdownCallback(callback)` — registers the `app.close()` callback.
- `isShuttingDown()` — read by the readiness probe to flip to 503 during drain.
- `markShuttingDown()` — idempotently flips the draining flag.
- `shutdown(delayMs?)` — schedules (once, idempotently) teardown after a bounded grace window (default 3s, env-tunable via `SHUTDOWN_DELAY_MS`, 0 in dev/test, capped at 30s); exits with code 0 on clean teardown, 1 on a teardown failure.

##### 3.10 `src/common/storage/`

Pluggable media storage (local filesystem or S3/MinIO) with read-through/write-through fallback semantics during an S3 outage, plus shared helpers for orphan-sweeping and tar.gz export/import.

**`storage.module.ts`** — `@Global()` module; provides/exports `StorageService`.

**`storage.service.ts`** — `StorageService implements OnModuleDestroy`. The central abstraction every feature that persists media (chat-media archive, status store, data export/import) goes through.
- `listFiles()` / `iterateFiles(prefix?)` — capped (`STORAGE_LIST_MAX_FILES`) vs. uncapped-streaming enumeration; when S3 is active, both union the S3 listing with the local fallback directory (media written while S3 was down).
- `getFile(filePath)` / `putFile(filePath, data)` / `deleteFile(filePath)` — all guarded by `isSafeStorageKey` (rejects traversal/unsafe keys) at this single boundary so both backends inherit the guard. `getFile` read-throughs to the local fallback on an S3 `NoSuchKey`. `deleteFile` deletes from both backends when S3 is active (symmetric with the read-through).
- `getFileCount()` — count + total bytes, unioning S3's `ListObjectsV2`-reported sizes with a `stat()` walk of the local fallback (uses the real per-object size on S3, not an estimate).
- `createExportStream()` / `importFromStream(inputStream)` — delegate to `storage-transfer.ts`.
- `isS3Available()` / `refreshS3Availability()` — S3 reachability state; a throttled (10s), in-flight-deduped re-probe that only ever transitions `false → true` (recovery is one-way; a session already on S3 is never silently dropped back to local).
- Internally starts a periodic re-probe timer (`S3_REPROBE_INTERVAL_MS`, default 60s) while degraded to local fallback.
- `isMissingObjectError(error)` (exported function) — cross-backend "object not found" check (local `ENOENT` vs. S3 `NoSuchKey`/`NotFound`/404).

**`storage-local-files.ts`** — local-filesystem primitives `StorageService` delegates to.
- `listLocalFiles(localPath)` — capped enumeration (`STORAGE_LIST_MAX_FILES`, default 100k).
- `iterateLocalFiles(localPath, prefix?)` — uncapped async generator; iterative BFS (not recursion, so no stack overflow / event-loop blocking), bounded to `LOCAL_TRAVERSAL_MAX_DEPTH` (20).
- `getLocalFile` / `putLocalFile` / `deleteLocalFile` — each re-validates `isPathWithin` independently (defense in depth even though `StorageService` already gates).

**`storage-transfer.ts`** — tar.gz export/import streams for the full-store migration/backup feature.
- `createExportStream(listFiles, getFile, logger)` — builds a gzip `TarArchive` stream; warns (doesn't block) when the export exceeds the local import limit, so an operator restoring onto this same gateway later knows to raise `STORAGE_IMPORT_MAX_ENTRIES` first.
- `importFromStream(inputStream, putFile, logger)` — best-effort, **not** atomic (a bad/traversing entry is skipped, not rolled back; `putFile` is idempotent so a re-run is safe). Enforces `STORAGE_IMPORT_MAX_BYTES` per entry and `STORAGE_IMPORT_MAX_ENTRIES` total, aborting the whole import (zip-bomb posture) rather than silently truncating.

**`orphan-sweep.ts`** — `sweepOrphanedFiles(options)`: one shared reconciliation pass used by both the status-media and chat-media archive sweeps. Enumerates a storage prefix via the uncapped `iterateFiles`, resolves which keys are still referenced by a row (chunked, caller-supplied `referencedAmong`), and deletes a file only after it has been observed unreferenced for at least `graceMs` (tracked in a caller-owned `firstSeenAt` map, so a process restart just restarts the grace clock rather than reaping prematurely).

##### 3.11 `src/common/throttler/`

Redis-backed storage for `@nestjs/throttler`, used when `REDIS_ENABLED=true` so rate limits aggregate across replicas instead of being per-process.

**`throttler-redis.client.ts`**
- `THROTTLER_REDIS_COMMAND_TIMEOUT_MS` (2000).
- `buildThrottlerRedisOptions(configService)` — tuned so the fail-open posture below engages immediately rather than after a stall: `enableOfflineQueue:false`, `autoResendUnfulfilledCommands:false`, a `commandTimeout`, `maxRetriesPerRequest:null`.
- `createThrottlerRedisClient(configService)` — dedicated client, separate from the cache/queue Redis clients.

**`redis-throttler.storage.ts`** — `RedisThrottlerStorage implements ThrottlerStorage, OnModuleDestroy`.
- `increment(key, ttl, limit, blockDuration, throttlerName)` — a single atomic Lua script (`INCR` + arm/repair the TTL + read it back) per hit; **fails open** (returns a not-blocked record) on any Redis error, since rate limiting is a secondary control and fail-closed would self-DoS the gateway.
- `onModuleDestroy()` — same bounded-`quit()`-then-`disconnect()` pattern as `CacheService`.

##### 3.12 `src/common/transformers/`

**`date.transformer.ts`** — `DateTransformer: ValueTransformer`. Cross-dialect date handling for the **data connection only**: SQLite stores ISO strings (TEXT), Postgres stores native timestamps. Must never be used on the always-SQLite main connection's entities (those hardcode `datetime`/`text` instead — see `column-types.ts`).

##### 3.13 `src/common/utils/`

Small, focused, independently-testable helpers used throughout the codebase.

- **`column-types.ts`** — `jsonColumnType()` (always `'simple-json'`, both dialects — a deliberate choice: the baseline migration created `text` columns even on Postgres, so a `jsonb`-typed entity would hand back raw unparsed strings) and `dateColumnType()` (`'timestamp'` on Postgres, `'text'` on SQLite). **Data connection only** — same caveat as `date.transformer.ts`.
- **`concurrency-limiter.ts`** — `ConcurrencyLimiter` class: a minimal async semaphore (`run(task)`), with an optional bounded wait queue (`maxQueued`) so a burst is rejected rather than parking unboundedly, and a `close()` that rejects every parked/future task for graceful shutdown.
- **`db-errors.ts`** — `isUniqueViolation(err)` and `isMissingTableError(err)`: cross-dialect (Postgres code + SQLite code/message) classification of TypeORM driver errors, robust to the error classes arriving from a different JS realm (so `instanceof` can't be relied on — classification is by `.name`/`.code` instead).
- **`inline-media.ts`** — `shedInlineMedia(data, maxBytes)`: replaces an over-cap base64 `media.data` blob in an outbound event payload with an `{ omitted: true, sizeBytes }` marker, shared by the webhook delivery path and the WebSocket gateway so both sinks agree on the same over-cap contract.
- **`ip.ts`** — `normalizeIp(ip)` (strips the `::ffff:` IPv4-mapped prefix), `resolveClientIp(req, trustedProxies)` (walks `X-Forwarded-For` right-to-left, honoring it only when the immediate peer is a configured trusted proxy — else returns the raw socket address), `ipMatches(ip, target)` (exact or IPv4 CIDR match).
- **`keyed-mutation-queue.ts`** — `KeyedMutationQueue` class: serializes async work per key (a keyed promise chain) so concurrent mutations of the same entity (e.g. a stored message's reactions) apply in arrival order; failure-isolated per key and self-reclaiming (drops a settled chain entry unless replaced).
- **`paginate.ts`** — `DEFAULT_LIST_LIMIT` (1000), `resolveListWindow(limit, offset)`, `paginate(items, limit, offset)`: bounds an in-memory list response so an engine-backed list endpoint (contacts/groups/chats) can't serialize an operator's entire unbounded address book into one JSON body.
- **`path-safety.ts`** — `isPathWithin(root, target)` (absolute-resolved containment check), `isSafeStorageKey(key)` (rejects traversal/absolute/control-char storage keys — the backend-agnostic containment boundary for `StorageService`), `isSafeSessionName(name)` (conservative alnum+hyphen charset — a session name becomes a filesystem path component).
- **`private-dir.util.ts`** — `ensurePrivateDir(dir)`: creates (or tightens) a directory to `0o700`, best-effort (never fails the caller — an engine library downstream creates/uses the dir regardless).
- **`secret-file.ts`** — `writeSecretFile(filePath, content)`: writes with `0600` permissions, chmod'ing both before and after the write (since `writeFileSync`'s `mode` only applies on file *creation*) so a secret is never briefly world-readable during an overwrite.
- **`strict-boolean.ts`** — `coerceStrictBoolean`/`ToStrictBoolean()` and `coerceStrictNumber`/`ToStrictNumber()`: `class-transformer` `@Transform` helpers that counteract the global `ValidationPipe`'s `enableImplicitConversion`, which otherwise silently coerces `'false'`/`'0'`/`'no'` to boolean `true`, or a blank string to numeric `0`. Only an unambiguous spelling is accepted; anything else is left untouched so `@IsBoolean()`/`@IsInt()` can reject it.
- **`template-render.ts`** — `renderTemplate(body, vars)`: the single server-side text-template renderer, substituting `{{name}}` (canonical) and legacy `{name}` (deprecated, bulk-message backward compat) placeholders; an unknown key is left literal rather than blanked.
- **`workflow-lines.ts`** — `executableLines(run)`: strips shell comments from a CI workflow `run:` block (quote-aware, so a `#` inside quotes is preserved), used only by CI-gate specs to avoid matching a script mentioned in a comment.

---

#### 4. `src/database/**`

TypeORM wiring outside the runtime `app.module.ts` factories: the standalone CLI data-sources used by `migration:generate`/`migration:run`, the Postgres boot-migration advisory-lock mechanism, SQLite file-permission hardening, and the migration files themselves.

##### `src/database/data-source.ts`
Standalone TypeORM CLI `DataSource` for the **data** connection (session/webhook/message/template/engine/integration/status-store/automation). Loads env with the same precedence as the running app (`loadCliEnv()`) so the CLI targets whatever the dashboard configured, re-applies the SQLite main/data collision guard (the CLI never runs `ConfigModule.validate()`), and exports exactly one `DataSource` instance (required by the TypeORM CLI's `loadDataSource()`), selected by `DATABASE_TYPE`.
- `buildPostgresDataSourceOptions(env?)` — exported as a pure builder (unit-testable without mutating `process.env`); sets a non-`public` `POSTGRES_SCHEMA` both as TypeORM's `schema` option and via the pg startup `options` string (`search_path`), since `schema` alone doesn't affect raw unqualified DDL in the hand-written migrations.
- `postgresDataSourceOptions` — the module-eval-time instance built from live env.

##### `src/database/data-source-main.ts`
Standalone TypeORM CLI `DataSource` for the **main** (auth/audit) connection — SQLite only (mirrors the runtime main connection's SQLite branch exactly: `./data/main.sqlite` by default, `migrations-main/`). Needed so `migration:run:main` can manage that connection's schema when `MAIN_DATABASE_SYNCHRONIZE=false`. Throws immediately if `MAIN_DATABASE_TYPE=mysql` — a MySQL main connection always synchronizes at app boot and has no CLI-managed migration.

##### `src/database/load-cli-env.ts`
`loadCliEnv(cwd?)` — loads `.env` then `data/.env.generated` with the same `override:false` precedence `load-env.ts` uses for the running app, plus `clearBlankEnv`. Without this, the migration CLI would silently target the default SQLite DB even when the dashboard had configured Postgres.

##### `src/database/pg-boot-migrations.ts`
`createBootDataSource(options, deps?)` — the `dataSourceFactory` for the runtime `data` TypeORM connection (see `app.module.ts`). For a Postgres connection, runs the migration chain **under a Postgres session-scoped advisory lock** (`pg_advisory_lock`, fixed two-int4 key `['OWA','boot']`) obtained through a separate `pg.Client`, so multiple replicas booting simultaneously serialize instead of racing DDL against one migrations ledger — the lock holder applies the chain, every other process waits, then sees a filled ledger and applies nothing. The lock client disables `statement_timeout` for its session (advisory-lock waits would otherwise be killed by it). Non-Postgres options pass through unchanged to `@nestjs/typeorm`'s default construct-then-initialize path.

##### `src/database/sqlite-file-permissions.ts`
- `tightenSqliteFilePermissions(paths, warn)` — chmods each DB file (plus its `-wal`/`-shm`/`-journal` sidecars) to `0600`; best-effort, logs and skips on failure, never fails boot.
- `SqlitePermissionsBoot implements OnApplicationBootstrap` — provider registered in `app.module.ts`; runs the tightening once every DataSource has initialized (better-sqlite3 creates files at `0666 & umask`, group/world-readable, which matters because these files hold webhook/plugin HMAC secrets and session proxy URLs in plaintext).

##### Migrations (`src/database/migrations/`, `src/database/migrations-main/`)

**Pattern.** Every migration file is a standard TypeORM `MigrationInterface` class, named `<ClassName><UnixTimestampMs>.ts` (e.g. `AddWebhookDeliveryFailureLookupIndex1786300000000.ts`), with a `name` field matching the class name + timestamp and `up(queryRunner)`/`down(queryRunner)` methods. Most are hand-authored raw SQL (not generated) because `synchronize` is off in production, use `IF NOT EXISTS`/`IF EXISTS` for idempotency across both dialects, branch on `queryRunner.dataSource.options.type === 'postgres'` where SQLite and Postgres need different DDL (e.g. lifting `statement_timeout` for an index build), and carry a substantial doc-comment explaining the operational reason for the change (performance, a bug being fixed, a new feature's schema). `migrations/` (≈31 files) covers the **data** connection (sessions, messages, webhooks, templates, integration fabric, automation, status store, etc.); `migrations-main/` has a single migration, `CreateAuthAuditTables`, covering the **main** (auth/audit) connection.

**`__tests__/` (both directories).** `migrations/__tests__/migration-drift.spec.ts` is a drift gate: it builds the full migration chain against an in-memory SQLite `DataSource`, asks TypeORM's schema builder what it would still change to match the entity metadata (a dry run — `log()`, nothing executed), and compares that against a pinned snapshot fixture (`__fixtures__/known-migration-drift.json`) of the drift the chain carries *today*. This exists because `migration:generate` diffs entities against a synchronize-built schema, and if the migration chain's resulting schema silently drifts from what `synchronize` would produce, `generate` starts emitting spurious multi-table rebuilds instead of real deltas — this spec is what would catch that drift before it becomes invisible noise. `migrations-main/__tests__/` mirrors the same harness for the main connection. Several other `src/database/*.spec.ts` files (`add-integration-fabric.spec.ts`, `add-uuid-defaults-migration.spec.ts`, `add-webhooks-sessionid-index.spec.ts`, `session-ownership-migrations.spec.ts`, `docs-schema-accuracy.spec.ts`, etc.) are per-migration or per-doc correctness specs, not documented individually per the summarization instruction for this directory.

---

#### 5. `src/core/**`

The extensibility runtime: the agent-invocable tool registry (consumed by the MCP server and AI-agent integrations), the plugin hook/event bus, and the full plugin platform (manifest validation, lifecycle, capability surface, and the worker-thread sandbox for untrusted third-party plugins). This is the layer that lets both first-party code and operator-installed plugins react to and act on WhatsApp events without being wired directly into the feature modules.

##### 5.1 `src/core/agent-tools/`

A protocol-neutral registry of agent-invocable "tools" — each one a typed, permission-checked, session-scoped wrapper around an existing feature service method. Consumed by the MCP server (`modules/mcp`) to expose the gateway as an MCP tool surface for AI agents.

**`agent-tools.module.ts`** — `@Global()` module. Builds `ToolRegistryService` via a factory that injects the seven feature services (`SessionService`, `MessageService`, `ContactService`, `GroupService`, `WebhookService`, `LabelService`, `AutomationRulesService`) and calls `allAgentTools(deps)` to assemble the full tool list.

**`tool-descriptor.ts`**
- `ToolDescriptor<I>` interface — `name`, `description`, `inputSchema` (Zod), `tier: 'read'|'write'`, `destructive?`, `idempotent?`, `requiredRole?`, `sessionScoped?`, `resultDisposition?`, `handler(input, apiKey)`.
- `AnyToolDescriptor` — the type-erased form used to store heterogeneous tools in one list (handler parameter typed `never`, sound because the invoker always parses the matching `inputSchema` first).
- `defineTool(descriptor)` — ties a handler to its own schema's inferred input type at the definition site (compile-time check that the handler only reads fields the schema declares).

**`tool-invoker.ts`** — `invokeTool(tool, rawInput, rawKey, authService, onAuthenticated?, onAuthFailure?)`: runs one tool call with REST-equivalent guarantees — auth (role + `allowedSessions` + IP, fail-closed) → Zod-validate input → handler, mirroring the REST guard-then-pipe order. For a `sessionScoped` tool, pre-extracts `sessionId` from the raw input *before* full validation (so the per-key session fence applies even before the schema parse) and rejects with 400 if absent.

**`tool-registry.service.ts`** — `ToolRegistryService`. In-memory `Map<name, AnyToolDescriptor>` built from the constructor-injected tool list; throws on a duplicate name at construction. `list({ readOnly? })`, `get(name)`.

**`tools/index.ts`** — `allAgentTools(deps)`: composes every tool family (`session`, `message`, `contact`, `group`, `webhook`, `label`, `automation`) into one flat list — the single assembly point so a new family can't be added to the module while remaining invisible to the specs that police the published tool-name list and the session-scope invariant.

**`tools/*.tools.ts`** — one function per feature family, each returning `AnyToolDescriptor[]` built with `defineTool`. All session-scoped tools share a `sessionId: z.string().min(1)` schema fragment. Summary of tools per file:

- **`session.tools.ts`**: `SessionFindAll`, `SessionFindOne`, `SessionGetChats`, `SessionGetStats` (read); `SessionSubscribePresence`, `SessionGetPresence`, `SessionMarkChatRead`, `SessionMarkChatUnread`, `SessionSendChatState` (mix of read/write, several OPERATOR-gated).
- **`message.tools.ts`**: `MessageList`, `MessageHistory`, `MessageGetReactions` (read); `MessageSendText`, `MessageSendImage`, `MessageSendVideo`, `MessageSendAudio`, `MessageSendDocument`, `MessageSendLocation`, `MessageSendContact`, `MessageSendSticker`, `MessageSendTemplate`, `MessageReply`, `MessageForward`, `MessageReact` (all write, OPERATOR role). Shares validated schema fragments (`quotedMessageIdSchema`, `mentionsSchema`, `customLinkPreviewSchema`) mirrored from the corresponding REST DTOs' caps, since a tool handler bypasses the REST `ValidationPipe` entirely.
- **`contact.tools.ts`**: `ContactFindAll`, `ContactFindOne`, `ContactCheckNumber`, `ContactResolvePhone`, `ContactGetProfilePicture` (read); `ContactBlock`, `ContactUnblock` (write, OPERATOR).
- **`group.tools.ts`**: `GroupFindAll`, `GroupFindOne`, `GroupGetInviteCode` (read); `GroupCreate`, `GroupAddParticipants`, `GroupSetSubject`, `GroupSetDescription` (write, OPERATOR). `GroupAddParticipants`'s handler derives `success` from the per-participant outcomes rather than asserting it, since a batch can partially fail.
- **`webhook.tools.ts`**: `WebhooksList`, `WebhookFindBySession`, `WebhookFindOne` (all read, OPERATOR role).
- **`label.tools.ts`**: `LabelFindAll`, `LabelFindOne`, `LabelListChats`, `LabelListForChat` (read); `LabelUpsert`, `LabelDelete`, `LabelAddToChat`, `LabelRemoveFromChat` (write, OPERATOR). Descriptions explicitly call out the whatsapp-web.js/Baileys read/write split (labels are a WhatsApp Business feature where the two engines implement complementary halves).
- **`automation.tools.ts`**: `AutomationRuleFindAll`, `AutomationRuleFindOne` (read, OPERATOR).

##### 5.2 `src/core/hooks/`

The in-process event bus every feature (and, via the sandbox bridge, every plugin) publishes lifecycle events through.

**`hooks.module.ts`** — `@Global()` module; provides/exports `HookManager`.

**`hook.interfaces.ts`**
- `HookEvent` — the full union of event names (`session:*`, `message:*`, `webhook:*`, `ingress:error`).
- `KNOWN_HOOK_EVENTS` / `isKnownHookEvent(event)` — a runtime allowlist mirroring the type, exhaustively checked by the `Record<HookEvent, true>` registry object; used to reject fabricated event names arriving across the untrusted sandbox-worker IPC boundary.
- `HookContext<T>`, `HookResult<T>` (`continue`/`data`/`error`), `HookHandler<T>`, `HookRegistration`.

**`hook-manager.service.ts`** — `HookManager`.
- `register(pluginId, event, handler, priority?)` — registers, keeping the per-event list sorted by priority; returns a generated id.
- `unregister(hookId)` / `unregisterPlugin(pluginId)`.
- `execute(event, data, options)` — runs the handler chain for an event, with an `AsyncLocalStorage`-based re-entrancy guard (a handler that re-fires the *same* event synchronously is short-circuited with a warning rather than recursing infinitely).
- `runInFlight(events, fn)` / `isInFlight(event)` — lets a caller (notably the sandbox bridge, whose worker IPC round-trip loses the async context) explicitly re-establish or query the in-flight set across a boundary `AsyncLocalStorage` can't naturally span.
- `hasHooks(event)`, `getHookCount(event)`, `getRegisteredHooks()`, `getPluginEvents(pluginId)` — introspection, used by the dashboard/debugging.

**`sending-gate.ts`** — `applySendingGate(hookManager, sessionId, type, input, source)`: runs the pre-send `message:sending` hook for one outbound send and returns the (possibly plugin-modified) input, or throws `BadRequestException` if a plugin vetoed it (`continue:false`) or returned a malformed reply (fails **closed** — a moderation chokepoint whose reply can't be read must not fall back to sending the original, unmoderated content). Shared by `MessageService` (every sender + edit) and `StatusService`; `BulkMessageService` keeps its own inlined copy because it needs to distinguish a plugin block from a delivery failure for its per-item hook semantics.

**`index.ts`** — barrel: interfaces + `HookManager` + `HooksModule` + `sending-gate`.

##### 5.3 `src/core/plugins/`

The plugin platform: manifest validation, a two-tier runtime (trusted built-ins run in-process; untrusted installed plugins run in a `worker_threads` sandbox), the capability surface (`ctx.*`) every plugin sees, and Integration-Fabric SDK types (ingress webhook routes, normalized outbound send).

**`plugins.module.ts`** — `@Global()` module. Provides `PluginStorageService`, `PluginLoaderService`, `ConversationMappingService` (lives here rather than in its own module), and aliases `PLUGIN_CONVERSATION_MAPPING_PORT` to `ConversationMappingService` via `useExisting` (an alias, not a factory, so Nest doesn't double-dispatch its lifecycle hooks). Exports `PluginLoaderService`, `PluginStorageService`.

**`plugin.interfaces.ts`** — the central type/contract file for the whole plugin system.
- `PluginType`, `PluginStatus` enums.
- `PluginManifest` — the full `manifest.json` shape: id/name/version/type/main, `configSchema` (declarative config-UI generation), optional `configUi` (sandboxed iframe config editor), `hooks`, `permissions` (capability grants), `sessions`/`sessionScoped` (static session-scope fence), `net` (outbound host allowlist), `i18n`, `sdkVersion`, `ingress` (inbound webhook routes).
- `PluginConfigField`/`PluginConfigSchema` — recursive declarative config schema (string/number/boolean/array/object/textarea, with `secret` masking).
- `PluginCapabilityPermission` — the fixed set of grantable capability strings (`messages:send`, `engine:read`, `net:fetch`, `storage:use`, `webhook:ingress`, `conversation:send`, `search:provide`).
- `IngressSignatureSpec`, `IngressChallengeSpec`, `IngressPreflightCheck`, `IngressResponseContract`, `PluginIngressRoute` — the Integration Fabric SDK's inbound webhook contract (HMAC/shared-secret/Standard-Webhooks/none signature schemes, host-computed synchronous ack).
- `ConversationSendEnvelope` — the normalized outbound-send shape for `ctx.conversations.send`.
- `SUPPORTED_SDK_MAJOR` (1).
- `validateIngressManifest(manifest, allowUnsignedIngress?)` — SDK-major check, `webhook:ingress` permission check, route-uniqueness check, `toleranceSec > 0` check, ack-header RFC-7230/CRLF validation, and **refuses** (throws) a `scheme:'none'` route unless the operator opted in via `ALLOW_UNSIGNED_INGRESS=true`.
- `warnUnauthenticatedIngressRoutes(manifest, logger)` / `warnUnsignedTimestampRoutes(manifest, logger)` — loud boot/load-time warnings for security-relevant-but-allowed configurations (an unauthenticated route that was explicitly opted into; an HMAC route whose timestamp isn't actually bound into the signed content, enabling replay).
- `PluginCapabilityError` — thrown by any capability verb on a denied/out-of-scope call.
- `PluginMessagingCapability`, `PluginEngineReadCapability`, `PluginNetCapability`, `PluginConversationsCapability`, `PluginHandoverCapability`, `PluginMappingsCapability` — the `ctx.*` capability interfaces.
- `PluginContext` — the full object handed to a plugin's lifecycle methods (`pluginId`, `manifest`, `config` getter, `hookManager`, `logger`, `storage`, `registerHook`, `registerWebhook`, and the six capability objects above).
- `PluginLogger`, `PluginStorage`, `IPlugin` (lifecycle hooks: `onLoad`/`onEnable`/`onDisable`/`onUnload`/`onConfigChange`/`healthCheck`), `IEnginePlugin` (extends `IPlugin` for engine plugins).
- `PluginInstance` (runtime record) / `PluginRegistryEntry` (persisted record) — note `enabledByOperator` on the registry entry, which is what lets the operator's standing enable decision survive a restart (`status` alone can't, since it's reset to `INSTALLED` on every load).

**`plugin-manifest.ts`**
- `RESERVED_PLUGIN_IDS`, `INSTALLABLE_TYPES` (only `extension` is user-installable; engines etc. are built-in-only).
- `validatePluginManifest(manifest)` — shared by both install-time and boot-time loading: plain-object shape, required string fields, id format + reservation, installable type, and `main` path containment (`assertMainContained`, lexical forward-slash check).

**`plugin-paths.ts`**
- `resolvePluginMainPath(pluginsDir, pluginId, main)` — resolves+asserts a manifest `main` entry stays inside `<pluginsDir>/<pluginId>` (rejects `../` escapes and absolute paths) before any `require()`.
- `resolvePluginEntryPath(packageDir, entry)` — same guard anchored to an already-loaded plugin's own package dir (which may be the legacy directory).
- `pluginUpdateStagingDirName(pluginId)` / `pluginUpdateBackupDirName(pluginId)` — the `.{id}.new` / `.{id}.bak` sibling-directory naming convention for in-place plugin updates.

**`plugin-package-scanner.ts`** — `PluginPackageScanner`. The boot-scan collaborator (constructed by `PluginLoaderService`, sharing its registry `Map` by reference).
- `scanAtBoot()` — loads built-ins (a registration point, currently a no-op stub for future engine registration), then every package under the configured plugins dir, then (if `PLUGINS_DIR` is unset) the legacy pre-v0.8 default dir as a compatibility fallback; logs a warning for any registry entry whose code wasn't found on disk (drift between "installed" and "loaded").
- `loadPlugin(pluginPath)` — reads+validates `manifest.json`, re-anchors `main` against the real on-disk dir, validates ingress declarations, seeds `configSchema`-declared defaults under any persisted config, and registers the `PluginInstance`.
- `recoverInterruptedUpdates(dir)` — crash recovery for an in-place update interrupted mid-swap (restores `.{id}.bak` as live, or drops `.{id}.new` staging).
- `ensureRegistryEntry(manifest, builtIn)` — idempotently creates/reconciles the persisted registry entry for a freshly-loaded plugin, adopting `enabledByOperator` from a lingering pre-#856 `ENABLED` status when the field itself is absent.

**`plugin-lifecycle.ts`** — `PluginLifecycle`. The runtime enable/disable/unload/config-write collaborator.
- `enablePlugin(pluginId)` — routes to `sandboxBridge.enableSandboxed` for `builtIn:false` plugins, or `enableInProcess` (require()s the manifest's `main`, runs `onLoad`/`onEnable`) for built-ins; refuses enabling a non-active `ENGINE`-type plugin; guards against concurrent double-enable with a synchronous `Set` lock; unregisters any hooks the plugin registered before a failed enable (so a half-initialized plugin can't double-dispatch on a later successful enable).
- `disablePlugin(pluginId, opts?)` — tears down via the sandbox bridge or in-process `onDisable`; `opts.unload` additionally fires `onUnload` for a sandboxed plugin (the only point it's reachable, since the worker is about to be terminated).
- `unloadPlugin(pluginId)` — disables first if enabled, then calls `onUnload` (in-process case) and removes the registry map entry.
- `updatePluginConfig`, `setPluginSessions`, `setPluginSessionConfig` — persist + live-notify the running plugin (routes through the sandbox host or the in-process `onConfigChange`).
- `registerBuiltInPlugin(manifest, instance, config?)` — programmatic registration point for built-in engines; merges env-derived defaults with any persisted operator override each boot.

**`plugin-uninstaller.ts`** — `PluginUninstaller`. `uninstallPlugin(pluginId)`: refuses built-ins; reads the package dir from the live runtime record *before* unloading (since unload drops that record); unloads, drops the registry entry, `rmSync`s the package directory (traversal-guarded), and deletes the plugin's `ctx.storage` data directory (relevant on a split-directory deployment where `PLUGINS_DIR` is outside the data dir).

**`plugin-storage.service.ts`** — `PluginStorageService` (`@Injectable`). Owns both the plugin **registry** (`<dataDir>/plugins/registry.json`, atomic-write via temp-file+rename, `0600`) and each plugin's **key/value storage** (`<dataDir>/plugins/<id>/key-<base64url>.json`, same atomic-write + `0600` pattern, with legacy pre-encoding filename fallback for reads/deletes).
- Registry methods: `getPluginEntry`/`setPluginEntry`/`deletePluginEntry`/`getAllEntries`, `getPluginStatus`/`setPluginStatus`, `setPluginEnabledByOperator`, `getPluginConfig`/`setPluginConfig`, `getPluginSessions`/`setPluginSessions`, `getPluginSessionConfig`/`setPluginSessionConfig`.
- `deletePluginData(pluginId)` — traversal-guarded `rmSync` of a plugin's whole storage dir.
- `createPluginStorage(pluginId)` — returns the `PluginStorage` (`get`/`set`/`delete`/`list`) handed to `ctx.storage`, enforcing a per-plugin byte quota (`assertStorageQuota`, default 50MB, `PLUGIN_STORAGE_MAX_BYTES`-overridable) on writes.

**`plugin-activation.ts`**
- `isPluginActiveForSession(sessionScoped, activeSessions, sessionId)` — the per-session activation gate (a global plugin or a non-session-attributed event is never gated).
- `resolveInstanceConfig(resolved, instanceConfig)` — deep-merges one Integration Fabric instance's own config over whatever layer resolution produced (applied last, so it wins for the keys it defines).
- `resolvePluginConfig(base, sessionConfig, sessionId, sessionScoped)` — deep-merges a per-session override over the `'*'` base config.

**`plugin-capability-context.ts`** — `PluginCapabilityContext`. **The security-review surface**: builds the `ctx.*` object every plugin (in-process or sandboxed, via the capability router) actually touches, and owns every gate in front of it (manifest-declared permission, static manifest session-scope, dynamic operator session-activation, live-engine resolution). Key private gates: `assertPermission`, `assertSessionAllowed`, `assertSessionActive` (both of the above, used as the capability boundary — a plugin supplies its own `sessionId`, so this *is* the security boundary, not a convenience), `resolveEngine`/`resolveEngineRead`, `isSessionGone` (definitive not-found probe used by the conversation-mapping repair paths below).
- `createPluginContext(plugin)` — assembles the full `PluginContext`, including a `config` getter that resolves the per-session slice for the currently-firing hook (tracked via its own `AsyncLocalStorage`), and a `registerHook` wrapper that re-applies the per-session activation gate and scopes the firing session for the handler.
- `buildMessagesCapability`, `buildEngineReadCapability`, `buildStorageCapability`, `buildNetCapability`, `buildConversationsCapability`, `buildHandoverCapability`, `buildMappingsCapability` — each builds one capability object, gating every verb. Notably: `buildNetCapability`'s effective host allowlist is the union of the manifest's `net.allow` with every enabled instance/session config's `net.allowConfigHosts`-resolved host (since a worker-initiated call has no per-session firing context); `buildConversationsCapability`/mappings include self-healing logic for a conversation mapping whose session was deleted and recreated under a new id (`isSessionGone` + `rebindSession`), so an adapter isn't permanently bricked by a re-pair.

**`conversation-send-facade.ts`** — `buildConversationSendFacade(deps)`: the engine-neutral `send()` implementation behind `ctx.conversations.send`. Normalizes a `ConversationSendEnvelope` into the right concrete send (location pin, media-by-URL, quoted reply, or plain text), resolving `chatId` from a provider conversation mapping when omitted, and running the actual send inside `runGuarded` (re-establishes the in-flight hook-guard context so a send triggered from within the adapter's own inbound handling can't echo-loop back into itself via its own `message:sending` hook).
- `dispatchConversationMedia` (in `plugin-capability-context.ts`) — the exhaustive switch mapping a `ConversationMediaType` (`image`/`video`/`audio`/`voice`/`file`) to the concrete `MessageService` media-send method.

**`handover-gate.ts`** — `shouldDispatchToPlugin(handover, callerPluginId)`: once a human has taken over (or closed) a conversation, every plugin *except* the one that owns the handover row is silenced from `message:received` for that chat — scoped by session+chat, not by plugin, so one plugin's handover governs every other plugin on that chat.

**`plugin-net.ts`** — SSRF-guarded outbound HTTP for `ctx.net.fetch`.
- `effectiveNetAllow(allow, allowConfigHosts, config)` — merges the manifest's static `net.allow` with the host of each `net.allowConfigHosts`-named config key that resolves to a credential-free `https:` URL.
- `isNetHostAllowed(allow, url)` — deny-by-default host:port match (`'*'` wildcard supported; the SSRF guard still blocks internal IPs regardless of allowlisting).
- `performPluginFetch(url, init?, deps?)` — runs the request through `withSafeFetch`, bounded by a clamped per-call timeout (default 15s, hard cap 30s) and a streamed response-size cap (10MB), with a global cross-plugin in-flight concurrency cap (`MAX_INFLIGHT_FETCHES = 16`) so host-side response buffering across all plugins stays bounded.

**`plugin-host-ports.ts`** — defines a small, explicit "port" interface per host feature service a plugin capability can reach (`PluginMessagePort`, `PluginSessionPort`, `PluginConversationMappingPort`, `PluginInstancePort`, `PluginSearchRegistryPort`) plus their DI token symbols. Deliberately narrow (reviewer reads exactly what the plugin runtime can reach) and type-only on the host-service side, so `core/plugins` imports no feature-module value directly — each owning module binds its service to the port token with a `useExisting` alias.

**`plugin-host-services.ts`** — `PluginHostServices`. Resolves the above port tokens via `ModuleRef.get(..., { strict: false })` **at call time**, not via constructor injection — load-bearing, because constructor injection would close a real provider cycle (`PluginLoaderService → SessionService → SessionEngineLifecycle → EngineFactory → PluginLoaderService`). `getSearchRegistryPort()` returns `undefined` (not a throw) when the search module isn't loaded.

**`plugin-sandbox-bridge.ts`** — `PluginSandboxBridge`. The IPC half of the plugin runtime: everything that speaks to an untrusted plugin's `worker_thread`.
- `enableSandboxed(pluginId, plugin)` / `teardownSandboxed(pluginId, host, opts?)` — spawn the worker host (via a closure over the loader's `createSandboxHost`), run `load`→`onLoad`→`onEnable` (or `onDisable`[→`onUnload` on unload]) each bounded by `SANDBOX_LIFECYCLE_TIMEOUT_MS` (30s), and on enable failure clean up (drop any search-provider registration, terminate the worker).
- `checkPluginHealth(pluginId)` — routes to the live worker's bounded `healthCheck` (5s) when sandboxed, else the in-process instance's; annotates the result with the plugin's last recorded hook error (operator context, not a verdict override).
- `dispatchWebhookForInstance(d)` — the Integration Fabric ingress dispatch entry point (called by `IngressProcessor`): resolves the three-layer config precedence (base → per-session operator override → this instance's own config, with the instance's own keys winning only when the per-session slice can actually be *attributed* to this one instance — see `scopeHasAtMostOneInstance`) and dispatches into the worker, bounded by `INGRESS_DISPATCH_TIMEOUT_MS`.
- `buildHookSubscribeHandler`, `buildLogRelay`, `buildSearchProviderRegistrar`, `buildWorkerExitHandler` — the hardened shims that translate worker-initiated IPC declarations into host-side registrations, each guarding the untrusted wire input (unknown-event rejection, dedup, size caps, rate-limited error/log relaying) since a hostile or buggy worker can post arbitrary fabricated event/route names.

**`search-provider-registration.util.ts`**
- `registerPluginSearchProvider(deps)` — pure policy for a worker's `ctx.registerSearchProvider` declaration: denies (and warns) without the `search:provide` permission; no-ops if search is disabled or the operator pinned `builtin-fts`; registers-and-activates under `SEARCH_PROVIDER=auto` (superseding the built-in FTS provider).
- `unregisterPluginSearchProvider(registry, pluginId)` — drop on disable/uninstall/crash so queries stop routing to a dead worker.

**`webhook-subscribe.util.ts`** — `makeOnWebhookSubscribe(deps)`: the ingress-route mirror of the hook-subscribe hardening — drops a subscription without `webhook:ingress` permission, drops (and warns once) an undeclared route, dedups, and caps at the manifest's declared route count.

**`config-defaults.util.ts`** — `seedConfigDefaults(schema, config)`: fills `configSchema`-declared `default` values into a persisted config for any key that's `undefined` (never overwrites an explicit value, including explicit `null`), deep-cloning object/array defaults so the seeded runtime config and the persisted entry never share a mutable reference. Runs at every load, not just install, so a plugin's defaulted fields are never missing from its lifecycle input.

**`plugin-loader.service.ts`** — `PluginLoaderService implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy` (`@Injectable`). **The public facade** of the whole plugin runtime — every external consumer (REST surface, installer, engine factory, ingress pipeline) calls this class; internally it constructs and delegates to the five collaborators documented above (`PluginPackageScanner`, `PluginLifecycle`, `PluginUninstaller`, `PluginCapabilityContext`, `PluginSandboxBridge`), sharing its `plugins`/`sandboxHosts`/`lastSandboxHookError` `Map`s with them **by reference**.
- `onModuleInit()` — `scanner.scanAtBoot()`.
- `onApplicationBootstrap()` — re-enables every plugin the operator had previously enabled (`enabledByOperator === true`), sequentially and best-effort, after the rest of the app is wired (#856 fix: without this, every restart silently turned off every extension).
- `onModuleDestroy()` — best-effort, sequential `disablePlugin` for every currently-enabled plugin on graceful shutdown (so `onDisable` gets a chance to flush state — previously only the REST disable/uninstall paths ran it).
- `setOperatorEnabled`, `getRegistryEntry`, `loadPlugin`, `enablePlugin`, `disablePlugin`, `unloadPlugin`, `getPluginsDir`, `getPluginPackageDir`, `isBuiltIn`, `uninstallPlugin`, `updatePluginConfig`, `setPluginSessions`, `setPluginSessionConfig`, `checkPluginHealth`, `dispatchWebhookForInstance`, `getPlugin`, `getAllPlugins`, `getPluginsByType`, `getEnabledPlugins`, `isPluginEnabled`, `registerBuiltInPlugin` — mostly thin delegations to the collaborators, forming the stable public API.
- `createSandboxHost(...)` (`protected`) — builds a `PluginWorkerHost` wired to a real `WorkerThreadChannel` loading the compiled `sandbox/worker-bootstrap.js`, with a capped worker heap (`SANDBOX_MAX_OLD_GEN_MB = 256`), a capped concurrent-capability-call budget (`SANDBOX_MAX_INFLIGHT_CAPS = 32`), a per-call host-side timeout (`plugins.capTimeoutMs`, default 30s), and a minimal allowlisted env (`buildSandboxWorkerEnv` — only `NODE_ENV`/`NODE_EXTRA_CA_CERTS`/`TZ`, never host secrets). Overridable (hence `protected`) so tests can inject a fake worker host.
- Also re-exports `resolvePluginMainPath`/`resolvePluginEntryPath`/`pluginUpdateStagingDirName`/`pluginUpdateBackupDirName` from `plugin-paths.ts` for backward-compatible import paths.

**`index.ts`** — barrel: `plugin.interfaces` + `plugin-manifest` + `plugin-loader.service` + `plugin-storage.service` + `plugins.module`.

##### 5.4 `src/core/plugins/sandbox/`

The `worker_threads` IPC layer that runs an untrusted (installed, non-built-in) plugin in isolation. **Explicitly documented as crash/heap-OOM containment, not a security boundary** — a worker thread shares the host process's filesystem/network/credentials, so plugin code could `require('fs'|'net'|'child_process')` directly; only the `ctx.*` capability verbs are permission-gated.

**`protocol.ts`** — the wire protocol shared by both sides.
- `HostToWorkerMessage` union — `load`, `lifecycle`, `cap-result` (ok/error), `hook`, `config-change`, `health-check`, `webhook`, `search`.
- `WorkerToHostMessage` union — `ready`, `lifecycle-result`, `cap` (worker-initiated capability call), `hook-subscribe`, `hook-result`, `log`, `health-result`, `webhook-subscribe`, `webhook-result`, `search-provider-register`, `search-result`, `error`.
- `PluginWorkerChannel` interface — the transport abstraction (`postMessage`/`onMessage`/`onExit`/`terminate`) that lets the host-side protocol logic be unit-tested without a real OS thread.
- `SandboxStaticContext`, `PluginLogLevel`, `PluginLifecycleMethod`.

**`plugin-worker-host.ts`** — `PluginWorkerHost`. Host-side driver for one worker: owns request/response correlation (`Map<id, pending>` per message kind: lifecycle, hook, webhook, health, search) over a `PluginWorkerChannel`, and fails every outstanding call when the worker dies.
- `dispatchHook(options)` — bounded, **fails open** (`{continue:true}`) on timeout so a wedged/malicious plugin can never stall the host's hook chain; tracks in-flight events per worker (`inFlightHookEvents`) so a worker-initiated capability call issued from inside a hook handler can be re-entrancy-guarded even though the IPC round-trip breaks `AsyncLocalStorage`'s natural span.
- `dispatchWebhook(options)` — same shape, fails open to a `504`/`ok:false` (the provider was already fast-acked in async ingress mode, so the timeout is invisible to them).
- `dispatchSearch(options)` — same shape for `/search` queries routed to a plugin search provider.
- `load(mainPath, context?, timeoutMs?)`, `runLifecycle(method, timeoutMs?)`, `sendConfigChange(config)`, `healthCheck(timeoutMs)`, `terminate()`.
- `handleCapRequest(message)` — services a worker-initiated `cap` message: rejects immediately if `maxInFlightCaps` is already saturated or no dispatcher is wired; otherwise runs the call (optionally re-wrapped in the host's in-flight hook guard) bounded by `withCapTimeout`.
- `withCapTimeout(verb, work)` — bounds one capability call; **does not cancel** the underlying host-side work on timeout (host verbs carry no cancellation token) — a late settle is only WARN-logged and discarded, never double-replied. Send-type verbs (`messages.sendText`/`reply`, `conversation.send`) get 4× the base budget (`SEND_CAP_TIMEOUT_FACTOR`), since a timeout there doesn't stop the send and a too-tight timeout would make a plugin retry into a duplicate message.
- `handleExit(code)` — drains every pending map on worker death, resolving each to its fail-open default, and calls `onExit(code, this.terminated)` so the bridge can distinguish a deliberate kill from a crash.

**`capability-router.ts`** — `dispatchCapabilityVerb(context, verb, args)`: the **sole** allowlisted mapping from an untrusted wire `verb` string to a method call on the live `CapabilityContext` — a worker cannot invoke an arbitrary method, only one of the ~16 cases in this switch. Validates positional args shape (non-empty strings, `{sessionId,chatId,instanceId}` mapping-key shape) before dispatch, so a malformed RPC fails the calling plugin cleanly instead of reaching the ORM with `undefined` criteria. Permission/session-scope checks are **not** here — they live inside the context's own verbs, so a sandboxed call is gated identically to an in-process one.

**`worker-bootstrap.ts`** — the actual `worker_thread` entry file (compiled to `sandbox/worker-bootstrap.js`, loaded by `PluginLoaderService.createSandboxHost`). Wires `WorkerCapabilityClient`, `WorkerHookRegistry`, `WebhookRegistry`, `WorkerSearchRegistry`, a `ctx.logger` proxy that forwards to the host, and on `load`, `require()`s the plugin's `main` file, constructs it, and builds the full `ctx` object (capability proxies via `buildSandboxContext`, a per-hook-scoped `config` getter via `hookConfigStore`, `registerHook`/`registerWebhook`/`registerSearchProvider`). Dispatches `lifecycle`/`config-change`/`health-check` messages to the plugin instance.

**`worker-capability.ts`**
- `WorkerCapabilityClient` — worker-side mirror of the host's call correlation: `call(verb, args)` posts a `cap` request and resolves on the matching `cap-result`.
- `buildSandboxContext(client)` — builds the `SandboxCapabilityContext` (every `messages`/`engine`/`storage`/`net`/`conversations`/`handover`/`mappings` method proxies through `client.call`), the capability surface a sandboxed plugin's `ctx` is actually built from.

**`worker-hooks.ts`**
- `hookConfigStore: AsyncLocalStorage<{config}>` — carries the per-session-resolved config for the duration of one hook dispatch so `ctx.config` (a getter in `worker-bootstrap.ts`) resolves correctly even under interleaved concurrent dispatches for different sessions.
- `WorkerHookRegistry` — `register(event, handler, priority?)` (subscribes the host to the event on first registration for it), `handleHook(message)` → `dispatch`: runs all handlers for the event in priority order inside the config scope, threading `data`, stopping on `continue:false`, and swallowing a handler error (reporting only the *first* one back to the host via `hook-result.error` — the chain itself still proceeds, mirroring the host `HookManager`'s own fail-open posture).

**`worker-search-registry.ts`** — `WorkerSearchRegistry`. `register(handler)` — a plugin provides exactly **one** search handler; posts `search-provider-register` only on the first registration. `handleSearch(message)` — runs the handler and replies `search-result` (ok:false on a thrown error or a missing handler).

**`worker-thread-channel.ts`** — `WorkerThreadChannel implements PluginWorkerChannel`. The real (non-test) transport: wraps a Node `Worker`, applying `resourceLimits.maxOldGenerationSizeMb` (the heap cap) and a scrubbed `env`. Deliberately thin — all protocol/correlation logic lives in `PluginWorkerHost`; a future child-process transport could implement the same interface.

**`worker-webhooks.ts`**
- `WebhookRequest`/`WebhookResponse`/`WebhookHandler` — the public SDK shape a plugin's ingress handler sees/returns (re-exported from `plugin.interfaces.ts` for plugin authors).
- `WebhookRegistry` — `register(route, handler)` (posts `webhook-subscribe` on first registration for that route), `handleWebhook(message)`: runs the handler inside the per-instance config scope (`hookConfigStore`), replying `webhook-result` with the handler's status/headers/body, a `404` for an unknown route, or a `500` for a thrown handler error.

---

## 5. Engine Layer

### src/engine — The Pluggable WhatsApp Engine Abstraction

OpenWA talks to WhatsApp through one of two interchangeable "engines": **whatsapp-web.js** (drives a
real headless Chromium browser against web.whatsapp.com) or **Baileys** (a pure WebSocket client that
speaks WhatsApp's multi-device protocol directly, no browser). Everything outside `src/engine/**`
(sessions, messaging, groups, webhooks, etc.) talks only to the `IWhatsAppEngine` interface defined in
`src/engine/interfaces/whatsapp-engine.interface.ts` — it never imports whatsapp-web.js or Baileys
types directly. This is what lets an operator flip `ENGINE_TYPE` in config and run the same product on
a totally different underlying library.

**How the pieces fit together:**

- **`interfaces/whatsapp-engine.interface.ts`** is the contract. It is split into ~13 "capability
  slices" (lifecycle, messaging, message operations, chat history, contacts, groups, calls, profile,
  labels, channels, status, catalog, chats, presence) that compose into the single `IWhatsAppEngine`
  union. All request/response shapes used across the contract (e.g. `IncomingMessage`, `Group`,
  `MediaInput`) are also declared here. Crucially, this file is also machine-read: a regex-based parser
  derives the list of interface methods, which both `engine-capability-matrix.ts` and a parity test
  (`engine-parity.spec.ts`, not covered here) use to verify every adapter stays honest about what it
  supports.
- **`adapters/`** holds the two concrete engines. Each has one "god object" adapter class
  (`BaileysAdapter`, `WhatsAppWebJsAdapter`) that implements `IWhatsAppEngine`, but the actual logic is
  factored into many small, focused modules (prefixed `baileys-*` / `wwebjs-*`) that the adapter class
  composes — e.g. `baileys-messaging.ts` / `wwebjs-messaging.ts` implement the sends, `baileys-groups.ts`
  / `wwebjs-groups.ts` implement group operations, `baileys-lifecycle.ts` / `wwebjs-lifecycle.ts` own
  connect/reconnect/QR. A handful of adapter-agnostic helpers (`message-mapper.ts`,
  `inbound-media-cap.ts`, `safe-link-preview.ts`, `vcard.ts`, `chromium-profile-hygiene.ts`) are shared
  or near-shared infrastructure.
- **`builtin/baileys/index.ts`** and **`builtin/whatsapp-web-js/index.ts`** are thin
  `IEnginePlugin` wrappers (the project's plugin system, `src/core/plugins`) that know how to
  construct a `BaileysAdapter` / `WhatsAppWebJsAdapter` from the opaque `engine.*` config blob, and
  report which "features" and library versions are available for the dashboard.
- **`engine.factory.ts`** (`EngineFactory`) is the single entry point application code uses to
  obtain a live `IWhatsAppEngine` for a session: it registers both built-in plugins at boot, asks the
  plugin loader for the configured engine type, and falls back to constructing a whatsapp-web.js
  adapter directly if the plugin system is unavailable. It also owns purging a session's on-disk auth
  data (for both engine shapes) on delete.
- **`engine-registry.service.ts`** (`EngineRegistry`) is the live, in-memory `sessionId -> engine
  instance` map — the single source of truth for "is this session's engine currently running", used by
  the ~10 feature services that need the running engine without depending on the whole session
  lifecycle service.
- **`engine-capability-matrix.ts`** derives, per interface method, whether it is really supported on
  each adapter (vs. a method that exists but 501s) — combining automatic derivation from the interface
  file with hand-curated "why not" annotations, consumed by `engine-parity.spec.ts` and by operator
  docs.
- **`identity/`** is the shared "anti-corruption layer" for WhatsApp's id dialects (`@c.us` /
  `@s.whatsapp.net` / `@lid` / `@g.us` / `@newsletter` / `@broadcast`): `wa-id.ts` has the pure
  parsing/normalization functions, and `lid-mapping-store.service.ts` + `lid-mapping.entity.ts`
  persist the privacy-id (`lid`) -> phone-number resolution table both adapters consult/write.
- **`types/`** holds engine-specific TypeScript augmentations (`baileys.types.ts`,
  `whatsapp-web-js.types.ts`) that patch gaps in each underlying library's own type definitions.
- **`engine-init-timeout.ts`** and **`wa-web-version.ts`** are small engine-agnostic (or
  wwebjs-only-but-import-light) utilities used during session startup.
- **`engine.module.ts`** is the NestJS wiring; **`index.ts`** is the deliberately narrow public
  re-export surface for code outside `src/engine`.

---

#### Top-level files

##### `src/engine/engine.module.ts`
NestJS module wiring for the whole engine layer.
- `@Global() @Module(...)` — imported once, available everywhere via DI.
- **Imports:** `TypeOrmModule.forFeature([BaileysStoredMessage, LidMapping], 'data')` (registers the
  two engine-owned entities on the `data` TypeORM connection).
- **Providers:** `EngineFactory`, `BaileysMessageStoreService`, `LidMappingStoreService`,
  `EngineRegistry`.
- **Exports:** `EngineFactory`, `LidMappingStoreService`, `EngineRegistry` — exported from this
  `@Global` module specifically so feature services that only need "the live engine for a session" can
  inject `EngineRegistry` directly instead of importing the whole session module.
- Exported class: `EngineModule`.

##### `src/engine/index.ts`
Intentionally narrow public re-export surface for code outside `src/engine`, so other modules never
reach into `adapters/` internals directly.
- Re-exports `BaileysStoredMessage` (from `adapters/baileys-stored-message.entity.ts`) and
  `inboundMediaMaxBytes` (from `adapters/inbound-media-cap.ts`).

##### `src/engine/engine.factory.ts`
The application's single entry point for creating/destroying a session's `IWhatsAppEngine` instance,
and for querying which engines are available.
- **`EngineCreateOptions`** interface: `sessionId` (on-disk auth-dir key / session NAME),
  `dbSessionId` (DB-row UUID for FK-bound stores), optional `proxyUrl`/`proxyType`.
- **`EngineFactory`** (`@Injectable`, `OnModuleInit`):
  - `onModuleInit()` — calls `registerBuiltInEngines()`.
  - `registerBuiltInEngines()` (private) — builds `PluginManifest`s for `whatsapp-web.js` and
    `baileys`, constructs `WhatsAppWebJsPlugin`/`BaileysPlugin` with the `engine.*` config blob and
    `LidMappingStoreService`/`BaileysMessageStoreService`, registers both via
    `pluginLoader.registerBuiltInPlugin`, then auto-enables whichever engine type is configured
    (`engine.type`, default `'whatsapp-web.js'`).
  - `create(options: EngineCreateOptions): IWhatsAppEngine` — validates the session name via
    `isSafeSessionName` (anti path-traversal), pre-creates both engines' auth directories as
    owner-only (`ensurePrivateDir`) regardless of which engine is active (so switching engines later
    never finds world-readable credentials), then asks the plugin loader for the configured engine
    plugin's `createEngine()`; falls back to `createFallbackEngine()` if the plugin is unavailable.
  - `purgeSessionData(sessionName: string): Promise<void>` — on session delete, best-effort removes
    BOTH engines' on-disk auth directories (whatsapp-web.js `session-${name}` dir and Baileys
    `authDir/name` dir) so switching the deploy-wide `ENGINE_TYPE` never leaves stale credentials for
    the inactive engine; guarded by the same `isSafeSessionName` check.
  - `wwjsAuthDir(sessionName)` / `baileysAuthDir(sessionName)` (private) — compute each engine's
    on-disk auth path from config, mirroring exactly what each adapter itself constructs.
  - `isEnginePlugin(instance)` (private) — type guard for `IEnginePlugin`.
  - `createFallbackEngine(options)` (private) — legacy direct construction of `WhatsAppWebJsAdapter`
    from raw config; throws if the configured engine type isn't whatsapp-web.js (refuses to silently
    run the wrong engine).
  - `getAvailableEngines()` — returns `{id, name, enabled, features, library}[]` for every registered
    engine plugin, for the dashboard/API.
  - `getCurrentEngine(): string` — the configured `engine.type`.

##### `src/engine/engine-registry.service.ts`
The single source of truth for which `IWhatsAppEngine` instance is currently live for a session —
decouples ~10 feature services from the full session-lifecycle owner.
- **`EngineRegistry`** (`@Injectable`):
  - Map-compatible surface: `get`, `set`, `has`, `delete`, `clear`, `size`, `keys()`, `entries()`,
    `[Symbol.iterator]()` (iterates a snapshot).
  - `initializing: Set<string>` (public field) — sessions whose engine is mid-construction but not
    yet registered (used so concurrency accounting doesn't treat a starting session as idle).
  - `isLive(id, engine): boolean` — true only if `engine` is still the exact registered instance for
    `id` (identity check, not just presence — guards against a stale/superseded engine's late
    callback).
  - `deleteIfLive(id, engine): boolean` — removes the entry only if `engine` is still live; prevents
    a superseded engine's teardown from evicting its live replacement.
  - `require(id, onMissing?)` — returns the live engine or throws (`BadRequestException` by default,
    caller may supply a custom error).
  - `activeIds(): string[]` — every session id with a live OR initializing engine (used by the infra
    import pre-flight to refuse an import that would orphan a running engine).
  - `beginHeavyOp()` / `endHeavyOp()` / `isHeavyOpInFlight` (getter) — process-wide counter flagging
    that a heavy CDP-bound read (e.g. `getChats()`) is in flight, so the session liveness watchdog can
    distinguish real disconnects from shared-event-loop contention across sibling sessions.

##### `src/engine/engine-capability-matrix.ts`
Derives, per `IWhatsAppEngine` method, whether it is genuinely supported on each adapter or only
exists-but-501s — combining automated derivation with hand-curated annotations.
- **Types:** `CapabilityStatus` (`'supported' | 'not-available'`), `RootCause` (`'adapter-gap' |
  'library-limitation' | 'uncertain'`), `AdapterCapability` (`{status, rootCause?}`),
  `MethodCapability` (`{wwjs, baileys, evidence?}`).
- **`CURATED_CAPABILITY_EXCEPTIONS`** — large hand-maintained `Record<string, MethodCapability>`
  covering every method whose support is NOT the default "supported on both". Each entry's
  `evidence` string cites the exact underlying-library symbols/behavior that was verified (often
  with specific file:line references into `node_modules`), so a contributor knows exactly where to
  look. Notable `not-available` rows: `createGroup` (wwjs — a WA Web internal regression),
  `upsertLabel`/`deleteLabel`/`getLabels`/`getLabelById`/`getChatLabels` (wwjs has reads only,
  Baileys has writes only — the two engines are asymmetric opposites for labels), `getCatalog` /
  `getProducts` / `getProduct` / `sendCatalog` (wwjs has no catalog API), `votePoll` (Baileys has no
  vote-send helper), `getChatHistory` (Baileys has no synchronous per-chat fetch),
  `subscribeToPresence` (wwjs has no presence-subscribe), `setGroupEphemeral` (wwjs has no ephemeral
  setter), `transferChannelOwnership`/`demoteChannelAdmin` (wwjs page functions removed upstream).
- `readInterfaceMethods(): string[]` — reads `interfaces/whatsapp-engine.interface.ts` off disk and
  regex-matches (`MEMBER_RE`) every interface member name, forming the authoritative method
  inventory (handles both `src/` and `dist/` layouts).
- `deriveEngineCapabilityMatrix(): Record<string, MethodCapability>` (private) — for every method
  name from `readInterfaceMethods()`, uses the curated exception if present, else defaults both
  adapters to `supported`.
- `copyCapability(entry)` (private) — deep-copies a `MethodCapability` so callers can't mutate the
  shared curated table.
- **`engineCapabilityMatrix(): Record<string, MethodCapability>`** — the public entry point; lazily
  derives and memoizes the matrix on first call (not at module load, so a dist-only runtime doesn't
  crash at import time).

##### `src/engine/engine-init-timeout.ts`
Small engine-agnostic timeout helpers used by the session lifecycle when racing `engine.initialize()`.
- `resolveAuthTimeoutMs(): number | undefined` — reads `WWEBJS_AUTH_TIMEOUT_MS` env var (positive
  safe integer only), overriding whatsapp-web.js's default 30s inject-wait for slow first boots.
- `resolveEngineInitTimeoutMs(): number` — the OUTER deadline the session lifecycle applies to
  `engine.initialize()` for either engine: `max(60_000, (authTimeoutMs ?? 30_000) + 30_000)`. Must
  exceed the auth wait wwebjs runs inside `initialize()`, or a slow-but-legitimate init gets killed
  mid-auth.

##### `src/engine/wa-web-version.ts`
WhatsApp Web build-version resolution for the whatsapp-web.js engine, kept free of whatsapp-web.js
imports so the infra status endpoint can read it without pulling in the heavy library.
- `WebVersionPin` type — `{webVersion, webVersionCache: {type:'remote', remotePath}}`.
- `WA_VERSION_REGISTRY_URL` — the `wppconnect-team/wa-version` registry tracking known-good WA Web
  builds.
- `__resetWebVersionCache()` — test-only cache reset.
- `pickSettledWebVersion(versions, now, currentVersion)` — pure function selecting the newest
  non-beta, unexpired build published at least `WEB_VERSION_SETTLE_MS` (12h) ago, rather than the
  registry's possibly-just-published `currentVersion` — hardens against pinning to an unvalidated
  bleeding-edge build that hangs before reaching QR readiness.
- `resolveCurrentWebVersion(fetcher?)` — fetches/caches the current known-good version from the
  registry; failures are rate-limited (60s backoff) rather than retried every call; concurrent callers
  share one in-flight fetch.
- `resolveWebVersionPin(fetcher?)` — resolves the final pin from `WWEBJS_WEB_VERSION` env
  (`off`/`auto`/`latest`/unset/explicit version string), warning once per process when a remote pin
  is used (since the HTML is fetched and executed in-page with no integrity check).
- `getEffectiveWebVersionInfo()` — reports `{version, source: 'pinned'|'auto'|'native'}` for the
  dashboard.

---

#### `src/engine/interfaces/` — the engine contract

##### `src/engine/interfaces/whatsapp-engine.interface.ts`
The abstract contract both engines implement. ~1400 lines; the authoritative shape of every
request/response object and every method either adapter must provide. Summarized by section rather
than exhaustively:

**Core enums/types:** `EngineStatus` (`disconnected | initializing | qr_ready | authenticating |
ready | action_required | failed`), `MessageType` (neutral message-kind vocabulary: text, image,
video, audio, voice, document, sticker, location, contact, poll, call, revoked, masked, unknown),
`DeliveryStatus` (`pending|sent|delivered|read|failed`), `ChatState` (`typing|recording|paused`),
`PresenceState`, `CallOutcome`, `CallLinkType`, `GroupMemberAddMode`, `ChatKind` (re-exported from
`identity/wa-id`).

**Data shapes:** `MessageResult`, `Quotable` (mixin for a `quotedMessageId`), `MediaInput`,
`IncomingMessage` (the big one — every field an inbound message can carry: id/from/to/chatId/body/
type/timestamp/fromMe/isGroup/kind/media/quotedMessage/location/call/reactions-adjacent fields/lid
fields, etc.), `MessageContact`, `Contact`, `Group`, `GroupParticipant`,
`ParticipantOperationResult` (per-participant outcome of a membership write), `GroupInfo`,
`GroupJoinInfo`, `GroupMembershipRequest`, `CustomLinkPreview`, `ContactCard`, `LocationInput`,
`PollInput`, `ReactionSender`/`MessageReaction`, `Label`/`LabelInput`, `Status`/`StatusPostOptions`/
`StatusResult`, `Channel`/`ChannelMessage`, `Catalog`/`Product`/`ProductQueryOptions`/
`PaginatedProducts`, `ChatSummary`, `RevokedMessage`, `EditedMessage`, `ReactionEvent`, `GroupEvent`,
`IncomingCallEvent`, `AccountRestriction` (`reachout_timelock | tos_block | proxy_block`),
`ParticipantPresence`/`PresenceUpdateEvent`, `CallOutcomeEvent`.

**`EngineEventCallbacks`** — the full set of optional callbacks an adapter invokes: `onQRCode`,
`onReady`, `onMessage`, `onMessageCreate` (own outgoing sends, including linked-phone sends),
`onMessageAck`, `onMessageRevoked`, `onMessageReaction`, `onMessageEdited`, `onGroupEvent`, `onCall`,
`onHistoryMessages` (bulk initial-sync backlog), `onDisconnected`, `onStateChanged`,
`onActionRequired` (operator intervention needed, e.g. wwebjs onboarding-modal dismissal failure),
`onAccountRestriction`, `onPresenceUpdate`, `onCallOutcome`, `onError` (terminal failure),
`onCredentialTeardownStarted` (fires synchronously when a destructive `fs.rm` of the auth dir
begins, so the lifecycle can wait for it before touching that path), `claimStuckAuthRecovery`
(synchronous one-shot budget claim for automatic credential-reset, owned by the session lifecycle so
it survives adapter recreation across reconnects).

**Capability slices** (each an interface; `IWhatsAppEngine` extends all of them):
- `SessionLifecycleCapability` — `initialize`, `disconnect`, `logout`, `destroy`, `forceDestroy`,
  `getStatus`, `probeLiveness?` (active liveness round-trip, optional), `getQRCode`,
  `requestPairingCode`, `getPhoneNumber`, `getPushName`.
- `MessagingCapability` — `sendTextMessage` (with `linkPreview`/`customPreview` options),
  `sendImageMessage`, `sendVideoMessage`, `sendAudioMessage`, `sendDocumentMessage`,
  `sendLocationMessage`, `sendContactMessage`, `sendStickerMessage`, `sendPollMessage`,
  `replyToMessage`, `forwardMessage`.
- `MessageOperationsCapability` — `reactToMessage`, `getMessageReactions`, `deleteMessage`,
  `editMessage`, `starMessage`, `votePoll`, `pinMessage`, `unpinMessage`.
- `ChatHistoryCapability` — `getChatHistory` (with media-budget params and `AbortSignal`).
- `ContactCapability` — `getContacts`, `getContactById`, `checkNumberExists`, `getNumberId`,
  `resolveContactPhone`, `getProfilePicture`, `blockContact`, `unblockContact`,
  `getBlockedContacts`, `upsertContact`, `deleteContact`.
- `GroupCapability` — `getGroups`, `getGroupInfo`, `createGroup`, `addParticipants`,
  `removeParticipants`, `promoteParticipants`, `demoteParticipants`, `leaveGroup`,
  `setGroupSubject`, `setGroupDescription`, `getGroupInviteCode`, `revokeGroupInviteCode`,
  `joinGroupViaInviteCode`, `getGroupJoinInfo`, `setGroupMessagesAdminsOnly`,
  `setGroupInfoAdminsOnly`, `setGroupPicture`, `deleteGroupPicture`, `setGroupMemberAddMode`,
  `setGroupEphemeral`, `getGroupMembershipRequests`, `approveGroupMembershipRequests`,
  `rejectGroupMembershipRequests`.
- `CallCapability` — `rejectCall`, `createCallLink`.
- `ProfileCapability` — `setProfileName`, `setProfileStatus`, `setProfilePicture`,
  `deleteProfilePicture`.
- `LabelCapability` — `getLabels`, `getLabelById`, `getChatLabels`, `addLabelToChat`,
  `upsertLabel`, `deleteLabel`, `getChatsByLabel`, `removeLabelFromChat`.
- `ChannelCapability` — `getSubscribedChannels`, `getChannelById`, `subscribeToChannel`,
  `unsubscribeFromChannel`, `getChannelMessages`, `createChannel`, `deleteChannel`, `muteChannel`,
  `demoteChannelAdmin`, `transferChannelOwnership`.
- `StatusCapability` — `getContactStatuses`, `getContactStatus`, `postTextStatus`,
  `postImageStatus`, `postVideoStatus`, `postVoiceStatus`, `deleteStatus`.
- `CatalogCapability` — `getCatalog`, `getProducts`, `getProduct`, `sendProduct`, `sendCatalog`.
- `ChatCapability` — `getChats`, `sendSeen`, `markUnread`, `deleteChat`, `archiveChat`, `pinChat`,
  `muteChat`, `clearChatMessages`.
- `PresenceCapability` — `sendChatState`, `setOnlinePresence`, `subscribeToPresence`.

**`IWhatsAppEngine`** — the composed union of all slices above; both `BaileysAdapter` and
`WhatsAppWebJsAdapter` implement this interface in full.

---

#### `src/engine/types/` — library type augmentations

##### `src/engine/types/baileys.types.ts`
Local type augmentations/contracts for the Baileys adapter.
- **`BaileysMessageStore`** (interface) — persistence boundary the adapter depends on (not the
  concrete Nest service), for unit-testability: `put(sessionId, msg)`, `getMessage(sessionId, id)`,
  `getMessages(sessionId, ids)` (bulk; missing ids simply absent), `clearSession(sessionId)`.
- **`BaileysAdapterConfig`** (interface) — per-call construction config: `sessionId` (name),
  `dbSessionId` (UUID), `authDir`, `proxyUrl?`, `proxyType?`, `messageStore?`, `lidMappingStore?`.
- **`BaileysLogger`** (interface) — minimal pino-compatible logger shape Baileys' `makeWASocket`
  expects (`level`, `child`, `trace/debug/info/warn/error`), declared locally to avoid a direct
  `pino` dependency.

##### `src/engine/types/whatsapp-web-js.types.ts`
Type augmentations filling gaps in whatsapp-web.js's own `.d.ts` (the library's types lag its actual
runtime shape, especially after WA Web's 2026-07-14 `_serialized` → `$1` minifier rename, #747).
- **`SerializedWid`** (interface) — `{_serialized?, $1?}`; exactly one present depending on WA Web
  build.
- **`readWid(wid)`** — reads a serialized id under either property name; every raw-Wid read in the
  wwebjs adapter code goes through this to avoid silently reading `undefined`.
- **`GroupMetadataRaw`** (interface) — raw `chat.groupMetadata.serialize()` shape: multiple candidate
  parent-community fields, `announce`, `restrict`, `ephemeralDuration`, loosely-typed
  `memberAddMode` (string or boolean, since the real runtime writes raw strings despite the upstream
  `.d.ts` declaring a boolean).
- **`GroupChat`** (interface, extends `Chat`) — group-specific members: `participants`,
  `description`, `owner`, `createdAt`, `addParticipants`/`removeParticipants`/
  `promoteParticipants`/`demoteParticipants`, `leave`, `setSubject`/`setDescription` (resolve
  `false` rather than throwing on refusal), `getLabels`/`addLabel`/`removeLabel`,
  `getInviteCode`/`revokeInvite`, `setMessagesAdminsOnly`/`setInfoAdminsOnly`/
  `setAddMembersAdminsOnly`, `setPicture`/`deletePicture`.
- **`MessageWithReactions`** (interface, extends `Message`) — `react(emoji)`, `hasReaction?`,
  `getReactions()`.
- **`BusinessClient`** (interface, extends `Client`) — label/channel members missing from upstream
  types: `getLabels`, `getLabelById`, `getChatsByLabelId`, `getChannels`, `subscribeToChannel` (takes
  a channel ID, not an invite code), `createChannel` (resolves a result object OR an error string —
  does not throw), `deleteChannel`, `unsubscribeFromChannel`.
- **`WwjsChannelData`** (interface) — channel id/name/description/inviteCode/subscriberCount/
  verified + `fetchMessages(opts)`.
- **`WwjsChannelMessage`** (interface) — channel message shape (id as `SerializedWid`, body, type,
  timestamp, hasMedia, mediaUrl).

---

#### `src/engine/identity/` — the WhatsApp-id anti-corruption layer

##### `src/engine/identity/wa-id.ts`
Pure functions normalizing WhatsApp's several JID dialects into one neutral vocabulary, used by both
adapters at every boundary where an id crosses into/out of application code.
- `WaIdKind` type — `'user' | 'group' | 'lid' | 'status' | 'newsletter' | 'broadcast' | 'unknown'`.
- `DOMAIN_KINDS` (internal map) — maps JID domain strings to kinds; folds `s.whatsapp.net`→`user`
  (same as `c.us`) and the Meta-"hosted" dialects (`hosted`/`hosted.lid`) into `user`/`lid`
  respectively, matching how the Baileys library itself folds them.
- `ParsedWaId` interface — `{kind, userPart, device?, raw}`.
- `userPart(jid): string` — strips domain and `:device` suffix.
- `parseWaId(jid): ParsedWaId` — classifies any JID into kind + parts without resolving anything.
- `isIndividualWid(value): boolean` — true only for a `user`/`lid` kind AND a numeric-looking
  user-part (5+ digits) — guards against malformed values reaching WhatsApp Web's page-side
  `createWid`, which throws an undiagnosable error.
- `isAddressableParticipant(value): boolean` — `isIndividualWid` OR a bare numeric string (for
  convenience inputs later qualified by `toParticipantWid`).
- `toParticipantWid(value): string` — qualifies a bare numeric string to `<n>@c.us`; passes anything
  else through unchanged.
- `toNeutralJid(jid, resolvePhone?): string` — the core normalizer: reduces any JID to the neutral
  dialect (`@c.us`/`@g.us`/`@lid`/`status@broadcast`/`@newsletter`/`@broadcast`), resolving a `lid`
  to `@c.us` via the optional `resolvePhone` callback when possible, else keeping it as `@lid`.
- `isChannelJid(jid): boolean` — true for `@newsletter` ids (used to skip Chat-only wwebjs
  operations that a `Channel` object doesn't support).
- `ChatKind` type — `'individual' | 'group' | 'channel' | 'status' | 'broadcast' | 'unknown'`
  (consumer-facing; `lid` folds into `individual`).
- `chatKind(jid): ChatKind` — maps any JID to its user-facing chat kind.

##### `src/engine/identity/lid-mapping.entity.ts`
TypeORM entity for the persisted lid→phone resolution table.
- **`LidMapping`** (`@Entity('lid_mappings')`, indexed on `phone` for reverse lookup) — one global,
  cross-session row per lid (shared across sessions/restarts, replacing a prior per-session in-memory
  map). Columns: `lid` (`@PrimaryColumn`), `phone` (nullable — null records a cached negative
  resolution), `sessionId` (nullable, provenance only, not a FK), `updatedAt`
  (`@UpdateDateColumn`). Last-write-wins semantics.

##### `src/engine/identity/lid-mapping-store.service.ts`
Backs lid resolution with an in-memory, bounded-LRU mirror of the `LidMapping` table (resolution must
be synchronous — filters/dispatch can't await a query).
- `LID_MAPPING_CACHE_DEFAULT = 5000` — default cap on the in-memory mirror.
- **`LidMappingStore`** (interface) — the narrow port: `getCached(lid)` (sync, `string | null |
  undefined`), `resolveLid(jid)` (sync, resolves any JID's user-part), `lidsForPhone(phone)` (sync
  reverse lookup), `remember(lid, phone, sessionId?)` (async write-through).
- **`LidMappingStoreService`** (`@Injectable`, implements `LidMappingStore`, `OnModuleInit`):
  - `onModuleInit()` — calls `reload()`.
  - `reload(): Promise<void>` — (re)loads the in-memory mirror from the table, ordered by
    `updatedAt DESC` and capped at `maxCachedLids`; never throws (missing table/read error just
    leaves resolution falling back to engine re-resolution). Also called by the infra data-import
    flow after a full-replace restore.
  - `getCached(lid): string | null | undefined` — LRU-touching sync read; on a miss, kicks off
    `warmFromTable` in the background and returns `undefined` immediately.
  - `resolveLid(jid): string | null` — `getCached(userPart(jid)) ?? null`.
  - `lidsForPhone(phone): string[]` — reverse-map read.
  - `remember(lid, phone, sessionId?): Promise<void>` — no-ops if unchanged; else updates the
    in-memory indexes immediately and upserts the row (swallows persist errors, logged only).
  - `warmFromTable(lid)` (private) — dedup'd (via `pendingLookups`) background repository lookup on
    a cache miss; does NOT cache a table-miss (to avoid shadowing a concurrent `remember`).
  - `index(lid, phone)` (private) — updates both forward and reverse maps, reconciling stale reverse
    entries, then evicts if over cap.
  - `evictIfOverCap()` (private) — removes the least-recently-used forward entry (Map insertion
    order) and its reverse-index counterpart while over `maxCachedLids`.

---

#### `src/engine/builtin/` — plugin wrappers for the two engines

##### `src/engine/builtin/baileys/index.ts`
The `IEnginePlugin` implementation that lets the plugin loader construct Baileys engines.
- **`BaileysPlugin`** (implements `IEnginePlugin`, `type = PluginType.ENGINE`):
  - Constructor takes optional `messageStore` (`BaileysMessageStore`), `registeredConfig` (the
    `engine.*` config blob, as a construction-time fallback if `onLoad` hasn't run yet), and
    `lidMappingStore`.
  - `onLoad(context)` / `onEnable(context)` / `onDisable(context)` — lifecycle hooks; `onLoad`
    captures `context` for later config reads.
  - `createEngine(config): IWhatsAppEngine` — reads `sessionId`/`dbSessionId`/`proxyUrl`/`proxyType`
    from the per-call config, reads Baileys' own `baileys.authDir` sub-tree from the stored engine
    config, constructs and returns a `new BaileysAdapter({...})`.
  - `getFeatures(): string[]` — static feature list (text/typing/media/location/contact/replies/
    forwarding/reactions/deletion/groups/read-receipts).
  - `getEngineLibrary()` — reads the real `@whiskeysockets/baileys` package version at runtime
    (`'unknown'` if unresolvable).
  - `healthCheck()` — always resolves `{healthy: true}`.
  - Default export: `BaileysPlugin`.

##### `src/engine/builtin/whatsapp-web-js/index.ts`
The `IEnginePlugin` implementation that lets the plugin loader construct whatsapp-web.js engines.
- **`WhatsAppWebJsPlugin`** (implements `IEnginePlugin`, `type = PluginType.ENGINE`):
  - Constructor takes optional `registeredConfig` and `lidMappingStore` (threaded to the adapter so
    it can persist learned phone↔lid pairs, mirroring `BaileysPlugin`).
  - `onLoad` / `onEnable` / `onDisable` — same pattern as `BaileysPlugin`.
  - `createEngine(config): IWhatsAppEngine` — reads `sessionId`/`proxyUrl`/`proxyType` from per-call
    config, reads `sessionDataPath`/`puppeteer.{headless,args,executablePath}` from the stored
    engine config, constructs and returns a `new WhatsAppWebJsAdapter({...})`.
  - `getFeatures(): string[]` — static feature list (text/media/location/contact/groups/reactions/
    replies/forwarding/deletion/read-receipts/typing/labels/channels/status — deliberately omits
    `'catalog'`, since wwebjs has no catalog/product API).
  - `getEngineLibrary()` — reads the real `whatsapp-web.js` package version at runtime.
  - `healthCheck()` — always resolves `{healthy: true}`.
  - Default export: `WhatsAppWebJsPlugin`.

---

#### `src/engine/adapters/` — Baileys engine implementation

Baileys has no browser; the adapter speaks the WhatsApp multi-device WebSocket protocol directly via the `@whiskeysockets/baileys` library. `baileys.adapter.ts` is the god object implementing `IWhatsAppEngine`; everything else in this group is a focused delegate or pure-mapping module it composes.

##### Core delegates (connection, events, messaging)

##### `src/engine/adapters/baileys.adapter.ts`
The "god object" entry point for the Baileys engine: `BaileysAdapter implements IWhatsAppEngine` and forwards almost every public method to one of nine focused delegate classes it owns and wires together via a shared `host` closure object. It also keeps a small amount of logic directly (chat labels, label app-state writes, JID helpers, unsupported-method stubs) that didn't warrant its own delegate.

- **`class BaileysAdapter implements IWhatsAppEngine`**
  - Constructed with a `BaileysAdapterConfig` (authDir, sessionId, proxyUrl, messageStore, dbSessionId, lidMappingStore, etc.).
  - Owns one `BaileysSessionStore` (JID/contact/chat cache + lid mapping) and nine delegate instances: `BaileysEvents`, `BaileysGroups`, `BaileysMessaging`, `BaileysContacts`, `BaileysStatus`, `BaileysChannels`, `BaileysCatalog`, `BaileysHistory`, `BaileysLifecycle`.
  - **Delegate wiring pattern**: builds a single large `host: BaileysEngineHost` object literal (not nine separate per-delegate bags) that every delegate receives in its constructor. Each delegate declares its own narrow `XxxHost` interface that this literal satisfies structurally — so adding a new cross-cutting capability means adding one property to this one literal, not touching every delegate. Construction order matters: `BaileysEvents` is built first (assigned into a local `delegates` bag) because the host's `liveCalls` getter and other wiring reference it; `BaileysLifecycle` is built last since it's the only delegate that *uses* `liveCalls` during live socket events, by which point `delegates.events` is guaranteed set.
  - `private readonly inboundLimiter = new ConcurrencyLimiter(...)`: bounds **concurrent** inbound media downloads (not queue size — the queue is deliberately unbounded) because each download fully materializes a decrypted buffer in heap; capping the queue too would silently drop media from large upserts (documented regression: a 40-message upsert previously lost media on 32 of them because a capped queue only admitted a constant 2n regardless of batch size).
  - **State aliasing**: `sock`, `connectedAt`, and `liveCalls` are NOT stored on the adapter — they're getter/setter pairs that proxy to `this.lifecycle.sock` / `this.lifecycle.connectedAt` / `this.events.liveCalls`. This exists so an "unmodified spec" that pokes `adapter.sock` / `adapter.liveCalls` via a type cast keeps working byte-identically even though the real state now lives in the delegates.
  - **Lifecycle methods** (`initialize`, `disconnect`, `logout`, `destroy`, `forceDestroy`, `getStatus`, `probeLiveness`, `getQRCode`, `requestPairingCode`, `getPhoneNumber`, `getPushName`): all thin one-line forwarders to `this.lifecycle`. `initialize` additionally stashes the `EngineEventCallbacks` on `this.callbacks` (read live by the host closures) before delegating. `forceDestroy` is just `destroy` — Baileys has no separate Chromium process to SIGKILL.
  - **Messaging methods** (`sendTextMessage`, `checkNumberExists`, `getNumberId`, `sendChatState`, `setOnlinePresence`, all `send*Message` variants, `replyToMessage`, `forwardMessage`, `reactToMessage`, `deleteMessage`, `starMessage`, `pinMessage`/`unpinMessage`, `editMessage`, `subscribeToPresence`, `createCallLink`): thin forwarders to `this.messaging`.
  - **Group methods** (`getGroups`, `getGroupInfo`, `createGroup`, add/remove/promote/demote participants, `leaveGroup`, subject/description/picture/ephemeral setters, invite-code get/revoke/join, admin-only toggles, member-add-mode, membership requests get/approve/reject): all forward to `this.groups`.
  - **Contact/profile/chat methods** (`getProfilePicture`, `blockContact`/`unblockContact`, `upsertContact`, `deleteContact`, `getBlockedContacts`, `setProfileName`/`setProfileStatus`/`setProfilePicture`/`deleteProfilePicture`, `getContacts`, `getContactById`, `resolveContactPhone`, `getChats`, `sendSeen`, `markUnread`, `deleteChat`, `muteChat`, `pinChat`, `archiveChat`, `clearChatMessages`): forward to `this.contacts`.
  - **Channel methods** (`createChannel`, `deleteChannel`, `muteChannel`, `demoteChannelAdmin`, `transferChannelOwnership`, `getChannelById`, `subscribeToChannel`, `unsubscribeFromChannel`): forward to `this.channels`. `getSubscribedChannels` and `getChannelMessages` are `unsupported()` stubs — the latter because Baileys' `newsletterFetchMessages` returns a raw BinaryNode with no library parser, and mapping it would need an unverified wire-format walk.
  - **Status methods** (`postTextStatus`, `postImageStatus`, `postVideoStatus`, `postVoiceStatus`, `deleteStatus`): forward to `this.statusOps`. `getContactStatuses`/`getContactStatus` are `unsupported()`.
  - **Catalog methods** (`getCatalog`, `getProducts`, `getProduct`): forward to `this.catalog`. `sendProduct` is adapter-local glue: looks up the product via `this.catalog.getProduct`, 404s via `NotFoundException` if missing, then calls `this.messaging.sendProductMessage`. `sendCatalog` is `unsupported()` — Baileys has no catalog-level message primitive, only single-product `{product}` content.
  - **Label methods** — implemented directly on the adapter (not delegated), because Baileys exposes labels as app-state WRITES only (`addChatLabel`/`removeChatLabel`/`addLabel`), with no read/list API:
    - `addLabelToChat`/`removeLabelFromChat`: call `ensureReady()`, `assertLabelable()` (throws `ChatLabelsUnsupportedError` for channel JIDs — channels have no label concept and whatsapp-web.js refuses them outright, so this keeps behavior consistent across engines instead of silently "succeeding" on a no-op), then `sock.addChatLabel`/`removeChatLabel` under `withQueryDeadline`.
    - `upsertLabel`: create-and-update are the same WhatsApp app-state operation (`label_edit` patch keyed by label id) — distinguished only by whether the id already exists, which is why the id is caller-supplied rather than server-generated. Calls `sock.addLabel(ownJidForAppState(), {...})`. Important subtlety documented in comments: unset fields must be passed through as `undefined`, not stripped, because the protobuf encoder treats `undefined` the same as a missing field — and color `0` is a *real* WhatsApp color that must never be tested for truthiness.
    - `deleteLabel`: same `addLabel` call with `{ deleted: true }` (a tombstone flag), not a separate API.
    - `ownJidForAppState()`: the `jid` argument `addLabel` demands is actually unused internally by Baileys' `chatModifyToPatch` (it builds the index from `['label_edit', id]`), so the account's own jid is passed purely because the call signature requires *something*, falling back to `'status@broadcast'`.
    - `getLabels`, `getLabelById`, `getChatLabels`, `getChatsByLabel` are `unsupported()` — Baileys has no label-listing API; building one would require maintaining a separate app-state cache fed by label-association sync events (explicitly called out as a separate, untracked body of work).
    - `getMessageReactions`, `votePoll`, `getChatHistory` are also `unsupported()` (no vote-send helper exists in Baileys at all — only `decryptPollVote` for receiving).
  - **Event methods**: `rejectCall` forwards to `this.events.rejectCall`.
  - **Private helpers**: `normalizedSelfJid()` extracts the phone from `sock.user.id` and appends `@s.whatsapp.net`; `unsupported(method)` returns a `Promise.reject(new EngineNotSupportedError(method))`; `ensureReady()` (protected) forwards to `this.lifecycle.ensureReady()`; `extractPhone(id)` strips the `:device` suffix and `@domain` from a raw Baileys id (`628999:12@s.whatsapp.net` → `628999`).
- No NestJS decorators — this is a plain class instantiated manually by the session service, not a NestJS-managed provider.

---

##### `src/engine/adapters/baileys-lifecycle.ts`
Owns the Baileys socket's entire connection lifecycle: establishing/tearing down the `WASocket`, QR code generation and publishing, pairing codes, reconnect-with-backoff on transient drops, and the three terminal-close paths (logged out, connection replaced, forbidden/banned). This is where almost all of the "why" comments in the Baileys adapter live — reconnection strategy, stuck-auth recovery, and QR/pairing race conditions are all handled here.

- **`createProxyAgent(proxyUrl: string): Agent`** (exported function, re-exported from `baileys.adapter.ts` for spec compatibility)
  - Builds the Node `https.Agent` used for the session's egress proxy (#859), shared by both the WhatsApp WebSocket and media up/downloads.
  - Dispatches on URL protocol: `http:`/`https:` → `HttpsProxyAgent`; `socks4:`/`socks5:` → `SocksProxyAgent`; anything else throws, so an invalid proxy value fails the session closed rather than silently connecting direct.
- **`interface BaileysLifecycleHost`**: the narrow host surface this delegate needs — logger, `authPath`, `config`, shared `liveCalls` map, `extractPhone`, contact/chat/lid-mapping upsert hooks, event-handler forwarders (`handleMessagesUpsert`, etc.), `captureHistoryMessages`/`hydrateNames`, and getters for every lifecycle-relevant callback (`onQRCode`, `onReady`, `onDisconnected`, `onError`, `onStateChanged`, `onCredentialTeardownStarted`, `onAccountRestriction`).
- **`class BaileysLifecycle`** — implements the lifecycle slice of `IWhatsAppEngine`'s behavior (consumed by `BaileysAdapter` via forwarding, not declared `implements` itself).
  - Owns the real state: `sock` (public, aliased by the adapter), `connectedAt` (public, unix-seconds of last 'open'), `status`, `qrCode`, `phoneNumber`, `pushName`, `intentionalClose` latch, `reconnectAttempts`, `reconnectTimer`, `lastConnectionCloseAt`, lazily-loaded `lib`.
  - `loadLib()`: lazily `import('@whiskeysockets/baileys')` and memoize — the library is ESM-only, so it's deferred to first connect rather than loaded at boot (keeps boot cheap for wwebjs-only processes too).
  - `initialize()`: guarded by the `intentionalClose` latch — a single-use flag. If a session was stopped/deleted during the pre-initialize window, this is a no-op rather than opening an untracked live socket. On failure, sets `FAILED` status, fires `onError`, and rethrows.
  - `connect()` / `connectInner()`: `connect()` is an in-flight guard (`this.connecting`) wrapping `connectInner()`. `connectInner()` does the real work:
    - Builds the proxy agent (if configured) *before* any auth-state I/O, so a bad proxy value fails fast.
    - Loads the lib, reads multi-file auth state (`useMultiFileAuthState`), resolves the protocol version via `BaileysVersionResolver`.
    - Wraps the signal key store with `makeCacheableSignalKeyStore` — without this, a write-then-immediate-read race on disk could make a freshly-established Signal session appear "missing," forcing a brand-new PreKey handshake on the very next send (observed as "Closing session" log spam and recipients stuck on "waiting for this message").
    - Re-checks `intentionalClose` after the auth/version awaits — guards against a disconnect/logout/destroy racing the connect.
    - **Socket replacement teardown**: on a reconnect, the *previous* socket's ~15 event listeners are explicitly removed (`removeAllListeners` for every wired event) before calling `previous.end(undefined)` — specifically listeners are detached BEFORE `end()` because Baileys' own `end()` synchronously emits a synthetic `connection.update {connection:'close'}` that would otherwise re-enter the handler and schedule a spurious second reconnect. Otherwise each internal reconnect would leak the old socket + listeners.
    - Constructs the new socket via `b.default({...})` with notable options:
      - `shouldSyncHistoryMessage: () => true` — Baileys defaults this to `() => !!syncFullHistory`, so leaving both unset would disable ALL history/app-state sync (no contacts, chats, recent history, or lid→phone mappings ever arrive). Returning `true` enables the sync while `syncFullHistory` (env `BAILEYS_SYNC_FULL_HISTORY`) stays opt-in for the full archive vs. just the recent window + full contact/app-state snapshot.
      - `markOnlineOnConnect: process.env.BAILEYS_MARK_ONLINE_ON_CONNECT !== 'false'` — Baileys defaults this to `true`, which broadcasts `available` on every (re)connect; WhatsApp then suppresses the paired phone's push notifications while any linked device is online, permanently silencing a 24/7 gateway's phone (#871) unless explicitly disabled.
      - `getMessage`: implements Baileys' message-retry protocol hook (defaults to a no-op), backed by the shared `messageStore` — without a real implementation, a recipient whose first decrypt attempt fails has nothing to resend and is stuck "waiting for this message" indefinitely.
      - `agent`/`fetchAgent`: both set to the same proxy agent (undefined = direct).
    - Wires 15 `sock.ev.on(...)` listeners: `creds.update` (persists via `saveCreds`), `connection.update` → `handleConnectionUpdate`, `messages.upsert`/`messages.update` → events delegate, `contacts.upsert`/`contacts.update` → log + `upsertContacts`, `chats.upsert`/`chats.update` → log + `upsertChats`, `group-participants.update`, `groups.update`, `group.join-request`, `messaging-history.set` (fans out to upsertContacts/upsertChats/addLidMappings/captureHistoryMessages with a detailed debug log), `lid-mapping.update` (renamed from pre-v7 `chats.phoneNumberShare`), `call`, `presence.update`.
  - `handleConnectionUpdate(update)`: the central state machine, branching on `reachoutTimeLock`, `qr`, `isNewLogin`, and `connection` (`'connecting'`/`'open'`/`'close'`):
    - `reachoutTimeLock` arrives standalone (no `connection` key) both from a pushed WhatsApp change and from `probeAccountRestriction()`'s own query result routed back through the same event — handled by `reportReachoutTimelock`.
    - `qr`: only rendered/published if status isn't already `AUTHENTICATING` — Baileys keeps rotating the QR every 20-60s including after the link was accepted, and a late refresh must not regress the session back to QR_READY.
    - `isNewLogin`: sets status to `AUTHENTICATING` (not back to QR_READY) — WhatsApp accepted the scan/pairing code and will force a restart (515 close) next; staying at QR_READY would let a repeat pairing request in that window overwrite just-linked creds.
    - `connection === 'connecting'` → `INITIALIZING`.
    - `connection === 'open'`: clears QR, sets phone/pushName from `sock.user`, resets `reconnectAttempts`, sets `connectedAt = now - 10s` (backward buffer for clock skew between host and WhatsApp's server — without it a message arriving right at reconnect could appear to predate `connectedAt` and get misjudged as history by the events delegate), sets `READY`, fires `onReady`, probes account restriction once per connection (since it's only *pushed* on change), and triggers `hydrateNames()`.
    - `connection === 'close'`: reads the Boom status code and branches:
      - If `intentionalClose` was already set → just settle to `DISCONNECTED`, return.
      - `loggedOut` (401) → terminal, delegates to `handleRemoteLoggedOut()` (wipes auth state).
      - `connectionReplaced` (440, fallback if lib const missing) → terminal `FAILED` + `onError`; auth state is **not** cleared (the link itself is still valid — a second instance took over). Operator must stop the other instance and restart this session.
      - `forbidden` (403) → terminal `FAILED` + `onError` ("account rejected... banned or blocked"); auth state also **not** cleared, since this is an account-level refusal, not dead credentials.
      - **Everything else** (408/411/428/500/503/515/undefined) → transient: logged, status dropped to `INITIALIZING` (not left at READY — the socket is already dead but the reconnect only runs after the backoff delay, so staying READY would let `probeLiveness()` lie and let sends fail against the dead socket), and `scheduleReconnect()` is called — deliberately with NO onDisconnected callback, since this isn't a terminal disconnect.
      - Duplicate-close guard: if a reconnect timer is already pending, return without burning an attempt (Baileys can emit more than one close per drop).
      - **Stability reset**: if the current close happens more than `RECONNECT_STABILITY_RESET_MS` (5 min) after the last one, `reconnectAttempts` resets to 0 — a close long after the prior one implies the connection had been healthy in between.
  - `reportReachoutTimelock(state)`: translates Baileys' reachout-timelock payload into the neutral `onAccountRestriction` callback. `isActive: false` is forwarded as `null` (a positive "no restriction," not an absence of data). Does **not** touch connection status/reconnects — a timelock only blocks starting *new* conversations, existing chats keep working. Guards against `Invalid Date`/`NaN` from a malformed `timeEnforcementEnds`.
  - `probeAccountRestriction()`: best-effort fire of `sock.fetchAccountReachoutTimelock()` — answer is unused directly since Baileys re-emits the result through `connection.update`; failures are logged at debug only, since an unresponsive server must never fail a healthy connection.
  - `scheduleReconnect()`: capped exponential backoff — `min(60_000, 1000 * 2^(attempts-1)) + jitter(0-1000ms)`. **Deliberately no attempt ceiling** — transient drops retry forever; only the three terminal codes above stop reconnecting. A failed `connect()` attempt inside the timer just logs a warning and reschedules.
  - `handleQrCode(qr)`: renders the raw QR ref to a PNG data URL via `qrcode.toDataURL`, then re-validates before publishing — checks `this.sock !== sock` (socket already swapped), `!sock?.ws.isOpen` (dead), or `status === AUTHENTICATING` (link already accepted) — any of which means the QR must NOT be published (avoids stamping QR_READY on a dead/superseded socket).
  - `disconnect()`: sets `intentionalClose`, clears any reconnect timer, ends the socket, nulls it, clears `liveCalls`, sets `DISCONNECTED`. Synchronous (returns a resolved promise).
  - `logout()`: the most involved teardown path.
    - Captures the *exact* live socket (`sourceSock`) up front — an optional-chained send on a null socket would silently resolve as if the unlink succeeded, wiping local creds while leaving the device linked server-side.
    - Does **not** use Baileys' own `sock.logout()` (which resolves on a WebSocket write flush, not an IQ ack, and sends nothing at all when `creds.me` is unset). Instead sends a raw `remove-companion-device` IQ via `sock.query(...)` with an 8s timeout (`BAILEYS_LOGOUT_ACK_TIMEOUT_MS`), chosen to be above typical round-trip but under the service's 10s teardown deadline.
    - On a falsy/empty query response, throws ("WhatsApp did not acknowledge the unlink request") — a resolved-but-empty promise proves nothing.
    - On success: `localSocketShutdown(sourceSock)`, clears the message store session, and `clearAuthState()` (wipes the multi-file auth dir) — a failure here propagates (rethrows), since completion requires cleanup.
    - On **any** failure (missing identity, query rejection/timeout, empty response, or a later auth-removal failure): still calls `localSocketShutdown(sourceSock)` so no orphaned engine/socket is left after the service evicts on a 502 — but does **not** clear auth state, since the link may still be valid server-side and creds are needed to retry.
  - `localSocketShutdown(sourceSock)`: identity-safe helper — clears the reconnect timer, ends the socket, clears `liveCalls`, sets `DISCONNECTED`, and nulls `this.sock` **only if it still points at `sourceSock`** (a concurrent reconnect may have already swapped in a fresh socket).
  - `handleRemoteLoggedOut()`: handles a server-pushed 401 close.
    - Performs status/socket/`liveCalls` teardown **synchronously, before any await**, so the session watchdog never observes a READY socket that's already dead.
    - Then asynchronously `clearAuthState()` — required because Baileys would otherwise reload the now-invalid creds on the next connect and silently retry them instead of emitting a fresh QR (session stuck with no QR). On cleanup failure: `FAILED` + `onError` (not treated as a clean disconnect, since creds weren't actually wiped). On success: `onDisconnected('logged out')`.
    - Registers the destructive cleanup promise via `onCredentialTeardownStarted` the instant it begins (not gated on the engine still being live) — the `rm` targets the session NAME's auth dir and would otherwise race a session recreated under the same name.
  - `clearAuthState()`: `fs.promises.rm(authPath, { recursive: true, force: true })`. Logs and **rethrows** on failure — both the logout-success path and the remote-logout path require this cleanup to complete, so a failure must propagate rather than be swallowed.
  - `destroy()` / `forceDestroy()`: `destroy()` mirrors `disconnect()`. `forceDestroy()` is just `destroy()` — no separate process to SIGKILL.
  - `getStatus()`, `getQRCode()`, `getPhoneNumber()`, `getPushName()`: plain getters.
  - `probeLiveness()`: cheap local check (`status === READY && sock != null`) for the watchdog — genuine dead-connection detection is left to Baileys' own keepalive (surfaces as a close within ~35s). Documented caveat: status can trail the real dead transport by up to Baileys' 30s close timeout on a black-holed socket; acceptable for a periodic watchdog, explicitly **not** sufficient for a request guard (hence `requestPairingCode` checks `ws.isOpen` directly).
  - `requestPairingCode(phoneNumber)`: gated on **both** `QR_READY` status AND `sock.ws.isOpen` — not status alone, because `this.sock` is assigned the moment `makeWASocket` returns (before the WebSocket is actually open), and a stale QR_READY status can persist up to ~30s after the connection actually died. This matters specifically because `requestPairingCode` writes `creds.me` and emits `creds.update` (persisted) *before* it sends — a request in the stale window would leave the next connect attempt trying to log in as a never-registered device.
  - `ensureReady()`: throws `EngineNotReadyError` unless `status === READY && sock`.
  - `setStatus(status)`: the single funnel for all status transitions. No-ops if unchanged (so Baileys' duplicate close events per drop don't flap `onStateChanged`). Clears the cached QR code whenever the new status isn't `QR_READY` — centralized here (rather than at each call site) specifically because every close branch, the accepted-link path, and every teardown route through here, and some previously forgot to clear it by hand, serving a dead QR over `GET /qr` for the whole reconnect backoff.
- No NestJS decorators — plain class, constructed by `BaileysAdapter`.

---

##### `src/engine/adapters/baileys-events.ts`
Handles all inbound socket events: message upsert/update processing (including the live-vs-history discriminator, media download capping, protocol-message/reaction routing), group membership/metadata events, call events (with a live-call cache backing `rejectCall`), and presence updates. Implements the inbound half of `MessagingCapability`/`CallCapability`/`PresenceCapability`/`GroupCapability` event plumbing (consumed by `BaileysAdapter` via forwarding).

- **`CALL_OUTCOMES`**: maps only the three consumer-meaningful Baileys call statuses (`accept`→`accepted`, `reject`→`rejected`, `timeout`→`missed`) — everything else (`ringing`, `preaccept`, `transport`, `relaylatency`) is transport chatter, and `terminate` is deliberately excluded (ambiguous: could mean caller hung up before answer, or either side ended an answered call — no way to distinguish).
- **`PRESENCE_STATES`**: an allowlist (`available`, `unavailable`, `composing`, `recording`, `paused`) of presence states this adapter will forward — an unknown state added upstream is dropped rather than published to a public webhook payload as if understood.
- **`interface BaileysEventsHost`**: narrow surface — socket getters, `toNeutralJid`/`normalizedSelfJid`, `loadLib`, `connectedAt`, `inboundLimiter`, lid-mapping/message-store write hooks, and getters for every message/group/call/presence callback.
- **`class BaileysEvents`**
  - `LIVE_CALL_TTL_MS = 2 minutes` — covers the ~1-minute ringing window with margin.
  - `liveCalls: Map<callId, {callFrom, expiresAt, from, isVideo, isGroup}>` — public readonly field, owned here; cleared by the lifecycle delegate on any teardown.
  - **`handleMessagesUpsert(event)`**: iterates `event.messages`, skipping protocol/empty messages (no `message` or no `key.remoteJid`). For `event.type !== 'notify'` (i.e. history-tagged batches):
    - Own messages (`fromMe === true`) are **unconditionally** skipped — Baileys echoes back the adapter's own just-sent messages through this same 'append' path, and `sendContent()` already emits `onMessageCreate` for those via `emitOwnSendEcho()`, so this avoids a double-fire.
    - Other messages are filtered by **timestamp vs. `connectedAt`**, not by the batch's `type` tag — documented quirk: Baileys can tag a genuinely new customer message `'append'` when it arrives in the same window as a reconnect's state-sync handshake, so a strict `type !== 'notify'` filter would silently drop "the first message after a reconnect." A message timestamped after the connection opened is treated as live regardless of its batch tag.
    - Each surviving message is submitted to `inboundLimiter.run(() => processInboundMessage(msg))` — throttles concurrent downloads without capping the (unbounded) queue. On rejection, distinguishes a limiter-closed-during-teardown error (orderly) from a genuine download failure (logged differently) and reprocesses the same message with `{skipMedia: true}` so the body/metadata still gets emitted even if media is lost.
  - **`logContactEvent(event, records)`**: diagnostic-only debug log (counts, name/lid presence, small sample) for `contacts.upsert`/`contacts.update`.
  - **`processInboundMessage(msg, opts)`** (private): the core per-message pipeline, wrapped in try/catch that logs-and-drops on any unhandled error (never throws out of the event handler):
    1. `recordKeyLidMappings(msg.key)` — learns any lid↔pn pair from the key *before* canonicalizing ids, so a fresh `@lid` sender resolves to its phone within this very message.
    2. `normalizeMessageContent` + `getContentType` on the normalized root — necessary because a disappearing/viewOnce/documentWithCaption/edited message arrives wrapped, and the raw `getContentType` would return the outer wrapper key, breaking downstream type/body/media/location detection. `normalizeMessageContent` is documented to leave `protocolMessage`/`reactionMessage` untouched, so the early-return branches below still match correctly.
    3. **`protocolMessage` / REVOKE**: builds a `RevokedMessage` (swapping from/to based on `fromMe`) and fires `onMessageRevoked`, returns — never emits `onMessage`.
    4. **`protocolMessage` / MESSAGE_EDIT**: normalizes the *inner* `editedMessage` separately (so caption/type/PTT/mentions reflect the edited value, not the envelope), builds an `EditedMessage` via `buildEditedMessage`, calls `recordMessageEdit` and fires `onMessageEdited`, returns.
    5. Other protocol messages: silently skipped.
    6. **`reactionMessage`**: builds a `ReactionEvent` and fires `onMessageReaction`, returns — never emits `onMessage`.
    7. **Normal message**: calls `mapMessage(...)`, routes to `onMessageCreate` (if `fromMe`) or `onMessage` otherwise, persists via `putStoredMessage` (best-effort, logged on failure), and calls `recordMessage` to seed the chat's last-message preview.
  - **`handleMessagesUpdate(updates)`**: maps each update's numeric Baileys ack status through `mapBaileysStatus` and fires `onMessageAck(id, status)`.
  - **`handleGroupParticipantsUpdate(event)`**: maps `action: 'add'`→`'join'`, `'remove'`→`'leave'`; **promote/demote/'modify' (phone-number-change rewrite) are skipped** — they change no membership. No timestamp in the source event, so it's stamped at receipt. Actor preference: `authorPn` over `author` (phone-dialect twin preferred so the neutral actor id doesn't depend on whether the lid→pn mapping has been learned yet). Participant entries are coerced via `toNeutralGroupParticipantId`.
  - **`handleGroupJoinRequest(event)`**: only `action === 'created'` maps to the neutral `join_request` kind. Documented upstream scope gap: the underlying Baileys version (rc13) only emits this event from the NON_ADMIN_ADD stub; the direct self-request stub is unhandled upstream (a TODO in Baileys itself), so an invite-link self-request may produce no event here even though the REST list endpoint still sees it.
  - **`handleGroupsUpdate(updates)`**: maps `subject`/`desc`/`announce`/`restrict` fields to a neutral `changes` object (`description`, `locked`, etc.) per update, emitting a `'update'` GroupEvent even for unmodeled fields (empty `changes`) for parity with the wwebjs adapter. **Critical filter**: skips entries carrying full-metadata snapshot markers (`participants`/`creation`/`subjectTime`/`owner`/`size` keys) — because `groupFetchAllParticipating()` (called on every connect via `hydrateNames` and every `GET /groups`) emits its *entire* result set through this same `groups.update` event, and without this filter every reconnect/list-call would flood consumers with bogus `group.update` webhooks fabricated from the snapshot rather than real deltas.
  - **`handleCallEvents(calls)`**: only `status === 'offer'` is treated as a new incoming call; anything else delegates to `reportCallOutcome` and continues. Further filters before publishing an offer:
    - `call.offline === true` → dropped (Baileys replays missed-while-disconnected offers; these are long-dead and must not be published as fresh, nor auto-rejected).
    - Self-originated calls (from/chatId matches own normalized jid) → dropped (WACallEvent has no `fromMe` flag, so this reproduces the wwjs adapter's equivalent guard; null-safe when there's no socket user yet).
    - De-duplication via `cacheLiveCall`: Baileys maps both the `offer` and `offer_notice` wire tags to status `'offer'` with the same call id, so the same call can reach this loop twice — only an id not already cached triggers `onCall`.
    - `callerPn` preferred over `call.from` for the published `from` (same lid/pn-twin preference pattern as groups).
  - **`reportCallOutcome(call)`** (private): handles non-offer statuses.
    - `status === 'terminate'`: publishes **no** outcome (ambiguous, see `CALL_OUTCOMES` doc) but still evicts the live-call handle so a later `rejectCall` correctly reports not-found.
    - Other unmapped statuses (`ringing`/`preaccept`/`transport`/`relaylatency`): the handle is left live (call is still ringing).
    - Mapped statuses: evicts the handle, skips if `call.offline` (same stale-replay hazard as the offer path), skips if there's no cached `live` entry (an outcome for a call this session never saw ring isn't actionable — belongs to another device or predates the connection), otherwise fires `onCallOutcome`.
  - **`handlePresenceUpdate(update)`**: builds a per-participant `ParticipantPresence[]` from `update.presences` (preserved as a map shape even for 1:1 chats, which carry exactly one entry) — entries with no `lastKnownPresence` or an unrecognized state (not in `PRESENCE_STATES`) are dropped rather than guessed as `unavailable`. `lastSeen` is included only when numeric/finite — absence (common, due to the contact's privacy settings) is not substituted with a guess. Both chat and participant ids are neutralized.
  - **`cacheLiveCall(callId, callFrom, published)`** (private): lazy-expiry insertion — sweeps already-expired entries on every insert rather than using per-entry timers, so a session that never rejects calls can't leak memory unbounded. Returns `true` only if the call id wasn't already cached (drives the dedup in `handleCallEvents`); a repeat offer still refreshes the TTL.
  - **`rejectCall(callId)`**: public forwarder target for `IWhatsAppEngine.rejectCall`. Evicts the cache entry on **any** attempt (so a call can't be rejected twice). Throws `CallNotFoundError` (404) for an unknown/expired id, `EngineNotReadyError` if there's no live socket. Calls `sock.rejectCall(...)` under `withQueryDeadline`, then — notably — **synthesizes and fires `onCallOutcome` itself** with `outcome: 'rejected'`, since a self-initiated rejection produces no corresponding inbound signal to observe; the cache is already evicted so a later server echo can't double-publish.
  - **`toNeutralGroupParticipantId(entry)`** (private): handles both the pre-v7 plain-string participant shape and the v7+ parsed-object shape (`{id, phoneNumber?, lid?}`), preferring `phoneNumber` > `id` > `lid` in that order.
  - **`downloadInboundMediaCapped(msg, maxBytes)`** (private): streams media via `downloadMediaMessage(msg, 'stream', ...)` (not the raw `downloadContentFromMessage`, to preserve Baileys' expired-media re-upload retry), accumulating chunks but **aborting** (`stream.destroy()`, return `null`) once the running total exceeds `maxBytes` — so an over-cap blob is never fully materialized in heap even if the sender understated the declared size. Wrapped in `withInboundDownloadTimeout` so a slow/trickling sender that never trips the byte cap can't pin a concurrency slot (and the whole inbound handler) indefinitely.
  - **`resolveInboundMedia(...)`** (private): the policy layer in front of the above.
    - Non-media content types short-circuit to `undefined`.
    - `skipMediaDownload` (set specifically for the adapter's own-send echo path, since the API caller already holds the media) or media downloads globally disabled → returns an "omitted" media marker with pre-download-available metadata (mimetype, filename, declared size) — documented as the one place Baileys deliberately diverges from the wwebjs adapter, whose echo *does* re-download (it has no other source for phone-composed sends).
    - **Pre-download size gate**: if the declared `fileLength` exceeds `inboundMediaMaxBytes()`, skip the download entirely (never decrypted into heap) and return the omitted marker — relies on Baileys' own integrity check against declared size.
    - Otherwise: stream-downloads via `downloadInboundMediaCapped`; a `null` result (cap/timeout abort) again yields an omitted marker; a download exception is caught and yields `undefined` media (never propagates as a throw) — so a media failure never loses the rest of the message.
  - **`mapMessage(msg, contentType, opts)`** (public — also exposed through the adapter host for the messaging delegate's own-send echo): normalizes content, extracts `body` (text, then media caption, then WhatsApp Business interactive shapes), `location`, `media` (via `resolveInboundMedia`), and `context` (quote, disappearing-timer, mentions, status styling — all from one content region per `BaileysMessageContext`), then calls `buildIncomingMessageFromBaileys`.
  - **`toEditUnixSeconds(timestampMs, fallback)`** (private): protocol-message edit timestamps are **milliseconds** while the enclosing message timestamp is seconds — handles both plain `number` and Baileys' `Long`-like `{toNumber()}` shape.
- No NestJS decorators.

---

##### `src/engine/adapters/baileys-messaging.ts`
Implements every outbound send operation — text, media (image/video/audio/document/sticker/location/contact/poll/product), reply/forward/react/delete/star/pin/unpin/edit, chat-state/presence, number lookup, and call-link creation. This is the `MessagingCapability`/`MessageOperationsCapability` outbound implementation consumed by `BaileysAdapter` via forwarding.

- **`isWebpBuffer(data)`** (private helper): sniffs `RIFF....WEBP` magic bytes directly, because a caller-declared mimetype label can't be trusted.
- **`toWebpSticker(data, mimetype)`**: converts arbitrary image bytes to a real WebP sticker via `sharp`.
  - Documented defect this guards against: Baileys' `prepareWAMessageMedia` stamps `mimetype: 'image/webp'` on any sticker send **unconditionally** without transcoding, so a PNG handed to the raw library would be published as a stickerMessage whose declared type contradicts its actual bytes, with the send still reporting success. (Contrast: whatsapp-web.js's `sendMediaAsSticker` actually converts via `Util.formatToWebpSticker` and throws for non-images.)
  - Already-WebP input passes through **byte-identical** (no re-encode) — re-encoding would strip WebP EXIF sticker-pack metadata and change file size.
  - Non-image mimetype → `BadRequestException` (400), deliberately **not** `EngineNotSupportedError` — the capability is supported, just not for this payload; a 501 here would also incorrectly look "unavailable" to an automated parity gate that scans for thrown capability errors.
  - `sharp(data, { animated: true })` — the `animated: true` flag is load-bearing, not optional: without it sharp silently keeps only the first frame of an animated source, reintroducing exactly the quiet corruption this function exists to prevent.
  - Decode failures also become `BadRequestException` (refuse before the socket rather than ship mislabelled bytes).
- **`resolveMediaBuffer(media: MediaInput)`** (exported function): resolves a `MediaInput`'s `data` (Buffer | base64 string | http(s) URL) to raw bytes + mimetype. For URL input, fetches via `loadRemoteMediaBuffer` and **prefers the fetched response's sniffed content-type** over the caller's declared mimetype when the caller's is the generic placeholder `application/octet-stream` — fixes URL-based sends from callers with no real mimetype to pass (e.g. a Chatwoot outbound relay).
- **`interface BaileysMessagingHost`**: socket/ensureReady/JID-translation accessors, `getEphemeralExpiration`, `toUnixSeconds`, `loadLib`, message-store put/get, `recordLidMapping`, `onMessageCreate` getter, and `mapMessage` (the events delegate's inbound mapper, reused here for the own-send echo).
- **`class BaileysMessaging`**
  - `confirmed(work, operation)`: wraps a promise in `withQueryDeadline` using the configurable `queryBudgetMs` (defaults to `BAILEYS_QUERY_BUDGET_MS`) — used for writes whose confirmation the raw library would otherwise silently discard.
  - `sendTextMessage(chatId, text, mentions?, sendOptions?)`:
    - Resolves the deliverable JID via `toDeliverableJid` (see below).
    - **Always** passes a custom `getUrlInfo: generateSafeLinkPreview` — replaces Baileys' built-in link-preview generator, which delegates to a package carrying an **unfixed SSRF advisory**. Passed on *every* text send (not only when a preview is requested) so the vulnerable generator path is categorically unreachable.
    - **Link previews are opt-in** on this engine: only `linkPreview: true` omits the `linkPreview` key (letting the safe generator run); the default is `linkPreview: null` (Baileys' explicit "no preview"). Rationale documented in comments: without this, Baileys' default behavior on seeing a `text` field with no explicit `linkPreview` key is to call the configured generator — meaning a blocking outbound fetch (up to 3s, uncached) of every URL in the text before the send completes, which would stall bulk-campaign sends on a single dead/slow URL in a template.
    - `customPreview` (caller-supplied) short-circuits generation entirely by setting `linkPreview` directly to the caller's metadata.
    - On success: persists via `putStoredMessage` (best-effort) and fires `emitOwnSendEcho` for wwjs parity (`message_create` → `message.sent`).
  - `checkNumberExists(number)` / `getNumberId(number)`: `getNumberId` calls `sock.onWhatsApp(number)` and explicitly distinguishes `undefined` (query went unanswered — Baileys' own `query()` swallows timeouts rather than throwing) from an empty array (a real "not found" answer) — throws `EngineTransportError` for the former rather than silently treating "we never heard back" as "not on WhatsApp." Result jid is neutralized before returning.
  - `sendChatState(chatId, state)`: maps `typing`→`composing`, `recording`→`recording`, else `paused`; **best-effort** — failures are caught and logged, never thrown, mirroring the wwebjs adapter (a migrated/lid contact can fail presence even when the actual message send would succeed).
  - `setOnlinePresence(available)`: the account's **global** presence (no-jid form). Unlike `sendChatState`, failures **propagate** — the caller asked for a specific visibility and a silent swallow would leave the account unexpectedly online (#871).
  - `subscribeToPresence(chatId)`: also **not** best-effort — a failed subscription should surface so the caller knows updates will never arrive.
  - `sendProductMessage(chatId, product, body?)`: builds a `{product}` content block (price in thousandths via `priceAmount1000`); requires `product.imageUrl` (`BadRequestException` otherwise — a product card needs an image). Documented as the only native-product-card send Baileys supports (no catalog-lookup-then-send helper exists).
  - `sendImageMessage` / `sendVideoMessage` / `sendAudioMessage` / `sendDocumentMessage`: each resolves the media buffer, builds the corresponding content object (with mentions and quote options), and delegates to `sendContent`.
    - Audio notably still forwards `mentions` despite having no caption/visible text — tags the recipient via contextInfo without visible `@text`; documented as intentionally kept so the same request doesn't silently diverge in behavior between engines.
  - `createCallLink(type, startTime)`: resolves only the bare token via `sock.createCallLink`, then prefixes with the library's `CALL_VIDEO_PREFIX`/`CALL_AUDIO_PREFIX` constant. Double-guarded against a silently-unanswered query (`this.confirmed` wraps it on top of the library's own internal timeout, since Baileys' `query()` swallows its own timeout). An empty token throws `EngineRefusedError` — a bare prefix with nothing after it is a dead link that *looks* like a real one.
  - `sendStickerMessage(chatId, media)`: converts via `toWebpSticker` before sending; also forwards mentions (same contextInfo rationale as audio).
  - `sendLocationMessage`, `sendContactMessage` (via `buildVCard`), `sendPollMessage` (`selectableCount`: `0` = multi-answer, `1` = single-choice — note `0` means *unlimited*, not *none*): straightforward content builders through `sendContent`.
  - `replyToMessage(chatId, quotedMsgId, text, mentions?)`: resolves the quoted message via `requireStored`, then **explicitly checks** `assertStoredInChat` — documented as "the one `requireStored` path that had no chat check" before this was added: whatsapp-web.js 404s a reply whose quoted id isn't in the named chat, while the raw Baileys library just encodes the (possibly foreign) chat into contextInfo without rejecting, so this adapter is the only guard keeping behavior consistent with the other engine. Deliberately **not** applied to the generic `quoteOption` path used by `send*Message`'s `quotedMessageId` — cross-chat quoting on those routes is an intentional, documented feature.
  - `forwardMessage(fromChatId, toChatId, messageId)`: same `assertStoredInChat` guard against `fromChatId` — previously `fromChatId` was accepted and silently ignored, letting any chat's message id forward successfully where wwebjs would 404.
  - `reactToMessage`, `deleteMessage` (forEveryone vs. delete-for-me via `chatModify({deleteForMe:...})`), `editMessage`: all resolve+validate the stored message via `requireStored`/`assertStoredInChat` first.
    - `editMessage` additionally refuses (via `EngineRefusedError`) editing a message where `target.key.fromMe !== true` — WhatsApp silently rejects edits of inbound messages while still resolving the send call, which would otherwise look like success and let the service layer "update" the stored body of something that was never actually edited.
  - `withMentions(mentions)` (private): builds `{mentions}` content slice, de-normalizing neutral `@c.us` ids to engine dialect; returns `{}` (not `{mentions: []}`) when empty, to keep content byte-identical to pre-mentions-feature sends.
  - `toDeliverableJid(chatId)` (private): for 1:1 phone-dialect chat ids only (passes groups/broadcast/already-lid/unmapped through unchanged), resolves to the contact's `@lid` via `sock.signalRepository.lidMapping.getLIDForPN` when known. Documented root cause: WhatsApp rejects PN-addressed 1:1 sends to LID-migrated accounts with ack error 463 ("missing tctoken"), while the identical send addressed to the LID delivers (verified live) — this was the resolution Baileys itself just performed, so it's written back via `recordLidMapping` as a side effect, since this is "the one place a cold contact's lid becomes known before any message arrives." Best-effort: resolution failures fall back to the original chatId.
  - `withEphemeral(chatId, options?)` (private): folds the chat's cached disappearing-messages timer into send options (`#473`). Omits the key entirely when unknown (rather than, say, `0`) because Baileys' send guard treats the key as truthy-gated — an unknown/boot-window/stale-empty cache must never force a message to vanish. Explicitly **not** applied to react/delete/status sends (they don't route through this helper).
  - `previewSafe(content)` / `previewSafeOptions(content, options?)` (private): the same SSRF-mitigation pattern as `sendTextMessage`, applied to every *other* text-bearing send path (reply/edit/etc.) that goes through `sendContent` — documented as previously unguarded, meaning a reply or edit containing a URL used to trigger the vulnerable generator.
  - `sendContent(chatId, content, options?)` (private): the shared send path for all non-text-message sends — resolves deliverable JID, applies `previewSafe`/`previewSafeOptions`/`withEphemeral`, calls `sock.sendMessage`, persists + fires `emitOwnSendEcho` on success.
  - `emitOwnSendEcho(sent)` (private): fires `onMessageCreate` for the adapter's own just-sent message, for parity with wwebjs's `message_create`→`message.sent`. Best-effort (catches and logs, never fails the already-succeeded send). Explicitly passes `skipMediaDownload: true` to `mapMessage` — unlike wwebjs's echo (which re-downloads), this engine's API caller already holds the payload and the REST layer already persisted it, so re-downloading would be pure waste. Skips protocol/reaction/no-content-type messages (nothing neutral to emit).
  - `quoteOption(quotedMessageId?)` (private): resolves an id to Baileys' `{quoted: WAMessage}` option via `requireStored`. An **unresolvable** quote id is a hard failure (`MessageNotFoundError`), not a silent unquoted send — documented rationale: a plain message delivered under the name of "a reply" would be the wrong result reported as success.
  - `requireStored(messageId)` / `assertStoredInChat(target, chatId, messageId)` (private): shared lookup + ownership-check helpers used throughout — a stored key belonging to a different chat is treated as not-found (`MessageNotFoundError(messageId, chatId)`), not acted upon, to prevent cross-chat writes (pin/star applied to the wrong conversation) from silently succeeding. Both sides are neutralized for comparison so `@c.us`/`@s.whatsapp.net`/lid twins compare equal.
  - `starMessage(chatId, messageId, star)`: `fromMe` is load-bearing in the `chatModify({star:...})` call — same message id can address a different message depending on direction. Also folds the chat id to engine dialect first (`chatModify` indexes the star app-state by raw jid with no normalization, unlike the send path — a neutral `@c.us` would silently star nothing).
  - `pinMessage(chatId, messageId, durationSeconds)` / `unpinMessage`: deliberately use `sock.sendMessage({pin: ..., type: PinInChat.Type...})`, **not** `chatModify({pin})` — the latter pins the *chat itself* in the chat list, an unrelated feature sharing the same word. `durationSeconds` is cast to the three WhatsApp-recognized window literals (`86400 | 604800 | 2592000`) since the DTO already validates the value upstream. `unpinMessage` omits `time` entirely (meaningless for an unpin) rather than sending a dummy value.
- No NestJS decorators.

##### Support delegates and infrastructure

##### `src/engine/adapters/baileys-host.ts`
Defines the single combined "host" type handed to every Baileys delegate class, mirroring the whatsapp-web.js adapter's equivalent pattern.
- `BaileysEngineHost` (type) — intersection of every per-delegate host interface (`BaileysEventsHost`, `BaileysGroupsHost`, `BaileysMessagingHost`, `BaileysContactsHost`, `BaileysStatusHost`, `BaileysChannelsHost`, `BaileysCatalogHost`, `BaileysHistoryHost`, `BaileysLifecycleHost`). `BaileysAdapter` builds one object literal satisfying this type and injects it into each delegate's constructor, so a new cross-cutting member (e.g. a jid helper) is added once instead of duplicated across up to eight delegate-specific host literals.
- Each delegate still declares its own narrow `Host` interface (least privilege: a delegate's type signature only exposes what it is allowed to touch); the shared literal satisfies all of them structurally.
- Not itself a capability implementation — pure wiring/DI-shape glue internal to the Baileys adapter, not part of `IWhatsAppEngine`.

##### `src/engine/adapters/baileys-logger.ts`
Builds the `pino`-shaped logger objects handed to the Baileys socket constructor, controlling how much of Baileys' own internal wire/debug chatter is surfaced.
- `createSilentLogger()` — returns a fully no-op logger (`level: 'silent'`, all methods no-ops, `child()` returns itself). Used so Baileys never spams stdout directly; OpenWA's own diagnostics flow through `connection.update` events instead.
- `createBaileysLogger()` — reads `BAILEYS_LOG_LEVEL` env var (`trace|debug|info|warn|error`, case-insensitive); falls back to `createSilentLogger()` if unset/invalid. When a valid level is set, emits JSON lines to stdout tagged `context: 'baileys-wire'` for every log at or above the threshold — independent of the app's own log level — so a run can be captured separately (e.g. `BAILEYS_LOG_LEVEL=trace node dist/main > baileys-wire.log`). At `debug`/`info` this surfaces history/app-state sync decisions; at `trace`, raw decoded WA wire frames.
- Pure infrastructure, not an `IWhatsAppEngine` capability.

##### `src/engine/adapters/baileys-query-deadline.ts`
Provides OpenWA-owned timeout machinery for Baileys calls whose outcome cannot otherwise be determined, because Baileys' internal `query()` swallows its own timeout and resolves `undefined` instead of throwing.
- `withQueryDeadline<T>(work, timeoutMs, detail)` — races a promise against a `setTimeout` that rejects with `EngineTransportError(detail)`; the timer is `unref()`'d and cleared in a `finally`. The abandoned original promise is NOT cancelled (Baileys' own 60s clock still runs it to completion internally) — a `.catch(() => undefined)` defuses any late rejection so it can't surface as an unhandled rejection. Deliberately not applied where an unanswered query drives a *loop* (e.g. `resyncAppState`), since a deadline there would hide a leak rather than stop it.
- `BAILEYS_QUERY_BUDGET_MS` (const, `30_000`) — the default per-call budget for a single bounded Baileys read/write, anchored to the repo's existing `MEDIA_DOWNLOAD_TIMEOUT_MS` figure. Must stay under Baileys' own 60s `defaultQueryTimeoutMs` (to be observable at all) and under `session.proxyTimeoutMs` (so a multi-node deployment doesn't race two deadlines). Trade-off called out explicitly: a slow-but-eventually-successful write will be reported "unconfirmed" even though it may land — deliberate, since every write bounded by this is safe to repeat.
- Used throughout the Baileys group/contacts/channels/catalog/status delegates for any write whose confirmation Baileys discards (group settings, participant updates, profile writes, etc.).
- Not a capability itself — cross-cutting reliability infrastructure.

##### `src/engine/adapters/baileys-group-mapper.ts`
Pure mapping functions from Baileys' `GroupMetadata` wire shape to OpenWA's neutral `Group`/`GroupInfo` shapes (part of `GroupCapability`'s data model).
- `preferPhoneDialect(jid, phoneTwin, normalizeJid)` (function) — for a LID-addressed group, Baileys hands back `<lid>@lid` as a participant/owner id but *also* supplies the phone-dialect twin alongside it (`participant.phoneNumber`, `metadata.ownerPn`). Prefers the phone twin (normalized) over resolving the lid through the mapping cache, since the twin is already correct even before a lid→phone mapping has been learned; falls back to normalizing the lid itself when no twin is present (the ordinary case for non-contacts, since WhatsApp withholds `phone_number` for them).
- `isSelfAdmin(metadata, selfJid, normalizeJid)` (function) — determines whether the account itself (`selfJid`) is `admin`/`superadmin` in the participant list, comparing user-parts after phone-dialect resolution.
- `mapBaileysGroup(metadata, selfJid, normalizeJid?)` — maps to the neutral `Group` summary shape (id, name, participant count, `isAdmin`, `linkedParentJID`). `normalizeJid` defaults to identity for pure-shape testability; the adapter supplies the session-store-backed normalizer in production.
- `mapBaileysGroupInfo(metadata, normalizeJid?, selfJid?)` — maps to the full `GroupInfo` shape including the participant list. Notable quirks documented inline:
  - `isAnnounce` reports the raw WA group *setting*; `isReadOnly` reports what that setting means for *this* account (computed as `announce && !isSelfAdmin`), matching how whatsapp-web.js reports a per-account composer-disable flag — copying `announce` into both fields would wrongly tell an admin of an announce-only group that they can't post.
  - `memberAddMode`: Baileys' boolean `memberAddMode` is `true` meaning "all members may add" — the *opposite* sense from how whatsapp-web.js's types describe the same boolean, so it's explicitly remapped to the `'all' | 'admins'` neutral literal rather than passed through.
- Implements part of `GroupCapability`'s shape mapping (consumed by `baileys-groups.ts`).

##### `src/engine/adapters/baileys-groups.ts`
Implements all group-domain operations extracted from the `BaileysAdapter` god object — the `GroupCapability` slice of `IWhatsAppEngine`.
- `BaileysGroupsHost` (interface) — narrow host surface: `ensureReady()`, `getSocket()`, `logger`, `toNeutralJid`/`toEngineJid`, `normalizedSelfJid()`.
- `refusedStatusCode(error)` — extracts a WA server-refusal numeric code from a Baileys error. Relies on the fact that `query()` always runs `assertNodeErrorFree` before resolving, so any refusal that reaches a caller already carries a numeric `data` (the WA error code) on the thrown Boom. Documents a historical bug: a second branch that read `output.statusCode` was removed because Boom's constructor always defaults `data` to `null` (never `undefined`), so the old guard was always true and caused transport failures (e.g. "Connection Closed" → statusCode 428) to be misreported as permission errors (`403 admin rights...`). Only decodes the IQ error channel — WhatsApp's `w:mex` surface (used by channels) reports refusals differently; see `wmexRefusalCode` in `baileys-channels.ts`.
- `mapServerRefusal(operation, op, classify?)` — runs a socket write and converts a 4xx-class WA refusal into `EngineRefusedError` (HTTP 403, matching whatsapp-web.js's convention for the same causes); transport/local failures propagate untouched. Used by nearly every write in this file.
- `toEngineParticipants(participants, toEngineJid)` — folds neutral `@c.us` participant ids to the engine wire dialect (`@s.whatsapp.net`) before a group write, via `toParticipantWid` (bare numbers are qualified first — `toEngineJid` only folds an already-domained id, and Baileys' encoder writes a bare un-domained string as a packed nibble instead of a proper JID_PAIR, silently dropping the write).
- `MEMBERSHIP_REQUEST_METHODS` (const array) — the neutral membership-request method vocabulary (`invite_link`, `non_admin_add`, `linked_group_join`); Baileys' wire tokens already match this vocabulary.
- `BaileysGroups` (class) — constructed with `(host, queryBudgetMs = BAILEYS_QUERY_BUDGET_MS)`. Key methods:
  - `getGroups()` — `groupFetchAllParticipating()`, bounded by `withQueryDeadline` since an unanswered query and a zero-groups account both yield `{}`.
  - `getGroupInfo(groupId)` — returns `null` only on a SERVER refusal (401/403/404); any other failure (transport/timeout) propagates rather than being folded into "not found".
  - `createGroup(name, participants)` — deliberately **NOT** deadline-bounded (unlike its neighbors): creation is non-idempotent, and abandoning-without-cancelling could let a slow-but-succeeding create complete multiple times if retried, leaving duplicate groups.
  - `addParticipants`/`removeParticipants`/`promoteParticipants`/`demoteParticipants` — all delegate to `runParticipantsUpdate(groupId, participants, action)`, which maps Baileys' per-participant `[{status, jid}]` result verbatim into `ParticipantOperationResult[]`, throwing `EngineRefusedError` only when the operation failed for *every* participant or returned no outcome at all (a batch-level refusal, separate from a per-participant one). Documents a prior bug where this call bypassed `mapServerRefusal`, letting a batch-level refusal escape as a 500 instead of the 403 its sibling operations give.
  - `leaveGroup`, `setGroupSubject`, `setGroupDescription`, `setGroupMessagesAdminsOnly`, `setGroupInfoAdminsOnly`, `setGroupPicture`, `deleteGroupPicture`, `setGroupMemberAddMode`, `setGroupEphemeral` — all thin, deadline-bounded, refusal-mapped wrappers over the corresponding Baileys socket calls.
  - `getGroupInviteCode` / `revokeGroupInviteCode` — surface both failure shapes distinctly: a refusal (Boom w/ WA code, e.g. non-admin) vs. an unanswered query (would otherwise coalesce to an empty string producing the meaningless link `"https://chat.whatsapp.com/"`).
  - `getGroupJoinInfo(inviteCode)` — read-only preview from an invite code; throws `GroupNotFoundError` on a 4xx refusal or a missing `meta.id`. Deliberately drops the participant list even when Baileys provides it, since a preview is a *count*, and leaking a full roster for a group not yet joined says more than the other engine (whatsapp-web.js) can.
  - `joinGroupViaInviteCode(inviteCode)` — must apply its *own* deadline: an unanswered query resolves `undefined` from Baileys exactly like a genuinely bad/expired code, so without the clock both cases would wrongly look identical (OK per the method's contract, which requires distinguishing a dead transport from an actually-refused invite).
  - `getGroupMembershipRequests`, `approveGroupMembershipRequests`, `rejectGroupMembershipRequests` — list/approve/reject pending join requests; `runMembershipRequestsUpdate` enumerates the pending queue itself when the caller omits a participant list (Baileys has no act-on-all form), treating an empty queue as a legitimate no-op (`[]`) rather than a refusal.
- Implements `GroupCapability`.

##### `src/engine/adapters/baileys-history.ts`
Implements the Baileys-side half of history sync and post-connect name backfill — supports `ChatHistoryCapability` (bulk history ingestion) and contact/chat name hydration.
- `BaileysHistoryHost` (interface) — `getSocket()`, `logger`, `toNeutralJid`, `normalizedSelfJid()`, `loadLib()` (lazy ESM Baileys import), `recordMessage(msg)`, `upsertContacts`/`upsertChats`, `extractEphemeralDuration(msg)`, `getOnHistoryMessages()`.
- `toUnixSeconds(ts)` — normalizes Baileys' `number | Long`-typed timestamps to unix seconds.
- `BaileysHistory` (class):
  - `captureHistoryMessages(messages)` — persists the bulk `messaging-history.set` push Baileys fires on connect (the only pre-connection history source). For each message: harvests `pushName` into a contact-name update (history `contacts` records carry no names themselves), seeds the chat's last-message preview/sort time via `recordMessage` (so history-only chats don't read "No messages yet"), and media-free-maps the message via `mapHistoryMessage`. Dispatches the batch through the `onHistoryMessages` callback (not the live per-message dispatch path).
  - `hydrateNames()` — best-effort post-connect backfill for when Baileys 6.7.x skips/fails its initial app-state/push-name sync (names never arrive). Two independent, non-fatal steps: (1) fetch group subjects via `groupFetchAllParticipating()` (reliable) and `upsertChats` them, bounded by `withQueryDeadline` since an unanswered query and a zero-groups account are indistinguishable without an owned clock; (2) best-effort re-trigger `resyncAppState(ALL_WA_PATCH_NAMES, false)`. DM push-names still arrive separately via live `contacts.update` events.
  - `mapHistoryMessage(b, msg)` (private) — media-free `WAMessage → IncomingMessage` mapping (downloading media for thousands of history messages would be ruinous memory/bandwidth-wise; type is kept, payload dropped). Unwraps ephemeral/viewOnce/documentWithCaption/edited wrappers via `normalizeMessageContent` before deriving content type (otherwise a disappearing-chat message would map to `'unknown'` with an empty body). Returns `null` for protocol/reaction/senderKeyDistribution messages or missing key fields. Reuses `extractBaileysBody`/`buildIncomingMessageFromBaileys` from `baileys-message-mapper.ts`, and `host.extractEphemeralDuration(msg)` so the history sink applies the same disappearing-timer signal the live path uses.
- Supports `ChatHistoryCapability`.

##### `src/engine/adapters/baileys-channels.ts`
Implements all channel (newsletter)-domain operations extracted from `BaileysAdapter` — the `ChannelCapability` slice.
- `BaileysChannelsHost` (interface) — `ensureReady()`, `getSocket()`, `toEngineJid` (needed only for admin-write jids; channel ids themselves need no mapping since `@newsletter` is shared by both dialects).
- `wmexRefusalCode(error)` — the channel-domain counterpart to `refusedStatusCode` in `baileys-groups.ts`. WhatsApp's `w:mex` GraphQL surface (used for channels) reports refusals as a Boom with an *object* `data` (the GraphQL error node) and the WA code on `statusCode`, never the numeric `data` the IQ-error path uses — so it needs its own classifier. Deliberately kept local/not folded into `refusedStatusCode`, because `promiseTimeout`'s Boom also carries an object `data` (with a 4xx `DisconnectReason` code) that must NOT be read as a refusal.
- `BaileysChannels` (class), constructed `(host, queryBudgetMs = BAILEYS_QUERY_BUDGET_MS)`:
  - `getChannelById(channelId)` — `newsletterMetadata('jid', channelId)`; resolves any channel by jid (richer than whatsapp-web.js's subscribed-list-only lookup).
  - `subscribeToChannel(inviteCode)` — resolves metadata by invite code then calls `newsletterFollow`; throws `ChannelNotFoundError` if metadata lookup comes back empty.
  - `createChannel(name, description?)` — deliberately **NOT** deadline-bounded, same non-idempotency rationale as `BaileysGroups.createGroup` (a retried create could leave duplicate channels).
  - `demoteChannelAdmin(channelId, userId)` — demote-only; notes there is no promote counterpart because neither Baileys nor whatsapp-web.js expose one (an admin is promoted from the WhatsApp app itself, then can be demoted via this API).
  - `transferChannelOwnership(channelId, newOwnerId)` — **is** bounded (unlike `createChannel`), since here a retry after a transfer that actually succeeded would simply be refused (account no longer owns it) rather than creating a duplicate — so bounding is safe and preferred over an indefinite stall.
  - `deleteChannel`, `muteChannel`/`unmuteChannel` (combined into one method via a `mute: boolean` param), `unsubscribeFromChannel` — thin bounded/refusal-mapped wrappers. `unsubscribeFromChannel` notes a past bug: it didn't map refusals, so unfollowing an already-unfollowed channel answered 500 instead of the documented 403.
  - `toChannel(meta)` (private) — maps Baileys' `NewsletterMetadata`-like shape to the neutral `Channel`, with optionals included only when present; `createdAt` falls back from `meta.creation_time` to `meta.thread_metadata?.creation_time`.
- Implements `ChannelCapability`.

##### `src/engine/adapters/baileys-catalog.ts`
Implements catalog/product-browsing operations extracted from `BaileysAdapter` — the `CatalogCapability` slice. Comment notes these are adapter *mappings*, not library workarounds, since `makeBusinessSocket` already exposes `getCatalog`/`getCollections` natively.
- `BaileysCatalogHost` (interface) — `ensureReady()`, `getSocket()`, `logger`, `normalizedSelfJid()`.
- `CATALOG_PAGE_SIZE` (const, `50`) — page size for the catalog cursor walk.
- `CATALOG_QUERY_BUDGET_MS` (const, `30_000`) — whole-*request* budget shared across every page of a multi-page walk (not per-query — a per-query deadline would multiply by page count, making a ten-page walk slower than the 60s stall it replaces).
- `BaileysCatalog` (class), constructed `(host, budgetMs = CATALOG_QUERY_BUDGET_MS)`:
  - `bounded(work, deadline)` (private) — wraps a single query with the remaining budget; on timeout, explicitly logs a warning (Baileys' own internal timeout warn is silent at default log level, so without this the resulting 503 would have no explanation anywhere in the logs).
  - `getCatalog()` — synthesizes the neutral `Catalog` metadata from the *first* collection returned by `getCollections` (the only named grouping Baileys exposes); returns `null` for a business with no collections. Builds a `url` as `https://wa.me/c/<phone>`.
  - `getProducts(options)` / `getProduct(productId)` — both page/filter over `fetchAllProducts()`.
  - `fetchAllProducts()` (private) — walks the whole cursor chain on *every* call (no cursor cache), so fetching page N costs the full catalog; a comment flags this as a possible future optimization (cache pages keyed by cursor) if profiling shows it matters. Guards against an infinite loop if the server echoes back the same cursor it was given (`page.nextPageCursor === cursor` → break).
  - `mapProduct(p)` (module-level function) — maps Baileys' product node to the neutral `Product`; `priceFormatted` is synthesized via `formatPrice` (Baileys only carries raw `price` + `currency`); `imageUrl` takes the first value from the `imageUrls` map; `isAvailable` from the `'in stock'` literal.
  - `formatPrice(price, currency)` — uses `Intl.NumberFormat`; falls back to a plain `"CURRENCY price"` string if the currency code is invalid (`Intl` throws `RangeError` on an unknown ISO code).
- Implements `CatalogCapability`.

##### `src/engine/adapters/baileys-contacts.ts`
Implements contacts, profile, and chat-level operations extracted from `BaileysAdapter` — spans `ContactCapability`, `ProfileCapability`, and `ChatCapability`.
- `BaileysContactsHost` (interface) — `ensureReady`, `getSocket`, `logger`, `normalizedSelfJid`, `listContacts`/`findContact`/`resolvePhone`, `listChats`, `lastMessage(chatId)`, `getStoredMessages(messageIds)` (may be `undefined` if no message store configured), `toEngineJid`/`toNeutralJid`.
- `BaileysContacts` (class), constructed `(host, queryBudgetMs = BAILEYS_QUERY_BUDGET_MS)`. Grouped by sub-domain:
  - **Profile picture**: `getProfilePicture(contactId)` — swallows a throw into `null` ("no picture or hidden"), but re-throws if the failure is specifically `EngineTransportError` from its own deadline (an unanswered query is not a verdict about the picture). Explicitly calls out that the whatsapp-web.js adapter does the *opposite* for the same neutral method (there, no-picture is `undefined` and every throw is a real failure) — the two engines are NOT meant to share a helper for this.
  - **Contacts**: `upsertContact(contactId, firstName, lastName?)` — note: Baileys addresses contacts by JID (unlike whatsapp-web.js's bare-phone-number convention); `saveOnPrimaryAddressbook: false` matches whatsapp-web.js's default. Explicitly folds the neutral `@c.us` id to engine `@s.whatsapp.net` before writing, because `addOrEditContact`'s underlying `chatModify` app-state patch is keyed by the *raw* jid with no normalization — an un-folded `@c.us` key would silently write to an index WhatsApp never reads while still reporting success. `deleteContact` applies the same fold.
  - `mapUnresolvableId(contactId, op)` (private) — catches Baileys' `updateBlockStatus` 400 (thrown when it cannot map the id between phone/privacy-id dialects) and converts it to `RecipientUnreachableError` (400), matching the parity convention whatsapp-web.js already uses for the send path. Only a 400 is folded in; transport failures (e.g. dropped connection) propagate untouched.
  - `blockContact`/`unblockContact` — invalidate the blocklist memo (`invalidateBlocklist()`) after a successful write.
  - `getBlockedContacts(budgetMs?)` — the read half; explicitly deadline-bounded because an unanswered blocklist query would otherwise surface as an *empty* blocklist (a false claim rather than a transport failure).
  - `setProfileName`, `setProfileStatus`, `setProfilePicture`, `deleteProfilePicture` — thin, deadline-bounded wrappers; the picture methods guard on `normalizedSelfJid()` being non-empty (throws a plain `Error` otherwise) since an empty jid would silently target nothing while reporting success.
  - **Blocklist memoization** (private state): `blocklistMemo`, `blocklistInFlight`, `blocklistGeneration`, `BLOCKLIST_MEMO_MS` (5s TTL), `BLOCKLIST_ENRICHMENT_BUDGET_MS` (5s, deliberately shorter than the engine-wide blocklist-read budget since here the blocklist is just one enrichment field on rows the caller already has). `blockedIds()` shares one in-flight query across concurrent callers (`blocklistInFlight ??= queryBlockedIds()`); `queryBlockedIds()` captures a generation number before querying so a block/unblock that invalidates mid-query can't let a stale pre-change answer re-memoize over the just-changed state. A failed query degrades `isBlocked` to its default (`false`) rather than failing the whole contact read, with a warning logged — deliberately different from `getBlockedContacts()`'s own throw-on-failure behavior.
  - `withBlockedState(contacts)` (private) — stamps real blocklist state onto contacts/entries the in-memory session store mapped with `isBlocked: false` by default (the store itself has no socket access).
  - `resolveContactPhone`, `getChats` — thin host-delegating reads.
  - **Chat operations** (`ChatCapability`): `sendSeen(chatId, messageIds?)`, `markUnread`, `clearChatMessages`, `archiveChat`, `muteChat`, `pinChat`, `deleteChat` — all go through `chatModify`/`readMessages`, and most require `host.lastMessage(chatId)` (Baileys' chat-modification app-state patches need the chat's last known message/timestamp as an anchor) — return `false` when no last message is known rather than synthesizing one, EXCEPT `muteChat` and `pinChat`, which carry no `lastMessages` field in their `ChatModification` shape and so work on chats with no known history.
  - `receiptKeys(chatId, messageIds?)` (private) — resolves the full `WAMessageKey[]` a read receipt should acknowledge. Explains at length why caller-supplied ids must be resolved through the stored message rather than synthesized: a synthesized key lacks `participant` (breaks group receipts), hardcodes `fromMe: false` (wrong for outbound messages), and may use the wrong jid dialect. Falls back to a synthesized key only for ids the store never saw (e.g. unpersisted history backfill). Validates a resolved stored key actually belongs to the *target* chat by comparing neutralized jids (not engine-dialect, since `toEngineJid` leaves `@lid` untouched but a DM can be keyed by `@lid` in storage) — otherwise an id from a different chat in the same session could misdirect the receipt while reporting success for the chat the caller named.
- Implements `ContactCapability`, `ProfileCapability`, and `ChatCapability`.

##### `src/engine/adapters/baileys-message-mapper.ts`
Pure mapping functions and types translating Baileys' raw message/proto shapes into OpenWA's neutral `IncomingMessage`/`MessageType`/`DeliveryStatus` shapes — the core shape logic underpinning `MessagingCapability`'s inbound path (used live and by `baileys-history.ts` for bulk backfill).
- `mapBaileysMessageType(contentType, isPtt?)` — maps a Baileys content-type token to the neutral `MessageType`. `audioMessage` splits into `voice`/`audio` via the `ptt` flag (mirrors whatsapp-web.js). Poll variants (`pollCreationMessage`/`V2`/`V3`) all collapse to `'poll'`. WhatsApp Business interactive shapes (`interactiveMessage`, `buttonsMessage`, `templateMessage`, `interactiveResponseMessage`) map to `'text'` instead of `'unknown'`, since they carry extractable display text (OTP/verification prompts). `placeholderMessage` maps to its own `'masked'` type: Meta withholds the real text by design on linked/companion devices (Baileys is always a companion device) for high-security business messages, and a resend cannot recover it — so it's surfaced distinctly rather than as an indistinguishable empty `unknown`. Note: Baileys never produces `call`-typed messages via `getContentType` (calls arrive only via the dedicated `call` socket event / `WACallEvent`), unlike the whatsapp-web.js adapter which sources call detail from a gated history path.
- `BaileysBodyContent` (interface) — structural (not `proto.IMessage`) subset read by the body extractor, for unit-testability with plain objects.
- `extractBaileysBody(content)` — extracts display text in priority order: plain text → media caption → interactive/buttons/template business shapes → poll question → event name → button-tap label → contact vCard(s). `contactsArrayMessage`'s multiple vCards are newline-joined (valid per RFC 6350, not string mangling). Returns `''` when nothing extractable. **Must** be called with already-normalized content (ephemeral/viewOnce/documentWithCaption wrappers unwrapped).
- `extractContactsArrayVcards(contactsArrayMessage)` (private) — joins vCards, returns `undefined` (not `''`) when empty so it composes with `??` chains.
- `BaileysLocationContent` (interface), `extractBaileysLocation(content, contentType)` — extracts lat/long (+ name/address for static locations only — `liveLocationMessage`'s proto type has no `name`/`address` field, so those two are always sourced from the static variant even when the live message is the active content type... actually they're sourced from `content.locationMessage` specifically). Requires normalized content.
- `BaileysContextCarrier` / `BaileysContextContent` (interfaces), `BaileysMessageContext` (interface), `extractBaileysContext(content)` — extracts quoted-message, disappearing-timer (`contextInfo.expiration`), @mentions, and extended-text styling (`backgroundArgb`, `font` — status/story styling) from whichever sub-message actually carries the `contextInfo` object. Quote body is extracted via the *same* `extractBaileysBody` extractor recursively, so a quoted poll/contact-card/interactive-shape shows its real text instead of an empty string (parity with whatsapp-web.js, where a quote is a full `Message`). Requires normalized content (the live disappearing-message wrapper nests `contextInfo` one level deeper).
- `mapBaileysStatus(status)` — maps Baileys' numeric `proto.WebMessageInfo.Status` to the neutral `DeliveryStatus`; `PLAYED` (5) collapses into `'read'` like `READ` (4), matching whatsapp-web.js; unknown/absent → `null` (adapter skips emitting an ack).
- `BaileysIncomingFields` (interface) — the full field set `buildIncomingMessageFromBaileys` consumes, pre-extracted by the caller (media, location, quotedMessage, ephemeralDuration, mentionedJids, styling) so the neutral-shape builder is unit-testable without proto construction.
- `buildIncomingMessageFromBaileys(fields, normalizeJid?)` — the central builder. Key logic:
  - `from`/`to` flip based on `fromMe`; `chatId` is always `remoteJid` (normalized).
  - `author` (from `participant`) is populated for BOTH group messages AND status broadcasts (`status@broadcast`) — without the status arm, status-poster resolution breaks entirely since there'd be nothing but the shared pseudo-JID to resolve to.
  - `isLidSender` is computed from the **raw**, pre-normalization sender jid (participant or chat jid), since normalization would already have resolved an `@lid` away.
  - `backgroundColor` converts proto ARGB (`fields.backgroundArgb`) to a `#RRGGBB` hex string via bitmasking.
  - `mentionedIds` maps each mentioned jid through `normalizeJid` — parity with the whatsapp-web.js adapter's equivalent `mentions` webhook field.
  - `normalizeJid` defaults to identity for pure-shape testability; the adapter supplies the session-store-backed lid-resolving normalizer in production.
- Supports `MessagingCapability` (and indirectly `ChatHistoryCapability` via reuse in `baileys-history.ts`); not itself a capability class.

##### `src/engine/adapters/baileys-message-store.service.ts`
NestJS `@Injectable()` service — the persisted Baileys message store (Baileys ships no store of its own). Backs reply/forward/react/delete-by-id by letting the original `WAMessage` (and its `key`) be resolved by id across process restarts. Supports `MessageOperationsCapability`.
- **DI dependencies**: `@InjectRepository(BaileysStoredMessage, 'data')` — a TypeORM `Repository<BaileysStoredMessage>` against the `'data'` connection.
- Implements `BaileysMessageStore` (the interface type referenced from `../types/baileys.types`).
- `positiveIntFromEnv(name, fallback)` (module-level) — parses a positive-int env var with fallback.
- `isMissingParentSessionError(err)` (module-level) — detects a foreign-key violation (parent `sessions` row missing) across both SQLite (`SQLITE_CONSTRAINT[_FOREIGNKEY]` / message text match) and Postgres (`23503`) error shapes, unwrapping TypeORM's `QueryFailedError` wrapper as needed.
- Private state: `logger` (scoped `createLogger('BaileysMessageStore')`), `orphanWarnedSessions: Set<string>` (dedupes the orphan-session warning to once per session), lazily-loaded `baileysLib` (ESM-only Baileys module, loaded on first use rather than at boot via `loadLib()`).
- `put(sessionId, msg)` — upserts a message keyed by `(sessionId, waMessageId)`, serializing via Baileys' own `BufferJSON.replacer`. Idempotent by design (the same message can arrive both from a send's return value and from the `messages.upsert` echo). `createdAt` is set **explicitly** to `new Date()` rather than left to a DB default — documented bug this avoids: SQLite's `datetime('now')` stores second-precision while the JS `Date` bound param serializes with milliseconds, and SQLite string-comparison then treats same-second rows as "older" than the cutoff, over-evicting the store down to near-zero rows. On a missing-parent-session error (orphaned adapter after reconnect churn / session recreation), the write is dropped silently rather than thrown (warned once per session) — explicitly notes reply/forward/react/delete-by-id become unavailable for messages received under that orphaned session id (references issue #319).
- `getMessage(sessionId, messageId)` — returns `null` for an empty/falsy `messageId` up front (defensive: Baileys' retry/poll paths can hand a keyless key, and an undefined criterion reaching the ORM either throws in TypeORM 1.x or matched an arbitrary row in 0.3).
- `getMessages(sessionId, messageIds)` — batches into a single `In(ids)` query rather than N sequential `findOne`s, since the read-receipt path can resolve up to ~100 ids per request.
- `clearSession(sessionId)` — bulk delete by `sessionId`.
- `enforceLimit(sessionId)` (private) — per-session row cap (`BAILEYS_MESSAGE_STORE_LIMIT` env, default 5000). Finds the cutoff row at `offset = limit` ordered by `(createdAt DESC, id DESC)` and deletes everything at-or-older than it via a raw `createQueryBuilder` delete, ensuring deterministic eviction even when multiple rows share a `createdAt`.
- Consumed by `baileys-contacts.ts` (`getStoredMessages` in the host interface) and by the adapter's message-operations path (reply/forward/react/delete).

##### `src/engine/adapters/baileys-stored-message.entity.ts`
TypeORM `@Entity()` — the table backing `BaileysMessageStoreService`. Engine-specific persistence, deliberately kept in the engine layer rather than the neutral `messages` table.
- Entity name: `baileys_stored_messages`.
- Indexes: `@Index(['sessionId', 'waMessageId'], { unique: true })` (lookup + dedup between a send's return value and its `messages.upsert` echo); `@Index(['sessionId', 'createdAt'])` (supports the eviction-cutoff query in `enforceLimit`).
- Columns:
  - `id: string` — `@PrimaryGeneratedColumn('uuid')`.
  - `sessionId: string` — `@Column()`.
  - `session?: Session` — `@ManyToOne(() => Session, { onDelete: 'CASCADE' })` + `@JoinColumn({ name: 'sessionId' })`. The CASCADE FK is what cleans up stored messages when the parent session row is deleted, covering both the `synchronize: true` SQLite path and the formal migration path.
  - `waMessageId: string` — `@Column()` — the Baileys `WAMessage.key.id`.
  - `serializedMessage: string` — `@Column({ type: 'text' })` — the full `WAMessage` proto, JSON-serialized via Baileys' `BufferJSON` replacer/reviver (so embedded `Buffer`/`Uint8Array` fields round-trip).
  - `createdAt: Date` — `@CreateDateColumn()`.
- Holds the serialized proto (not a parsed/typed structure) so arbitrary future Baileys message shapes round-trip without a schema migration.

##### `src/engine/adapters/baileys-session-store.ts`
Per-session, in-memory (LRU-capped) cache of Baileys contacts/chats/last-messages/lid-mappings, fed from `sock.ev` events — the main read-model behind `ContactCapability`/`ChatCapability`'s list/lookup operations on the Baileys engine, since Baileys exposes no "fetch all contacts/chats" API of its own.
- `LastMessage` (interface) — `{ key, timestamp, text }`.
- `SESSION_STORE_MAP_CAP_DEFAULT` (const, `5000`) — default per-map entry cap, matching the repo's other per-session bounds (`LID_MAPPING_CACHE_MAX`, `BAILEYS_MESSAGE_STORE_LIMIT`, session `lidPhoneCache`).
- `LruMap<K,V>` (private class) — insertion-ordered `Map` wrapper implementing LRU eviction: a `get` or `set` re-inserts the key at the most-recent end; `set` evicts the oldest entry while over `max`. `max = 0` means unbounded.
- `BaileysSessionStore` (class) — holds no socket, pure data. Constructed `(lidStore?: LidMappingStore, sessionId?: string)`; `lidStore` is the persisted, cross-session lid→phone table (`src/engine/identity/lid-mapping-store.service.ts`) this session's resolutions write through to and fall back to on an in-memory miss.
  - Internal maps, all LRU-bounded via `BAILEYS_SESSION_STORE_MAX_ENTRIES` env (default 5000/map): `contacts`, `chats`, `lastMessages`, `lidToPn`. `ephemeralByChat` is double-keyed (raw + neutral jid per chat) so its cap is `maxEntries * 2`.
  - `upsertContacts(records)` — merges partial contact records by id; opportunistically captures a lid→phone pair from the merged record (`merged.phoneNumber`, or `merged.id` itself if already phone-dialect) and both caches it (`lidToPn`) and writes it through to the persistent `lidStore` via `persistLidMapping`.
  - `upsertChats(records)` — merges partial chat records by id.
  - `addLidMappings(mappings)` — bulk lid/pn pair ingestion, same cache+persist-through behavior.
  - `recordKeyLidMappings(key)` — learns lid↔phone pairs directly off an inbound message's `WAMessageKey`. Documents a Baileys version migration: v7 replaced 6.7.x's `senderLid`/`senderPn`/`participantLid`/`participantPn` fields with `remoteJidAlt`/`participantAlt` ("Alt" = the other dialect of the same field). This is still the *only* place a fresh `@lid` sender's phone number is revealed on the message key itself.
  - `lidPnPair(jid, alt)` (private) — sorts a jid + its "Alt" counterpart into `{lid, pn}` by `@lid` suffix detection.
  - `persistLidMapping(lidJid, pnJid)` (private) — fire-and-forget write-through to `lidStore.remember(...)` using bare user-part digits.
  - `recordMessage(msg)` — updates the chat's last-message preview (newest-timestamp-wins) and learns the chat's ephemeral timer (runs before the newest-message guard, so every inbound message refreshes the ephemeral cache even if it's not the newest).
  - `recordMessageEdit(chatId, messageId, text)` — refreshes the preview text only if the edited message is *still* the chat's latest message (an edit to an older message must not reorder/replace the chat preview).
  - `recordEphemeralFromMessage(chatId, msg)` (private) — caches a *positive* ephemeral duration under both the raw and neutral chat jid; a non-positive/absent reading is left untouched rather than clearing a previously-known timer (a single non-ephemeral-stamped message must not erase a known-on timer, since WhatsApp keeps re-stamping it while the feature is active).
  - `extractEphemeralDuration(msg)` — reads `msg.ephemeralDuration` first (populated on history-synced messages but typically absent on a live 1:1 `messages.upsert`), falling back to walking `contextInfo.expiration` (stamped per-message in a disappearing chat) via `contextExpiration`. Exposed publicly so `baileys-history.ts`'s backfill mapper shares the same extraction logic as the live path.
  - `contextExpiration(content, depth=0)` (private) — recursively unwraps known envelope messages (depth-capped at 4) looking for the first positive `contextInfo.expiration`.
  - `listContacts()`, `findContact(id)`, `listChats()`, `lastMessage(chatId)` — read accessors, folding neutral ids to engine dialect via `toEngineJid` before the map lookup.
  - `getEphemeralExpiration(chatId)` — prefers the message-learned cache (tries raw/engine/neutral keys) over the chat object's own `ephemeralExpiration` field (empirically found absent after a reconnect in live testing — "0 of 159 cached chats carried it"). Only positive values count; `0`/`null`/absent all mean "no known timer" so sends aren't forced to disappear by a stale/boot-window cache gap.
  - `resolvePhone(id)` — resolves a user/lid id to its phone user-part. For a `lid` kind id, tries (in order): the in-memory `lidToPn` map (device-suffix-stripped), the contacts map's `phoneNumber`, then the persistent cross-session `lidStore.getCached()` (where `null` = known-unresolved, `undefined` = never seen, both collapse to `null` here).
  - `toNeutralJid(jid)` / `toEngineJid(jid)` — the session's own jid-dialect folding, built on `wa-id.ts`'s `parseWaId`/`toNeutralJid`/`userPart`. `toEngineJid` folds only `user`-kind ids to `@s.whatsapp.net` (the only dialect that encodes to the Baileys/WA wire's single-byte JID_PAIR protocol token); groups/lids/other kinds pass through unchanged.
  - `toNeutralContact(c)` (private) — maps a Baileys `Contact` to the neutral `Contact`. `isMyContact` is derived from whether `c.name` (the name *you* saved) is set — documents a prior bug reporting `true` unconditionally, which wrongly told automations every chat partner was address-book-saved; distinguishes `name` (yours) from `notify`/pushName (theirs).
  - `toNeutralChat(c)` (private) — maps a Baileys `Chat` to `ChatSummary`; `name` falls back to `resolveContactName(id)` when Baileys gives no chat title.
  - `resolveContactName(id)` (private) — best-effort display-name resolution (#369): direct contact name → verifiedName → pushName; for a `@lid` chat, also tries resolving via the phone twin across all three phone-dialect spellings (`@s.whatsapp.net`/`@c.us`/bare); final fallback is the raw user-part (never a bare JID string).
  - `contactDisplayName(id)` (private), `toUnixSeconds(ts)` (private) — small helpers.
- Implements the storage/read-model layer supporting `ContactCapability`, `ChatCapability`, and parts of `ChatHistoryCapability`/`MessagingCapability` (ephemeral-timer lookups for sends).

##### `src/engine/adapters/baileys-status.ts`
Implements WhatsApp Status (story) posting/deletion extracted from `BaileysAdapter` — the `StatusCapability` slice.
- `BaileysStatusHost` (interface) — `ensureReady`, `getSocket`, `toEngineJid`, `normalizedSelfJid`, `toUnixSeconds` (same timestamp-normalization helper duplicated from `baileys-history.ts`'s module-level function, here exposed via the host).
- `BaileysStatus` (class):
  - `postTextStatus(text, options)`, `postImageStatus`/`postVideoStatus`/`postVoiceStatus(media, options)` — thin wrappers routing to `postStatus`/`postMediaStatus`.
  - `postMediaStatus(kind, media, options)` (private) — resolves the media buffer via `resolveMediaBuffer` (shared with messaging send path) and builds the appropriate `AnyMessageContent` per kind. Voice status carries no caption (WhatsApp has nowhere to render one on a status voice note) and sets `ptt: true`, which Baileys also reads as the flag permitting a background color — so the caller-supplied color (forwarded by `postStatus`) applies "for free."
  - `deleteStatus(statusId)` — best-effort revoke. Unlike message deletion, status messages are **not persisted**, so the revoke key is constructed directly from `statusId` alone (no message-store lookup) rather than looked up. Explicitly flagged as **empirically unverified** — the live spike that validated this code only tested *posting*, not revoking; if WhatsApp rejects the constructed key shape, the method should fall back to `EngineNotSupportedError` (not yet implemented as of this file).
  - `postStatus(content, options)` (private) — posts to `status@broadcast` with a `statusJidList` built from `options.recipients` (mapped to engine dialect). Rejects with `BadRequestException` if `recipients` is empty/absent — unlike whatsapp-web.js, which broadcasts to everyone by default, Baileys posts to exactly its allow-list, so an empty list would silently publish visible to nobody. The outbound status echo is **not persisted** (status isn't a chat message; the inbound `messages.upsert` handler already filters out `type: 'append'` echoes).
  - `toStatusResult(sent)` (private) — builds `StatusResult`; `expiresAt` is computed as `timestamp + 24h` (WhatsApp's status TTL), with `timestamp` falling back to "now" if the send result carries none.
- Implements `StatusCapability`.

##### `src/engine/adapters/baileys-version-resolver.ts`
Resolves which WhatsApp Web protocol version Baileys should present on connect — not a capability-slice implementation; lifecycle/bootstrap infrastructure consumed when constructing the Baileys socket.
- `WAVersion` type — `[number, number, number]`.
- `DEFAULT_FALLBACK_WA_VERSION` (const, `[2, 3000, 1045340097]`) — last-resort hardcoded version; comment flags it for manual refresh during WA major version bumps / deprecations.
- `VERSION_RESOLVER_TIMEOUT_MS` (const, `5000`) — per-network-call timeout for remote resolution tiers.
- `BaileysVersionResolverOptions` (interface) — `{ authDir, sessionId, logger: Pick<LoggerService,'log'|'warn'>, timeoutMs? }`.
- `ResolveOptions` (interface) — `{ dispatcher?: unknown }` (an undici-style dispatcher forwarded into `fetch` calls, e.g. for proxying).
- `BaileysVersionResolver` (class) — implements a 5-tier resolution cascade in `resolve(b, resolveOptions?)`:
  1. `resolveFromEnv()` — `BAILEYS_WA_VERSION` operator override, validated against `/^(\d+)[.,](\d+)[.,](\d+)$/` and sanity-checked (`major === 2 && minor >= 2000`); invalid values are warned and ignored rather than used.
  2. `resolveFromWaWeb(b, resolveOptions)` — calls Baileys' `fetchLatestWaWebVersion` (hits `web.whatsapp.com/sw.js` directly), guarded by `AbortSignal.timeout`. Only accepted when the result reports `isLatest === true` and passes `isValidVersion`; on success, writes through to the disk cache via `saveCachedVersion`.
  3. `resolveFromBaileys(b, resolveOptions)` — calls Baileys' `fetchLatestBaileysVersion` (reads the upstream repo's `Defaults/index.ts` off GitHub raw). Since this library function doesn't forward an abort signal itself, the resolver races it against its own `setTimeout`-based promise (mirroring `withQueryDeadline`'s shape: `unref()`'d timer, defused late-rejection via `.catch(() => undefined)` on the loser). Comment notes this defensive racing is currently inert (today's implementation can't actually reject) but guards against a future library change introducing a real rejection.
  4. `resolveFromDiskCache()` — reads `last_known_wa_version.json` from `authDir` (synchronous fs read), validated via `isValidVersion`; silently returns `null` on any error (non-blocking fallback).
  5. Final fallback — logs a warning and returns `DEFAULT_FALLBACK_WA_VERSION`.
  - `saveCachedVersion(version)` (private) — best-effort disk write (creates `authDir` if missing), swallows all errors.
  - `isValidVersion(v)` (private, type guard) — validates a 3-element array of non-negative integers.
- Pure infrastructure supporting `SessionLifecycleCapability` (socket bootstrap), not a capability slice itself.

---

#### `src/engine/adapters/` — whatsapp-web.js engine implementation

whatsapp-web.js drives a real headless Chromium browser (via Puppeteer) against web.whatsapp.com and reads/writes through that page's in-browser WhatsApp Web JS bundle. `whatsapp-web-js.adapter.ts` is the god object implementing `IWhatsAppEngine`; everything else in this group is a focused delegate, event-wiring module, or shared cross-engine helper it composes.

##### Core delegates (connection lifecycle, outbound messaging)

##### `src/engine/adapters/whatsapp-web-js.adapter.ts`
The top-level whatsapp-web.js engine adapter: a thin "god object" that implements `IWhatsAppEngine` end-to-end by composing ~15 focused delegate classes (lifecycle, messaging, groups, contacts, profile, labels, channels, status, chats, catalog, calls, reconcile, stuck-auth, onboarding watcher) behind one shared closure-based host object. It also owns the one piece of cross-cutting logic that genuinely belongs at this layer: bounding/capping concurrent inbound media downloads.

- **`WhatsAppWebJsConfig` (interface)** — per-session config: `sessionId`, `sessionDataPath`, optional `puppeteer` overrides (`headless`, `args`, `executablePath`), optional per-session `proxy` (`url` + `type`), and an optional `lidMappingStore` (shared phone↔LID table the engine persists learned mappings into so the read path can bridge `@c.us`/`@lid` rows).
- **Re-exports** — the file is also the stable public import surface for several helpers that actually live in sibling modules now (kept here so existing callers/specs don't need updated import paths): `resolveAuthTimeoutMs`, `extractLinkedParentJID` (from `wwebjs-groups`), `isHttpUrl`/`loadRemoteMedia`/`extractWwebjsCall`/`wwebjsAckToDeliveryStatus` (from `wwebjs-messaging`), `isSupportedProxyUrl`/`buildProxyLaunchConfig` (from `wwebjs-proxy`), `probeOnboardingModal`/`collectDialogDiagnostics` (from `wwebjs-onboarding`), `isExecutionContextDestroyedError`/`NAVIGATION_REINJECT_GRACE_MS`/`NAVIGATION_EPISODE_CAP_MS` (from `wwebjs-lifecycle`), and `READY_RECONCILE_TIMEOUT_MS`/`READY_RECONCILE_BRIDGE_RELOAD_GRACE_MS` (from `wwebjs-reconcile`).
- **`class WhatsAppWebJsAdapter extends EventEmitter implements IWhatsAppEngine`** — implements the full `IWhatsAppEngine` interface (all ~13 capability slices: SessionLifecycle, Messaging, MessageOperations, ChatHistory, Contact, Group, Call, Profile, Label, Channel, Status, Catalog, Chat, Presence). No NestJS decorators anywhere in this file — the engine layer is plain TypeScript, instantiated manually by session management code, not DI-managed.
  - **Construction/composition**: the constructor builds one `host` object literal (type `WwebjsEngineHost`, defined in `./wwebjs-host`) whose properties are closures bound to `this` (`ensureReady`, `getClient`, `logger`, `isPageTransportError`, `reportIfPageTransportError`, `ensureNotChannelRecipient`, `getNumberId`, `capInboundMediaFor`, `config`, `getCallbacks`, `getSelfWid`). This single host is handed to every stateless delegate (`WwebjsGroups`, `WwebjsMessaging`, `WwebjsContacts`, `WwebjsProfile`, `WwebjsLabels`, `WwebjsChannels`, `WwebjsStatus`, `WwebjsChats` (also takes `messaging`), `WwebjsCatalog`). Lifecycle-adjacent collaborators (`WwebjsReadyReconcile`, `WwebjsStuckAuth`, `WwebjsCalls`, `WwebjsOnboardingWatcher`, `WwebjsLifecycle`) each get their own narrower host-slice interface, built and wired in a specific order because the lifecycle's host closes over the others (reconcile, stuck-auth, calls, onboarding watcher are constructed first). Built in the constructor body, not as field initializers, because `config` is a TS parameter property that field initializers would read before assignment.
  - **State aliasing**: `client`, `status`, `qrCode`, `tearingDown`, `logoutInitiated`, `disconnectReported`, `liveCalls` are all getter/setter accessors that forward to `this.lifecycle` / `this.calls` state. This exists so unmodified specs that poke `adapter.client`/`adapter.status`/etc. through a type cast keep working byte-identically even though the real state now lives in the lifecycle/calls delegates.
  - **`capInboundMediaFor(msg, maxBytesOverride?)`** (private) — the one substantial piece of adapter-owned business logic. Downloads inbound media safely:
    1. Pre-gates on the sender-*declared* size (`msg._data.size`) against `inboundMediaMaxBytes()`/override; if it exceeds the cap, skips the download entirely and returns a declared-only envelope (no blob, `omitted: true`).
    2. Otherwise runs the actual `msg.downloadMedia()` through `this.inboundLimiter`, a `ConcurrencyLimiter(inboundMediaConcurrency())` with an **unbounded queue** (deliberately — a cap equal to active slots previously made admission a constant regardless of batch size, silently dropping media past the Nth message in a burst).
    3. Because `downloadMedia()` cannot be aborted, a timed-out caller still **holds its concurrency slot** until the real download settles (not just until the timeout fires) — otherwise a fresh download could be admitted while an abandoned one is still materializing in heap, blowing past the configured concurrency.
    4. The caller-facing wait itself is also timeout-bounded (`withInboundDownloadTimeout`) so a burst stuck behind wedged slots doesn't park forever and silently drop messages entirely (worse than the original size-cap problem this was built to avoid).
    5. On success, builds the result via `capInboundMedia(...)` (post-download byte cap — may still mark `omitted` if actual bytes exceed `MEDIA_DOWNLOAD_MAX_BYTES`).
  - **Lifecycle forwarders**: `initialize(callbacks)` stores callbacks then delegates to `this.lifecycle.initialize()`; `disconnect`, `logout`, `destroy`, `forceDestroy`, `getStatus`, `probeLiveness`, `getQRCode`, `requestPairingCode`, `getPhoneNumber`, `getPushName` all forward straight to `this.lifecycle`. `recoverFromStuckAuth`/`clearLocalAuth` forward to `this.stuckAuth`; `reportActionRequired` forwards to `this.onboardingWatcher`.
  - **`attachDomainEvents(client)`** (private) — the one seam where the lifecycle delegate reaches back into the adapter to wire up payload-mapping event handlers on a freshly built `Client`: calls `registerWwebjsMessageEvents`, `registerWwebjsGroupEvents`, and `client.on('call', ...)` → `this.calls.handleIncomingCall`. Connection-state events (qr/authenticated/ready/disconnected/auth_failure) stay inside `wwebjs-lifecycle.ts` itself since they drive the latches those registrars never touch.
  - **Capability stubs implemented inline (not delegated) on purpose**: `subscribeToPresence` (whatsapp-web.js exposes no way to observe another party's presence — only `sendPresenceAvailable/Unavailable` which publish the *account's own* presence), `upsertLabel`/`deleteLabel` (wwebjs 1.34.7 can read/assign labels but not create/rename/recolor/delete them), all throwing `EngineNotSupportedError`. These are deliberately inline rather than routed through a delegate because a "parity gate" test reads method bodies directly off the class prototype to verify unsupported-capability matrix rows — a delegate call would hide the throw from that introspection.
  - **Everything else** (the bulk of the file, ~400 lines) is one-line forwarders to the appropriate delegate: channels (`createChannel`, `deleteChannel`, `muteChannel`, `demoteChannelAdmin`, `transferChannelOwnership`, `getSubscribedChannels`, `getChannelById`, `subscribeToChannel`, `unsubscribeFromChannel`, `getChannelMessages`), labels (`getChatsByLabel`, `getLabels`, `getLabelById`, `getChatLabels`, `addLabelToChat`, `removeLabelFromChat`), calls (`createCallLink` → profile delegate; `rejectCall` → calls delegate, evicts the live-call cache entry on any attempt so an unknown/expired id maps to 404), messaging (all `send*Message`, `replyToMessage`, `forwardMessage`, `reactToMessage`, `getMessageReactions`, `getChatHistory`, `starMessage`, `pinMessage`, `unpinMessage`, `votePoll`, `deleteMessage`, `editMessage`), contacts (`getContacts`, `getContactById`, `getNumberId`, `checkNumberExists`, `resolveContactPhone`, `getProfilePicture`, `blockContact`/`unblockContact`, `getBlockedContacts`, `upsertContact`, `deleteContact`), groups (`getGroups`, `getGroupInfo`, `createGroup`, `addParticipants`/`removeParticipants`/`promoteParticipants`/`demoteParticipants`, `leaveGroup`, `setGroupSubject`/`setGroupDescription`, invite codes, join-via-invite, admin-only toggles, member-add-mode, picture, ephemeral duration, membership requests), profile (`setProfileName`, `setProfileStatus`, `deleteProfilePicture`, `setProfilePicture`), status/stories (`getContactStatuses`, `getContactStatus`, `postTextStatus`/`postImageStatus`/`postVideoStatus`/`postVoiceStatus`, `deleteStatus`), catalog (`getCatalog`, `getProducts`, `getProduct`, `sendProduct`, `sendCatalog` — all honest 501s since whatsapp-web.js has no Catalog API at all, replacing older phantom stub behavior that silently reported "no catalog" for a capability that never ran), and chats (`getChats`, `sendSeen`, `muteChat`, `pinChat`, `archiveChat`, `clearChatMessages`, `markUnread`, `deleteChat`, `sendChatState`, `setOnlinePresence`).
  - **`ensureReady()`** (private) — the central readiness gate every delegate operation calls first. Throws `EngineNotReadyError` (→ HTTP 409) if status isn't `READY` or there's no client. Also throws the same typed 409 (with a distinct message) if `this.lifecycle.isInNavigationReinjectWindow()` is true: after a post-READY WhatsApp Web page navigation, `window.WWebJS` is temporarily gone until re-injection completes, so any delegate's `page.evaluate()` would otherwise die as a raw TypeError 500 — and five raw send failures would latch the send breaker for a 15-minute cooldown. Framing it as a retryable 409 instead avoids that.
  - **`ensureNotChannelRecipient(chatId)`** (private) — guards against a whatsapp-web.js crash (`msg.avParams is not a function`, upstream bug) that occurs when building a *media* message for a channel JID; text-to-channel works fine. Throws `ChannelMediaNotSupportedError` (501) proactively instead of surfacing the raw TypeError as a 500.

---

##### `src/engine/adapters/wwebjs-lifecycle.ts`
Owns the whatsapp-web.js connection lifecycle end-to-end: Chromium/Puppeteer launch (including proxy wiring and the WA-Web version pin), the `qr`/`authenticated`/`ready`/`disconnected`/`auth_failure` client event handlers that drive `EngineStatus` transitions, Puppeteer-level death detection (since the library itself never notices a crashed browser), the four teardown flavors (`disconnect`/`logout`/`destroy`/`forceDestroy`), the active liveness probe, pairing-code requests, and a post-READY "navigation re-inject" grace window that keeps the session alive through WhatsApp Web's periodic page reloads.

- **`isExecutionContextDestroyedError(reason)`** (exported function) — regex test for Puppeteer's "Execution context was destroyed" error text. During `Client.inject()` this is most often caused by a persistent browser profile left stale after an OpenWA upgrade changed the Chromium/Chrome binary (e.g. the v0.8.12 Debian Chromium → Chrome for Testing switch), but can also follow an ordinary page navigation or renderer crash — so callers *advise*, never *assert*, based on this match. Kept pure (no `Client` dependency) for unit testability.
- **`isNavigationShapedInitRejection(reason)`** (private) — broader classifier: the exec-context-destroyed shape OR `'window.require is not a function'` (an evaluate landing on a page whose WA bundle hasn't booted yet). Deliberately separate from the advisory classifier above because the advisory's remedy (delete the profile) is wrong for the `window.require` shape — this predicate only decides whether a single in-place retry of the first `initialize()` is worth attempting, since whatsapp-web.js only registers its own re-inject handler *after* the first inject succeeds, leaving a navigation that lands during that first inject caught by nothing upstream.
- **`NAVIGATION_REINJECT_GRACE_MS = 60_000`** (exported const) — how long after a detected page navigation the session is treated as "alive but recovering" rather than dead. Sized between the floor (tens of seconds for page reload + WA bundle reboot, during which `getState()` rejects) and the ceiling (one 60s watchdog interval, so a navigation that then wedges still dies within one extra interval).
- **`NAVIGATION_EPISODE_CAP_MS = 3 * NAVIGATION_REINJECT_GRACE_MS`** (exported const) — hard ceiling per recovery episode (first navigation → next completed re-inject), preventing a navigation *loop* from continuously re-stamping the rolling grace and permanently suppressing the watchdog (which would leave a zombie session reporting READY but answering every request with 409 forever).
- **`INIT_RETRY_MIN_REMAINING_MS = 20_000`** (private const) — the single in-adapter retry of a navigation-killed first inject is only attempted if at least this much of the outer init deadline remains, since a retry that the outer race SIGKILLs mid-launch would surface as a bare, reasonless 504.
- **`WA_STATE_RESTRICTIONS`** (private const map) — maps exactly three of WhatsApp Web's twelve `WAState` disconnect reasons (`TOS_BLOCK`, `SMB_TOS_BLOCK` → `tos_block`; `PROXYBLOCK` → `proxy_block`) to the neutral `AccountRestriction['kind']`. This is the *only* channel the library exposes for account-standing signals — no dedicated event/error type exists. The other nine states (UNPAIRED*, LOGOUT, CONFLICT, DEPRECATED_VERSION, TIMEOUT) are deliberately excluded since they represent unlinks, device takeover, client-too-old, or plain faults — not a statement about account standing — and misreporting them as restrictions would make the signal worthless.
- **`WwebjsLifecycleHost` (interface)** — the narrow closure surface the adapter injects: `logger`, `config`, `getCallbacks()`, `emitState(status)` (re-emits `stateChanged` on the adapter's own `EventEmitter`), `scheduleReadyReconcile`/`clearReadyReconcile`, `startOnboardingWatcher`/`clearOnboardingWatcher`, `clearLiveCalls`, `clearLocalAuth()` (routed through the adapter so an instance-level override stays authoritative), `attachDomainEvents(client)`.
- **`class WwebjsLifecycle`** — implements no engine interface directly (it's a lifecycle *slice* of `SessionLifecycleCapability`, consumed by the adapter which implements the full `IWhatsAppEngine`). Public mutable fields `client`, `status`, `qrCode`, `tearingDown`, `logoutInitiated`, `disconnectReported` are intentionally public (not private) because the adapter aliases them by reference through its own getter/setter accessors for backward-compatible test/spec access.
  - **`initialize()`** — the main launch sequence:
    - Logs a loud error up front if `isBackportMissing()` (an install that skipped a required message-id backport patch fails later with unhelpful errors).
    - Builds Puppeteer launch args: defaults to `['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote', '--disable-gpu']` unless `config.puppeteer.args` overrides them entirely.
    - If a per-session proxy is configured and its URL is validated by `isSupportedProxyUrl`, builds `--proxy-server=...` via `buildProxyLaunchConfig` (Chromium ignores inline proxy credentials, so creds are stripped from the server arg and instead passed as `proxyAuthentication` for `page.authenticate()` on HTTP/HTTPS proxies — SOCKS proxies with credentials log a warning since Chromium can't authenticate SOCKS proxies at all).
    - Appends a marker arg `--openwa-session=<sessionId>` — Chromium silently ignores unknown flags, so this exists purely so `killOrphanedChromiumProcesses()` can later identify this session's browser in `ps` output after a hard process kill.
    - Resolves the WA-Web version pin via `resolveWebVersionPin()` (auto-resolves a settled build from a version registry by default; `WWEBJS_WEB_VERSION=off` opts out). This fixes the 1.34.x "stuck at authenticating" hang some setups hit.
    - Resolves `authTimeoutMs` via `resolveAuthTimeoutMs()` — opt-in override of wwebjs's 30s default init timeout, for slow (WSL2/low-resource) hosts.
    - Runs `runInitAttempt(...)`. On failure, if the error is navigation-shaped (per `isNavigationShapedInitRejection`), not already tearing down, and enough of the outer timeout budget remains, it performs **one retry**: calls `resetForInitRetry()` to tear down attempt 1's client, then re-runs `runInitAttempt` fully. If attempt 1's browser can't be destroyed within bound, the retry is abandoned outright (never launches a second Chromium into the same `LocalAuth` profile, since that risks corrupting the one credential copy).
    - On a genuinely terminal failure, sets `FAILED` status and reports via `onError`. Special-cases `isExecutionContextDestroyedError`: logs an operator-facing remedy (delete the stale profile dir, path computed from `sessionDataPath`) and prepends a short, searchable reason string to what's surfaced to the dashboard's `lastError` field (kept short since the raw Puppeteer text is what operators search for, and the dashboard truncates long reasons).
  - **`runInitAttempt(puppeteerArgs, authTimeoutMs, proxyAuthentication, versionPin)`** (private) — the single construction+launch sequence, extracted so the navigation retry repeats it *fully* (a bare retry without `setupEventHandlers()` would have no qr/ready handlers at all). Builds `new Client({ authStrategy: new LocalAuth({ clientId, dataPath }), puppeteer: {...}, authTimeoutMs?, proxyAuthentication?, ...versionPin })`. Notably sets `handleSIGINT/SIGTERM/SIGHUP: false` on the Puppeteer options — the app owns signal handling centrally (in `main.ts`) for a graceful drain window; Puppeteer's unconditional `exit` hook still SIGKILLs the browser on real process exit so nothing leaks. Calls `setupEventHandlers()`, then `killOrphanedChromiumProcesses()` and `removeStaleSingletonFiles()` (cleans up after a prior hard-killed OpenWA process whose Puppeteer exit hook never ran) *before* `client.initialize()`, then calls `client.initialize()` and finally `attachPuppeteerLifecycleListeners()` — because whatsapp-web.js 1.34.x never observes its own Chromium process, so without these listeners a crashed browser leaves `status` looking READY forever ("silent death").
  - **`resetForInitRetry()`** (private) — resets state between attempt 1 and its retry. Deliberately *not* a full teardown (`beginClientTeardown` would latch `tearingDown` and `disconnectReported`, which are single-use flags that would permanently suppress the retry's qr/authenticated events). Removes all listeners from the failed client (late events from persisted page bindings have no source-identity fence), then does a 5-second-bounded `client.destroy()`. Returns `false` (abandon retry) only on a genuine timeout — a fast rejection means the browser was already gone and relaunch is safe.
  - **`setupEventHandlers()`** — registers the five core connection-state client events:
    - **`qr`**: generates a QR data URL via `qrcode.toDataURL`. Guards against a buffered QR flushing late (during an awaited `destroy()`, after stuck-auth recovery nulled `this.client`, or from a client wwebjs re-injected post-LOGOUT that's still alive and serving QRs) by capturing the `sourceClient` before the async encode and re-checking client identity + finished-flags *after* it (`qr` is an awaited macrotask, so state can change mid-encode). Only then sets `qrCode`, status `QR_READY`, and fires `onQRCode`.
    - **`authenticated`**: ignores re-fires while already `AUTHENTICATING`/`READY`/`FAILED` or once torn down/disconnect-reported (so it can't restart the 90s reconcile deadline). Otherwise sets `AUTHENTICATING`, clears `qrCode`, and calls `host.scheduleReadyReconcile()`.
    - **`ready`**: first calls `clearNavigationReinjectWindow()` *before* any other guard — this is the only completion edge for a post-navigation re-inject, and `markReadyFromClientInfo()` early-returns while already READY, so the window would never close for a re-inject-only `ready` otherwise. Then checks the patched client's `eventsAttached` flag (added by `scripts/patch-wwebjs-ready-sync.js`): whatsapp-web.js can emit `ready` *before* its own message listeners are attached (its post-auth callback runs per `hasSynced` trigger and bare-emits `ready` again if it finds `window.WWebJS` already defined, even while the first attach is still in flight) — `eventsAttached === false` means this emit is premature and is ignored (the attach's own completion will re-emit `ready` for real; the readiness reconcile is the backstop if the attach fails). `undefined` (unpatched tree) preserves legacy behavior. Otherwise calls `markReadyFromClientInfo()`.
    - **`disconnected(reason)`**: handles the LOGOUT credential-teardown race carefully — the native 'disconnected' LOGOUT event fires from wwebjs's own `framenavigated` listener *before* it awaits `authStrategy.logout()` (which does `fs.rm(userDataDir)`), with the browser still open. Since that rm happens regardless of what this handler does, it must surface the in-flight removal to the lifecycle (via `onCredentialTeardownStarted`) unless this adapter's own `logout()` already registered the real promise (`logoutInitiated`) or a prior LOGOUT already started it (`credentialTeardownStarted`, a one-shot guard needed because the upstream listener can raise this event more than once per unlink). A deliberate teardown's own `disconnected` is swallowed (status already written by the caller). A WhatsApp-initiated LOGOUT logs an operator-facing warning (reconnect cannot restore a LOGOUT — only a fresh QR can) and flows through to `setStatus(DISCONNECTED)`, an `onAccountRestriction` callback (if the reason maps via `WA_STATE_RESTRICTIONS`) fired *before* `onDisconnected` so consumers already know "why" when they see the disconnect.
    - **`auth_failure`**: terminal — sets `FAILED` (not `DISCONNECTED`, since reconnecting won't help invalid stored credentials) and routes through `onError` rather than `onDisconnected`.
    - Also calls `host.attachDomainEvents(this.client)` to wire message/group/call events via the adapter's seam.
  - **`attachPuppeteerLifecycleListeners()`** — attaches to the loosely-typed `pupBrowser`/`pupPage` handles (cast through `unknown`, since wwebjs's own typings don't declare them): `pupBrowser.on('disconnected', ...)`, `pupPage.on('error'|'close', ...)` all route to `handlePuppeteerDeath`. `pupPage.on('framenavigated', ...)` is the special healing-not-dead case: stamps `lastMainFrameNavigationAt`/`navigationEpisodeStartedAt` (unless it's the LOGOUT navigation shape — `post_logout=1` URL or the library's own `lastLoggedOut` flag — where credential teardown must win instead) so the liveness probe and `ensureReady()` treat the session as alive-but-recovering during the grace window.
  - **`handlePuppeteerDeath(reason)`** (private) — routes a detected Chromium/page death through the same path as the client's native `disconnected` event (`clearReadyReconcile`, `setStatus(DISCONNECTED)`, `onDisconnected`). Guarded against firing during teardown or once already DISCONNECTED/FAILED (first signal wins).
  - **`PAGE_TRANSPORT_ERROR_PATTERN`** (private static regex) — matches Puppeteer error signatures of a dead transport: `protocol error|target closed|targetclosederror|detached frame|session closed|connection closed`.
  - **`isPageTransportError(error)`** — tests an error message against that pattern.
  - **`reportIfPageTransportError(error, context)`** — detection-only helper other delegates call on a failed operation: if the error matches the transport pattern, treats it as an earlier death signal than the minutes-long watchdog would notice (wwebjs's wedged-page bug can report CONNECTED while firing no events at all). Inside the navigation re-inject grace window, the same error signatures can legitimately come from a *healing* page (an in-flight evaluate killed by navigation, or transiently detached frames), so it logs but does **not** treat it as death there — logging is kept so the theory stays falsifiable from field logs even though it's suppressed. Outside the window, calls `handlePuppeteerDeath`. The original error always still propagates to the caller unchanged either way.
  - **`markReadyFromClientInfo()`** — reads `client.info` for `phoneNumber`/`pushName`, sets `READY`, fires `onReady(phoneNumber, pushName)` (falls back to empty strings on read error, still reaching READY). Early-returns if already READY/DISCONNECTED/FAILED/ACTION_REQUIRED. After going READY, starts the onboarding watcher — a freshly-linked account can show a "What's new" modal that, left undismissed, silently unlinks the companion device after ~5 minutes.
  - **`setStatus(status)`** (public) — the single funnel every status transition goes through (also called by sibling delegates via their host slices). Latches `disconnectReported = true` permanently on the *first* transition to `DISCONNECTED` (the field initializer's own implicit `DISCONNECTED` never reaches here, so startup is unaffected). Clears `qrCode` on any transition away from `QR_READY` (previously only the `authenticated` handler and init-retry path cleared it by hand, so a browser/page death, failed init, auth failure, or teardown could leave a stale dead QR servable over `GET /qr` for the entire reconnect backoff). Fires `onStateChanged` then re-emits via `host.emitState`.
  - **`beginClientTeardown()` / `finishClientTeardown(client)`** (private) — shared teardown bookends: `begin` sets `tearingDown = true`, clears live calls, clears the navigation window, clears reconcile/onboarding watchers, sets `DISCONNECTED` if not already; `finish` nulls `this.client` (if still the same instance) and re-clears reconcile/watcher/navigation-window.
  - **`disconnect()`** — `client.destroy()` (preserves session data so reconnecting needs no QR rescan).
  - **`logout()`** — sets `logoutInitiated = true` *before* anything can emit `disconnected` (so the native-event LOGOUT handler doesn't register a duplicate credential-teardown promise). Throws if there's no live client (nothing was ever sent to WhatsApp — resolving would falsely imply a confirmed unlink and leave the device listed in Linked Devices). Calls `client.logout()`; on failure falls back to `client.destroy()` for local cleanup but still rethrows (the caller must know the unlink never reached WhatsApp).
  - **`destroy()`** — plain `client.destroy()` teardown.
  - **`forceDestroy()`** — for a wedged session: SIGKILLs *this client's own* Chromium process directly (via `pupBrowser.process()`, never a process-wide `pkill`, to avoid killing other sessions' browsers), then best-effort `client.destroy()`. Both steps independently wrapped so either failing doesn't block the engine from resetting state.
  - **`isInNavigationReinjectWindow()`** — true if both the rolling per-navigation grace (`NAVIGATION_REINJECT_GRACE_MS`) and the per-episode cap (`NAVIGATION_EPISODE_CAP_MS`) haven't expired. Must only be consulted *after* READY-status gates elsewhere, since a teardown/LOGOUT dropping status must always outrank the grace.
  - **`probeLiveness()`** — the session watchdog's active check: races `client.getState()` against a 10s timeout. Returns `true` only if `status === READY`. On `WAState.CONNECTED`, also clears the navigation window (observed recovery — prevents a silently-failed re-inject episode from permanently denying the grace to later navigations via the stale episode anchor). On any other resolved state, timeout, or thrown rejection, falls back to `isInNavigationReinjectWindow()` — since a wedged page can report CONNECTED falsely, *and* a healing page can reject getState() transiently, neither a bad answer nor an exception alone proves death inside the grace window.
  - **`requestPairingCode(phoneNumber)`** — gated specifically on `status === QR_READY`, not merely "client exists": `this.client` is assigned before `client.initialize()` completes, so for the whole Chromium launch duration a client exists with a null `pupPage`, and wwebjs's own `requestPairingCode` would throw a raw TypeError (500) if called then. `QR_READY` is exactly the window where WA Web's in-page socket reports UNPAIRED and the pairing flow's preconditions are actually met.

---

##### `src/engine/adapters/wwebjs-messaging.ts`
Outbound send paths (text, image/video/audio/document, location, contact card, sticker, poll, reply, forward), message-level operations (react, get reactions, delete, edit, pin/unpin, star/unstar, vote), and chat history reads — plus the `@c.us → @lid` recipient-resolution cache and retry machinery that makes sends resilient to WhatsApp's privacy-ID migration.

- **`wwebjsAckToDeliveryStatus(ack)`** (exported function) — maps wwebjs's integer `MessageAck` to the neutral `DeliveryStatus`: `< 0` → `failed`, `>= 3` → `read` (both READ=3 and PLAYED=4 collapse to `read`), `=== 2` → `delivered`, `=== 1` → `sent`, else → `pending`.
- **`extractWwebjsCall(msg)`** (exported function) — for a `call_log`-type message, reads call metadata off the raw `_data` (not exposed on the public `Message` type): `{ video, missed }`. A message is `missed` only if it's incoming (`!fromMe`) and has no recorded `callDuration`.
- **`declaredOnlyMedia(msg)`** (exported function) — builds the `media` envelope used whenever a blob isn't downloaded (downloads disabled, size pre-gate tripped, aggregate history budget spent, or the download failed/timed out): keeps sender-declared `mimetype`/`filename`/`sizeBytes` with `omitted: true`, so the `media` field is always present for API/webhook consumers even without the payload.
- **`isHttpUrl(value)`** (exported function) — case-insensitive `^https?://` test, used to decide whether a `MediaInput.data` string is a URL to fetch vs. base64 to decode directly.
- **`loadRemoteMedia(url)`** (exported async function) — fetches remote media through the SSRF-guarded `loadRemoteMediaBuffer` (host-validated, IP-pinned to prevent DNS-rebind redirection post-check, byte-capped, no redirects followed) rather than `MessageMedia.fromUrl`'s bundled unpinned `node-fetch`. Builds a `MessageMedia` from the resulting buffer, deriving `filename` from the URL's path basename.
- **`isNoLidForUserError(err)`** / **`isQuoteUnresolvedError(err)`** (exported functions) — substring matchers on wwebjs's untyped page-side error text: `"No LID for user"` (recipient needs a LID the sender doesn't have cached — happens when a `@c.us` contact has migrated to `@lid` addressing) and `"Could not get the quoted message"` (the quoted-message id couldn't be resolved, only reachable because the adapter opts out of wwebjs's default `ignoreQuoteErrors` behavior). No structured error codes exist upstream, so both are pure text matches, flagged as liable to break if wwebjs changes its wording.
- **`toMessageMedia(media, opts?)`** (exported async function) — builds a `MessageMedia` from a `MediaInput`. For a remote URL, fetches via `loadRemoteMedia`, then layers in the caller's declared `mimetype`/`filename` as overrides — *except* when `opts.trustDeclaredType === false` (the sticker path), where the **fetched** response's content-type wins by default since wwebjs's sticker converter (`Util.formatImageToWebpSticker`) decides whether to convert based on mimetype and would pass bytes through unconverted if told they're already webp when they aren't. One narrow fallback exists even in that mode: if the fetched type is generic/empty (`application/octet-stream` or blank) *and* the caller's declared type is a convertible `image/*`/`video/*`, the declared type is used anyway (a generic fetched type carries no information to override with). For non-URL input, wraps the given base64/Buffer data directly with the declared mimetype/filename.
- **`toMessageResult(msg)`** (exported function) — builds the neutral `MessageResult` from whatever wwebjs's `sendMessage` resolved. Critically: `client.sendMessage()` can **resolve `undefined`** for two opposite reasons that are indistinguishable at this layer — the chat couldn't be resolved (nothing sent) or the message *did* send but its id couldn't be read back. This function treats an absent message as a failed send unconditionally (a visible, retryable false negative is safer than silently claiming delivery for something that may never have left). When a real `Message` instance comes back but its id can't be read, returns an empty-string id sentinel (stored as NULL downstream rather than a fabricated id a later ack could mis-match). Reads `id._serialized` falling back to `id.$1` — the latter is the minified/renamed field name WA Web's JS sometimes uses for the same property, a defensive fallback against the library's own minifier churn.
- **`class WwebjsMessaging`** — implements the `MessagingCapability` / `MessageOperationsCapability` / `ChatHistoryCapability` slices of `IWhatsAppEngine` (consumed by the adapter, which forwards its own interface methods here).
  - **`resolveSendId(chatId)`** — the `@c.us → @lid` resolution cache (`resolvedSendIds: Map<string,string>`, unbounded in practice bounded by distinct recipients per session). For a `@c.us` id, checks the cache first; otherwise calls `getNumberId` (a rate-limited WhatsApp Web existence probe). Any server-confirmed resolution (distinct `@lid`, or a confirmed non-migrated `@c.us`) is cached since it's stable; a `null`/thrown lookup is deliberately **not** cached so an unregistered or transiently-flaky contact keeps being retried. On resolving to a `@lid`, fire-and-forget persists the learned phone↔LID pair to `lidMappingStore` (never blocks/fails the send on that write) so the message *read* path can bridge rows across both id dialects for a pure-wwebjs deployment. Non-`@c.us` ids (groups, channels, already-`@lid`) pass through unchanged; any lookup failure falls back to the original id so a send is never blocked by resolution.
  - **`quoteOptions(quotedMessageId?)`** (private) — builds `{ quotedMessageId, ignoreQuoteErrors: false }` when a quote is requested. Deliberately overrides wwebjs's own default of `ignoreQuoteErrors: true` — left alone, an unresolvable quoted id would silently send the message *unquoted* and report success, giving the caller no signal their reply request was silently downgraded. Notes one narrower case this flag *cannot* fix: if the message resolves but `canReplyMsg` is false, wwebjs still sends unquoted with no error — upstream behavior that can't be switched off here.
  - **`sendResolved(chatId, send, quotedMessageId?)`** (private) — the shared retry wrapper used by every send method. Resolves the id via `resolveSendId`, then calls `send(to)`. On failure:
    - Reports page-transport-error death signals (detection-only, doesn't change control flow).
    - Checks `isQuoteUnresolvedError` *before* the LID branch (a bad quote isn't a stale-recipient problem) and remaps to `MessageNotFoundError` (404) — since the bare page-side error otherwise surfaces as an opaque 500 for a caller-supplied id, and would wrongly trip the account-standing send-failure breaker (non-`HttpException` errors count toward it).
    - For a `@c.us` id that failed with `isNoLidForUserError`, drops the cached mapping and re-resolves once. If the fresh id is identical to the stale one, the recipient is genuinely unreachable — throws `RecipientUnreachableError` (400) rather than looping. Otherwise retries the send with the fresh id (logging a warning that this *may* produce a duplicate message, since wwebjs can throw after the message is already on the wire) and applies the same quote/LID error remapping to the retry's own failure.
  - **`sendTextMessage(chatId, text, mentions?, options?)`** — rejects `options.customPreview` with `EngineNotSupportedError` (wwebjs's `linkPreview` option is boolean-only — no title/description/thumbnail control, so silently dropping a requested custom preview would send something unrecognizable to what was asked). Only forwards `linkPreview: false` explicitly (wwebjs treats anything else as `true` already, so omitting it keeps the send options object absent for a vanilla send). Routes through `sendResolved` + `quoteOptions`.
  - **`sendImageMessage` / `sendVideoMessage`** — thin wrappers over `sendMediaMessage` with no extra options.
  - **`sendAudioMessage`** — passes `{ sendAudioAsVoice: true }` when `media.ptt` is set.
  - **`sendDocumentMessage`** — forces `sendMediaAsDocument: true` so WA Web doesn't auto-classify the attachment as a photo/video/audio bubble purely from its mimetype (re-encoding and stripping the filename) — this previously disagreed with the Baileys engine, which always forced document classification via an explicit content key. The flag is withheld specifically for `status@broadcast` and broadcast-list recipients, since wwebjs outright refuses *every* `@broadcast` send once the flag is set (returns `null`, surfacing as a failed send) — those recipients keep today's classification behavior rather than trading a working send for a broken "improvement."
  - **`sendMediaMessage(chatId, media, extraOptions?)`** (private, shared by image/video/audio/document) — calls `ensureReady`/`ensureNotChannelRecipient`, builds the `MessageMedia` once via `toMessageMedia` (so a remote fetch happens before any retry), defaults a nameless document's filename to `'file'` (otherwise WA Web labels it literally "undefined"), then sends through `sendResolved` with caption/mentions/extraOptions/quote merged in.
  - **`sendLocationMessage`** — dynamically imports `whatsapp-web.js`'s `Location` class (with a `.default` fallback for different build shapes) and constructs it from lat/long/description/address.
  - **`sendContactMessage`** — builds a sanitized vCard via the shared `buildVCard` helper (strips CR/LF and enforces digits-only WA id so a crafted contact can't inject extra vCard fields — a prior inline implementation interpolated raw values), sends with `parseVCards: true`.
  - **`sendStickerMessage`** — also guards `ensureNotChannelRecipient` (the sticker send path hits the same `msg.avParams()` channel crash as media, via a different code path). Builds media with `trustDeclaredType: false` so the fetched content-type (not the caller's declared type) drives the webp-sticker conversion decision.
  - **`sendPollMessage`** — dynamically imports `Poll`, casts options to the constructor's actual parameter type (wwebjs's typings incorrectly mark `messageSecret` as required when at runtime it's optional/only used as a custom poll id).
  - **`replyToMessage(chatId, quotedMsgId, text, mentions?)`** — looks up the quoted message in the last 100 fetched messages (`MessageNotFoundError` if absent), then sends via `quotedMsg.reply(text, to, options?)` routed through `sendResolved` (the reply leg hits the same `No LID for user` failure mode as a normal send, so gets the same resolve/cache/self-heal treatment). Reports page-transport errors on failure.
  - **`forwardMessage(fromChatId, toChatId, messageId)`** — looks up the source message in the last 100 fetched messages, forwards via `sendResolved` (capturing the actually-resolved destination id). Since wwebjs's `forward()` returns `void` with no message object, **best-effort recovers** the real sent-message id by re-reading the destination chat's 5 most recent outgoing messages and picking the latest by timestamp — the delivery-ack matcher keys on this id, so without recovery a forward would get permanently stuck at "sent" status. Recovery failure never fails the already-succeeded forward operation; if the copy can't be identified, returns an explicit empty-id sentinel (so no row gets its `waMessageId` set, preventing a later ack from mis-matching a different row) rather than a synthetic or source id. Acknowledges concurrent forwards to the same chat can mis-identify the copy — an accepted tradeoff for delivery-status accuracy.
  - **`reactToMessage` / `getMessageReactions`** — look up the message in the last 100 fetched messages and call/read `.react()`/`.getReactions()` (cast to `MessageWithReactions` since reactions aren't on the base `Message` type). Explicitly do **not** LID-resolve `chatId` for the lookup — wwebjs reacts using the found message's own id, not the chat id, so resolving would give no benefit and could miss a message stored under the pre-migration `@c.us` chat.
  - **`getChatHistory(chatId, limit=50, includeMedia=false, mediaMaxBytes?, signal?)`** — fetches up to `limit` messages via `chat.fetchMessages`, maps each through the shared `buildIncomingMessageBase` (overriding `chatId`/`isGroup`/`isStatusBroadcast`/`kind` since the mapper's default `chatId = msg.from` is wrong for `fromMe` history entries). Enriches location messages and resolves quoted-message previews (best-effort, logs on failure). Maintains a running **aggregate media byte budget** across the whole history pass (not just a per-message cap) — without it, a 100-message history could stack up to ~100× the per-message cap in base64 on the heap. Default budget (`chatHistoryMediaBudgetBytes()`) is sized for a single HTTP response; a caller that passes an explicit `mediaMaxBytes` (e.g. the status-seed ingestion path) gets a budget derived from *its own* per-item cap via `ingestMediaBudgetBytes` instead, since the HTTP-sized default would be far too tight for a bulk-ingest caller and the unbounded alternative risks ~650MB of base64 on connect. Once the budget is exhausted, later media messages degrade to `declaredOnlyMedia` (no download) while already-inlined messages stay inline. `signal.aborted` stops the loop between messages (partial results returned, not discarded).
  - **`deleteMessage(chatId, messageId, forEveryone=true)`** — finds the message in the 100-message window (matching either `id._serialized` or `id.id`), calls `message.delete(forEveryone)`. No LID-resolution of `chatId` for the same reason as react/vote/pin.
  - **`editMessage(chatId, messageId, body, mentions?)`** — same 100-message lookup window; treats `getChatById` resolving `undefined` (wwebjs doesn't throw for an unknown chat) as `MessageNotFoundError` rather than letting a later TypeError 500. An edit *replaces* content wholesale, so `mentions` are re-applied rather than merged/preserved — omitting them drops whatever the original carried. If `message.edit()` resolves `null` (wwebjs's signal that only the account's own text messages are editable), throws `EngineRefusedError` rather than reporting a phantom success.
  - **`findInFetchWindow(chatId, messageId)`** (private) — shared lookup helper for react/delete/edit/pin/unpin/star/vote: resolves the chat, treats `undefined` chat as 404 (not a TypeError), searches the last 100 messages by either id form. Explicitly not retrofitted onto the older inline call sites (react/delete/edit), which differ in whether they tolerate an unknown chat.
  - **`votePoll(chatId, pollMessageId, options)`** — looks up via `findInFetchWindow`, calls `.vote(options)` (cast since the public type doesn't declare it). wwebjs's `vote()` throws a **bare string** (not an `Error`) when the target isn't a poll-creation message — caught specifically and remapped to `BadRequestException` (400) rather than letting it surface as an opaque 500; any genuine `Error` propagates unchanged.
  - **`pinMessage(chatId, messageId, durationSeconds)`** — the page-side pin helper returns `false` (never throws) for every refusal shape (non-number duration, unresolvable message, or a send WhatsApp itself rejected) — remapped to `EngineRefusedError` with an actionable message (admin-only in groups; duration must be 24h/7d/30d).
  - **`starMessage(chatId, messageId, star)`** — calls `.star()`/`.unstar()`. Documents (doesn't attempt to fix) that wwebjs's page-side `canStarMsg()` refusal is silent — a declined star is indistinguishable from an accepted one at this layer.
  - **`unpinMessage(chatId, messageId)`** — `message.unpin()` passes duration `0` internally so the non-number guard can't fire here; a `false` return (e.g. non-admin in a group) maps to `EngineRefusedError`.

##### whatsapp-web.js support adapters

###### `src/engine/adapters/wwebjs-groups.ts`
Group-domain operations (list, info, membership, settings, invites, membership requests) extracted from `WhatsAppWebJsAdapter`; implements the `GroupCapability` slice of `IWhatsAppEngine`. The adapter forwards its public group methods here as thin calls, injecting the shared `WwebjsEngineHost` surface via closures.
- `extractLinkedParentJID(groupMetadata?)` — reads a group's parent-community JID, checking `parentGroup`/`linkedParentGroup`/`linkedParent` in order since the field name has varied across wwebjs/WA Web versions.
- `normalizeWwebjsMemberAddMode(raw)` — normalizes wwebjs's member-add-mode encoding (`'admin_add'`/`'all_member_add'` strings, or a legacy boolean whose `true` means "admins only", the OPPOSITE sense of Baileys' boolean) to the neutral `GroupMemberAddMode`. Unrecognized values return `undefined` rather than being guessed.
- `normalizeWwebjsRequestMethod(raw)` — maps wwebjs's PascalCase membership-request method tokens (`InviteLink`, `NonAdminAdd`, `LinkedGroupJoin`) to the neutral vocabulary.
- **class `WwebjsGroups`** (constructed with `WwebjsEngineHost`):
  - `getGroups()` — lists groups from `client.getChats()` filtered to `isGroup`; reads `linkedParentJID` only from already-loaded metadata (deliberately no per-group `getChatById` N+1 fetch).
  - `getGroupInfo(groupId)` — full detail via `getChatById`; drops participants whose wid can't be read rather than emitting `"undefined"`; distinguishes a dead transport (`EngineTransportError`, 503) from a genuinely missing group (`null`, 404).
  - `createGroup()` — always throws `EngineNotSupportedError`. WA Web's `findImpl` internal that `Client.createGroup`'s page body relies on no longer exists on current WA Web builds (verified on two WA Web builds, bare `TypeError`); not a library bug that can be patched since `findImpl` isn't part of wwebjs itself. Baileys supports this.
  - `addParticipants(groupId, participants)` — wwebjs resolves a batch-level refusal as a returned string instead of throwing (turned into `EngineRefusedError`); maps per-participant result codes (200=added, 403/404/408/409/419); a `403` with `isInviteV4Sent` is treated as success (private invite sent), not failure.
  - `removeParticipants` / `promoteParticipants` / `demoteParticipants` — all routed through `runStatusOnlyParticipantOp`, which works around wwebjs silently dropping unresolved participant ids and reporting a flat `{status:200}` for the whole batch (would otherwise claim removals that never happened); a project-local patch (`scripts/patch-wwebjs-participant-arity.js`) adds a `matched` boolean array that is used when present/correct-length, else the previous batch-confirmed shape is kept rather than guessing.
  - `assertParticipantResults(op, groupId, results)` — shared gate: empty results list is a refusal; all-failed batch is a refusal (HTTP 403 semantics); partial success passes through as-is.
  - `leaveGroup`, `setGroupSubject`, `setGroupDescription` — straightforward writes; subject/description throw `EngineRefusedError` when wwebjs resolves `false` (admin rights required) instead of throwing.
  - `getGroupInviteCode` / `revokeGroupInviteCode` — guard against wwebjs resolving `undefined` (which would otherwise render as literal string `"undefined"` in the invite link).
  - `getGroupJoinInfo(inviteCode)` — previews a group from an invite code; every field read defensively (no typed contract from wwebjs); distinguishes a dead page (503) from a refused/invalid invite (`GroupNotFoundError`, 404); reads `$1` id fallback for the WA Web minifier rename (#747).
  - `joinGroupViaInviteCode(inviteCode)` — maps a page-side rejection (invalid/expired/revoked invite) and a gid-less resolve both to `InvalidInviteCodeError` (400); separates transport death (503).
  - `requireGroupChat(groupId)` (private) — shared preamble resolving a group or throwing `GroupNotFoundError`.
  - `setGroupMessagesAdminsOnly`, `setGroupPicture` (via `GroupChat.setPicture`, not `Client.setProfilePicture`), `deleteGroupPicture`, `setGroupMemberAddMode` (inverted semantics: `adminsOnly=true` means mode `'admins'`), `setGroupInfoAdminsOnly` — all check the discarded boolean refusal contract.
  - `setGroupEphemeral()` — always throws `EngineNotSupportedError`; wwebjs 1.34.7 exposes no disappearing-messages setter after group creation.
  - `getGroupMembershipRequests(groupId)` — resolves the group first (so unknown/non-group ids answer refusal, not an empty list); reads ids via both `_serialized`/`$1` property spellings; drops entries whose wid is unreadable.
  - `approveGroupMembershipRequests` / `rejectGroupMembershipRequests` — both route through `runMembershipRequestAction`, which restates wwebjs's default pacing (`sleep: [250,500]`) explicitly, qualifies participant ids via `toParticipantWid` (an unqualified bare number throws inside the minified bundle), and treats "no error field" as insufficient for success (wwebjs can push `{message:'ServerStatusCodeError'}` with no `error` code at all).

###### `src/engine/adapters/wwebjs-channels.ts`
Channel/Newsletter operations extracted from `WhatsAppWebJsAdapter`; implements the `ChannelCapability` slice.
- **class `WwebjsChannels`** (constructed with `WwebjsEngineHost`):
  - `withPage(context, op)` (private) — shared wrapper classifying a dead page/transport as `EngineTransportError` (503) rather than an opaque 500 under a status that still claims READY.
  - `getSubscribedChannels()` — lists via `client.getChannels()` (cast to `BusinessClient`); reads ids via `_serialized`/`$1` fallback, never `String()`s the object branch (would manufacture the literal `"undefined"`).
  - `createChannel(name, description?)` — wwebjs signals failure by *returning a string* (`'CreateChannelError: …'`) instead of throwing; this is detected and converted to `EngineRefusedError`. Extracts the invite *code* (not the full link) from `result.inviteLink` since that's what `subscribeToChannel` expects.
  - `demoteChannelAdmin()` — always throws `EngineNotSupportedError`. Extensive investigation documented in comments: the underlying WA Web module (`WAWebDemoteNewsletterAdminAction`) still resolves but its exported function is `undefined` on current WA Web, verified live (and a sibling job module is equally dead); wiring it would be a "phantom-support" capability-matrix row. Baileys serves this capability instead.
  - `transferChannelOwnership()` — always throws `EngineNotSupportedError`. Investigated similarly: the page-side check rejects **locally**, in 4-9ms (vs. 352-531ms for a genuine server round-trip), against a subscriber-list cache that the one function able to repopulate it no longer exposes on this WA Web build — not a genuine business-rule refusal. Baileys serves this capability with a real server round-trip.
  - `deleteChannel(channelId)` — throws `EngineRefusedError` on a falsy wwebjs result.
  - `muteChannel(channelId, mute)` — requires the id to end in `@newsletter` first (`getChatById` would otherwise happily create/mute an ordinary chat for a mistyped id, silently muting a real conversation forever); throws `ChannelNotFoundError` otherwise.
  - `getChannelById(channelId)` — wwebjs 1.34.x has no direct lookup API, so it's resolved by filtering the full `getSubscribedChannels()` list.
  - `subscribeToChannel()` — always throws `EngineNotSupportedError`. The interface contract is subscribe-BY-INVITE-CODE, but wwebjs's `subscribeToChannel(channelId)` takes an id and returns a boolean; the old wiring fabricated a fake `{id:"undefined"}` success. An honest 501 stands until the real two-step `getChannelByInviteCode` → `subscribeToChannel(channel.id)` flow is verified live.
  - `unsubscribeFromChannel(channelId)` — throws `EngineRefusedError` on a falsy result.
  - `getChannelMessages(channelId, limit=50)` — resolves the channel from the full subscribed list (no direct-by-id API, #625), throws `ChannelNotFoundError` if absent; substitutes the default limit when the caller passes `<1` because wwebjs's `fetchMessages` fails OPEN (returns everything) on `limit <= 0`.

###### `src/engine/adapters/wwebjs-chats.ts`
Chat-list-level operations (listing, read/unread, pin, archive, mute, presence) extracted from `WhatsAppWebJsAdapter`; implements (parts of) the `ChatCapability` and `PresenceCapability` slices. Presence sends resolve the recipient through the messaging delegate's send-id cache, exactly like a send.
- **class `WwebjsChats`** (constructed with `WwebjsEngineHost` and `WwebjsMessaging`):
  - `getChats()` — the heaviest read this engine serves (serializes every chat over the Chromium CDP bridge); times itself and logs a `warn` if it exceeds 3s (correlates slow dumps with session drops under Chromium contention across sessions); maps to `ChatSummary`, skipping chats without a serialized id; replaces a location message's body (base64 map thumbnail) with `📍` for the preview rather than surfacing raw image data.
  - `sendSeen(chatId)`, `clearChatMessages(chatId)`, `archiveChat(chatId, archive)`, `markUnread(chatId)`, `deleteChat(chatId)` — all return `boolean`, all split a dead transport (`EngineTransportError`, 503) from an ordinary refusal/failure (`false`), reusing the identical try/catch shape. `archiveChat` deliberately discards wwebjs's return value: `archiveChat`/`unarchiveChat` resolve the chat's new archive state (hardcoded `true`/`false` respectively), not a success flag — forwarding it would report every successful unarchive as `success:false`.
  - `markUnread`/`deleteChat` short-circuit with `false` for a channel JID (channels have no `markUnread()`/`delete()`).
  - `requireResolvableChat(chatId)` (private) — shared preamble that turns a page-side rejection or unresolved chat into a 400 `BadRequestException`, used by `muteChat`/`pinChat` because wwebjs's pin/mute rejects deep inside the page (`No LID for user`, a bare TypeError) in a way that otherwise surfaces as an undocumented 500.
  - `muteChat(chatId, muteUntil)` — `null` unmutes; otherwise `Client.muteChat` floors epoch-ms to seconds (Baileys takes raw ms unmodified — a cross-engine asymmetry worth knowing).
  - `pinChat(chatId, pin)` — unpin discards wwebjs's return value (same "state not success" trap as archive); pin DOES forward the return value, since WhatsApp's 3-pin cap genuinely can refuse (`false`) and that's real information the caller needs.
  - `setOnlinePresence(available)` — publishes global presence; NOT best-effort (unlike `sendChatState`) — swallowing a failure here would silently leave the account online after reporting otherwise (referenced incident #871, always-online bot suppressing phone notifications).
  - `sendChatState(chatId, state)` — best-effort typing/recording/clear state; no-ops for a channel JID; logs failures at `warn` not `error` since a migrated contact routinely produces `No LID for user` here with nothing actually broken (#582).

###### `src/engine/adapters/wwebjs-onboarding.ts`
Detects and auto-dismisses WhatsApp Web's post-link "What's new" onboarding modal, which has no wwebjs API (#3550 open) and which, if left unacknowledged, causes WhatsApp to unlink the companion device after ~5 minutes. Self-contained in-page DOM probes plus a watcher loop class.
- `ONBOARDING_DEFAULT_CONTINUE_LABEL` — `'Continue'`, the English confirm-button label.
- `resolveOnboardingContinueLabels()` — reads `WWEBJS_ONBOARDING_CONTINUE_LABELS` (comma-separated) per call (not cached) so an operator can add non-English labels to a running deployment without a restart.
- `probeOnboardingModal(options?)` — **exported, self-contained function stringified into the page via `page.evaluate`** (cannot close over module scope — every input arrives as an argument). Clicks the modal's Continue button if visible. Uses the visible BUTTON (exact label match) as the presence signal rather than loose heading text (`textContent` concatenates every descendant, so an innocuous chat-list message containing "what's new" would otherwise false-positive and wrongly flip a healthy session out of READY). Bounded ancestor walk (8 levels) checks for the English "what's new" heading near the button unless the label is operator-supplied (`headingOptionalFor`), in which case the heading check is skipped entirely since the default English heading regex can't match a localized modal anyway.
- `collectDialogDiagnostics()` — **also exported/self-contained for `page.evaluate`**. Diagnostic-only (clicks nothing) fallback that reports what dialog(s) ARE on screen when the probe above finds nothing to click, so an unrecognized modal (changed title, different language) is visible in logs instead of silently expiring into an unlink. Scoped strictly to `[role="dialog"]`/`[aria-modal="true"]` containers so ordinary chat content is never captured; every captured string is sanitized (control characters stripped) to prevent log-injection; bounded to 3 dialogs × 5 buttons, truncated strings.
- `WwebjsOnboardingWatcherHost` interface — host surface closures (client/status getters+setters, teardown/disconnect flags, callbacks).
- **class `WwebjsOnboardingWatcher`** (constructed with the host):
  - `startOnboardingWatcher()` — idempotent self-rescheduling `setTimeout` loop (every 5s, `.unref()`d), stops itself at a 5-minute lifetime cap (the modal is one-shot per account) or on teardown/disconnect/status change.
  - `clearOnboardingWatcher()` — cancels the timer.
  - `dismissOnboardingModalIfNeeded()` (private) — one tick: races the page evaluate against a 5s timeout; on "nothing to click" runs the diagnostics probe and logs a deduplicated warning per distinct dialog signature; on a successful click, increments a dismiss counter and escalates to `reportActionRequired` after 5 consecutive clicks (`ONBOARDING_MODAL_MAX_DISMISS_CLICKS` — chosen because a legitimate multi-screen flow is typically ≤3 screens, so 5 repeated clicks is real evidence the click isn't landing, not normal multi-step dismissal); a rejected/timed-out evaluate is treated as "can't reach the page right now" (debug log only), never as a status-changing signal, since a wedged probe must not take a healthy session out of READY.
  - `reportActionRequired(reason)` — moves status to `ACTION_REQUIRED` and fires `onActionRequired`, but only if no other status change already landed first (avoids clobbering a teardown/failure that raced it).

###### `src/engine/adapters/wwebjs-reconcile.ts`
Readiness reconciliation extracted from `WhatsAppWebJsAdapter`: handles the post-authentication window where wwebjs's own `ready` event is missed or the inbound event bridge failed to attach, plus a one-shot page reload self-heal.
- `WwebjsReadyReconcileHost` interface — host closures (client/status getters+setter, callbacks, `markReadyFromClientInfo`, `recoverFromStuckAuth`).
- `READY_RECONCILE_INTERVAL_MS` = 2000; `READY_RECONCILE_TIMEOUT_MS` = 90,000 (exported); `READY_RECONCILE_BRIDGE_RELOAD_GRACE_MS` = 45,000 (exported) — deliberately set beyond wwebjs's own internal 30s `window.WWebJS` poll budget, with room left for the rest of the readiness pipeline before the outer 90s deadline, so a reload-on-stale-bridge heuristic doesn't abort a healthy (just slow) attach.
- **class `WwebjsReadyReconcile`** (constructed with the host):
  - `scheduleReadyReconcile()` — starts a self-rescheduling tick (checks deadline at the TOP of each tick, before probing, so a hung `getState()` call can't defeat the ceiling). At timeout: distinguishes a "CONNECTED but event bridge never attached" session (`FAILED` status, credentials preserved — only the browser instance is broken, so wiping auth would be the wrong fix) from a genuinely stuck-after-QR session (clears auth via `recoverFromStuckAuth()` to force a fresh re-pair). Probe runs fire-and-forget with at-most-one in flight (a hung probe is skipped, not awaited, so it can't stall the loop).
  - `clearReadyReconcile()` — resets all timer/counter state.
  - `isClientRuntimeReady()` (private) — probes `client.getState() === WAState.CONNECTED`, `client.info.wid.user` presence, the patched `eventsAttached` flag (added by `scripts/patch-wwebjs-ready-sync.js`; `false` means the page→Node bridge is dead even though WA reports CONNECTED — an unpatched tree reports `undefined`, which falls through to legacy checks rather than refusing readiness it can never signal), and finally an in-page `window.WWebJS` existence check.
  - `maybeReloadDeadBridge()` (private) — one-shot page `.reload()` when the bridge is confirmed dead past the grace period; wwebjs re-runs its full injection on `framenavigated`, so this is the cheapest full reinjection that preserves the saved session.

###### `src/engine/adapters/wwebjs-status.ts`
Status/Stories operations (post text/image/video/voice status, read/delete status) extracted from `WhatsAppWebJsAdapter`; implements the `StatusCapability` slice.
- `toStatusResult(msg)` — maps a posted status `Message` to `StatusResult`; throws `InternalServerErrorException` (not a bare `Error`, since there's no global exception filter) when `msg` is absent — unlike an ordinary send, an absent status message is unambiguous proof nothing was posted (not the "maybe sent, maybe not" ambiguity a send's `Msg.get` miss carries), so there's no good-faith 201 to fabricate. Reads `$1` id fallback before using the empty sentinel.
- **class `WwebjsStatus`** (constructed with `WwebjsEngineHost`):
  - `withPage(context, op)` (private) — same dead-transport-to-503 wrapper pattern as other delegates.
  - `getContactStatuses()` / `getContactStatus(contactId)` — read via `getBroadcasts()`/`getBroadcastById()`; a contact with no active story resolves to an "empty" Broadcast object, guarded explicitly before dereferencing.
  - `collectStatuses(broadcasts)` (private) — flattens broadcasts' messages into neutral `Status[]`; collapses type to image/video/voice/text (`MessageTypes.VOICE` is wwjs's name for `ptt`); reuses the live-path's capped inbound-media download (`host.capInboundMediaFor`) so a seeded status renders identically to a live one; `expiresAt` = timestamp + 24h.
  - `postTextStatus(text, options)` — posts to `status@broadcast` with `backgroundColor`/`fontStyle` extras.
  - `postImageStatus` / `postVideoStatus` / `postVoiceStatus` — all route through `postMediaStatus`; voice status additionally passes `sendAudioAsVoice: true` to make the bubble a voice note (`isPtt`) rather than a plain audio file.
  - `warnStatusRecipientsOnce(options)` (private) — logs once (not per-call) that wwebjs ignores a recipients allow-list for status posts (broadcasts to the account's full status-privacy audience instead) — unlike the Baileys engine, which does honor it.
  - `deleteStatus(statusId)` — revokes via `revokeStatusMessage`.

###### `src/engine/adapters/wwebjs-host.ts`
Defines the `WwebjsEngineHost` interface: the shared closures object `WhatsAppWebJsAdapter` builds once and hands to every extracted delegate (groups, messaging, contacts, chats, etc.) so none of them touch adapter lifecycle state directly. Pure interface, no implementation.
- `WwebjsEngineHost` — exposes `ensureReady()`, `getClient()`, `logger`, `isPageTransportError()`/`reportIfPageTransportError()` (dead-page classification), `ensureNotChannelRecipient()`, `getNumberId()`, `capInboundMediaFor()` (the shared capped-download path), `config` (exposes `sessionId` for the send-id cache's persisted phone→lid mappings), `getCallbacks()` (read per-event since callbacks are installed after delegates are built), `getSelfWid()`.

###### `src/engine/adapters/wwebjs-proxy.ts`
Per-session proxy URL validation and Puppeteer launch-arg construction for whatsapp-web.js; no capability-slice mapping (infrastructure only).
- `isSupportedProxyUrl(url)` — whether a proxy URL's scheme is one of `http:`/`https:`/`socks4:`/`socks5:`; defense-in-depth for a stored proxy value that bypassed DTO validation (e.g. loaded from DB on restart). Explicitly NOT SSRF-blocked: a per-session proxy is deliberately operator-chosen egress (a loopback proxy sidecar is a legitimate setup).
- `ProxyLaunchConfig` interface — `serverArg` (credential-less `--proxy-server` value), optional `proxyAuthentication` (username/password for wwebjs's `page.authenticate`-based HTTP/HTTPS proxy auth), `socksAuthUnsupported` (flag for the caller to warn the operator rather than fail with an opaque nav timeout).
- `buildProxyLaunchConfig(url)` — splits credentials out of the URL since Chromium ignores credentials embedded directly in `--proxy-server`; SOCKS proxies cannot be authenticated by Chromium at all (#628), so SOCKS credentials are surfaced via the `socksAuthUnsupported` flag instead of being silently dropped or causing an unexplained failure. Call only after `isSupportedProxyUrl` passes.

###### `src/engine/adapters/wwebjs-backport-check.ts`
Startup guard verifying that a required install-time patch (`scripts/patch-wwebjs-201832.js`) was actually applied to the installed whatsapp-web.js package. No capability-slice mapping (infrastructure/diagnostics).
- `BACKPORT_MISSING_MESSAGE` — user-facing warning text pointing at the manual-patch command and the troubleshooting doc.
- `isBackportMissing(wwjsDir?)` — checks `Message.js` for the marker regex `/_normalizeId\(|\.\$1/`. Context: WhatsApp Web 2.3000.x renamed `id._serialized` to `id.$1`; an unpatched wwebjs 1.34.7 reading the old name breaks opaquely once WA Web serves the new shape (sends resolve with no message object at all; chat/media reads throw minified `r: r`, #889) with no indication of the root cause. Fails safe: any uncertainty (package unresolvable, sources pruned, bundled install) returns `false` rather than falsely alarming.

###### `src/engine/adapters/wwebjs-catalog.ts`
Catalog/commerce operations extracted from `WhatsAppWebJsAdapter`; implements the `CatalogCapability` slice entirely as honest unsupported stubs, since whatsapp-web.js exposes no Catalog API at all (no `Client.getCatalog`/`getProducts`/`getProduct` symbols).
- **class `WwebjsCatalog`** (constructed with `WwebjsEngineHost`): `getCatalog()`, `getProducts(options?)`, `getProduct(productId)`, `sendProduct(chatId, productId, body?)`, `sendCatalog(chatId, body?)` — all call `ensureReady()` then unconditionally throw `EngineNotSupportedError`.

###### `src/engine/adapters/wwebjs-calls.ts`
Incoming-call handling extracted from `WhatsAppWebJsAdapter`: the `call` client event handler, a live-call cache, and call rejection; implements the `CallCapability` slice (receive side).
- `WwebjsCallsHost` interface — `logger`, `isTearingDown()`, `getCallbacks()`.
- **class `WwebjsCalls`** (constructed with the host):
  - `LIVE_CALL_TTL_MS` = 2 minutes (static) — covers the ringing window (~1 min) with margin.
  - `liveCalls` — public `Map<callId, {call, expiresAt}>`; public specifically so the adapter's `liveCalls` alias (read via a cast) and lifecycle teardown continue to work against the same map.
  - `handleIncomingCall(call)` — maps a wwebjs `Call` to neutral `IncomingCallEvent`; drops calls during/after teardown, malformed calls (missing id/from), and own-account (`fromMe`) calls; **deduplicates** — wwebjs's patched `internalCallMap.set()` fires this handler on every write including updates to an already-ringing call, so the cache insert is checked first and `onCall` only fires for ids not already live (otherwise one call emits several `call.received` events).
  - `cacheLiveCall(callId, call)` (private) — lazy-expiry cache: evicts expired entries on each insert (bounds growth without a per-entry timer); returns whether the call was newly inserted.
  - `rejectCall(callId)` — evicts the entry on ANY attempt (a rejected/ended call doesn't become rejectable again); throws `CallNotFoundError` (404) for an unknown/expired id; propagates a library `reject()` failure as-is.
  - `clearLiveCalls()` — drops all cached calls, called when the client goes away so a later `rejectCall` reports not-found instead of acting on a destroyed page.

###### `src/engine/adapters/wwebjs-group-events.ts`
Group-notification client events (`group_join`/`group_leave`/`group_update`/`group_membership_request`) extracted from the adapter's event wiring — pure mapping from wwebjs `GroupNotification`s to neutral `GroupEvent`s. Never touches connection-state/lifecycle latches.
- `parseWwebjsOnOff(body)` — interprets `'on'/'true'` → `true`, `'off'/'false'` → `false`; `undefined` for anything else, letting the caller omit rather than guess the field.
- `wwebjsGroupUpdateChanges(notification)` — reduces a `group_update` notification to a neutral `changes` delta: `subject`/`description` carry the new value directly in `body`; `announce`/`restrict` (neutral: `locked`) are on/off text. Compares `notification.type` as a string because runtime gp2 subtypes can exceed the `GroupNotificationTypes` enum (e.g. a `'locked'` rename of `'restrict'`). Unrecognized/unparseable changes still emit the event, just with an empty delta rather than a dropped event.
- `wwebjsGroupRecipientIds(notification)` — coerces `recipientIds` entries to neutral id strings; these are assigned straight through from the wire (bypassing upstream's normal id normalization), so an entry can arrive as a raw id object on a WA Web build that renamed `_serialized`→`$1` (#747); unreadable entries are dropped rather than forwarded as `"undefined"`.
- `WwebjsGroupEventsHost` interface — `logger`, `getCallbacks()`.
- `registerWwebjsGroupEvents(client, host)` — wires all four group notification event names to `handleGroupNotification`.
- `handleGroupNotification(host, kind, notification)` — drops notifications without a `chatId`; for `join_request` with zero recipients, treats it as a self-request (the author IS the requester) and synthesizes `participantIds: [actorId]`, dropping entirely if even the actor is missing; for `update`, attaches the `changes` delta; wraps everything in try/catch (malformed notification logged and dropped, never rethrown into the emitter).

###### `src/engine/adapters/wwebjs-labels.ts`
Chat-label operations (WhatsApp Business only) extracted from `WhatsAppWebJsAdapter`; implements the `LabelCapability` slice.
- **class `WwebjsLabels`** (constructed with `WwebjsEngineHost`):
  - `getLabels()` — lists via `BusinessClient.getLabels()`.
  - `getChatsByLabel(labelId)` — upstream dereferences the label without an existence check, so an unknown id (or ANY id on a personal/non-Business account, whose label collection is empty) throws a page-side `TypeError`; caught and remapped to `LabelNotFoundError` (404), except a dead-page transport error which is still split out as 503. Skips chat entries wwebjs yields as fully `undefined` (stale label→chat references).
  - `getLabelById(labelId)` — returns `null` for an unknown label.
  - `getChatLabels(chatId)` — returns `[]` immediately for a channel JID (channels have no `getLabels()`, would otherwise TypeError → 500).
  - `addLabelToChat` / `removeLabelFromChat` — both delegate to `changeChatLabel`.
  - `changeChatLabel(chatId, labelId, add)` (private) — wwebjs has no single-label add/remove primitive; `addOrRemoveLabels(ids, chats)` REPLACES the chat's entire label set, so this reads the current set, mutates it, and writes the whole set back. Noted race: two concurrent single-label writes to the same chat can lose an update (last-write-wins on the full-set replace) — accepted as fine for low-frequency label admin. Throws `ChatLabelsUnsupportedError` (422) for a channel, or when wwebjs throws the page-context `[LT01] Only Whatsapp business` error on a personal account.

###### `src/engine/adapters/wwebjs-contacts.ts`
Contact operations extracted from `WhatsAppWebJsAdapter`; implements the `ContactCapability` slice.
- **class `WwebjsContacts`** (constructed with `WwebjsEngineHost`):
  - `getContacts()` — maps the full contact list to neutral `Contact[]`.
  - `getContactById(contactId)` — distinguishes a dead transport (503) from a genuinely absent contact (`null`, 404) — notes that unlike the avatar lookup, a throw here CAN legitimately mean "not found" since the underlying `window.WWebJS.getContact` has no try/catch and throws a TypeError on a null lookup.
  - `getNumberId(number)` — reads both `_serialized`/`$1` property spellings so a WA Web rename doesn't make every number look unregistered.
  - `checkNumberExists(number)` — thin wrapper: `getNumberId(number) !== null`.
  - `resolveContactPhone(contactId)` — queries ONE id at a time via `getContactLidAndPhone` (the batch form is prone to "Evaluation failed" and rate-limiting per upstream issues #3857/#3969); an empty/absent `pn` RESOLVES to `null` (definitive "no mapping"), while a thrown error PROPAGATES rather than being swallowed — important because the lid resolver must not mistake a transient failure for "no phone" and overwrite a valid stored mapping; the HTTP-facing caller swallows to null at its own boundary.
  - `upsertContact(contactId, firstName, lastName='')` — wwjs addresses the addressbook entry by phone number, not JID; `lastName` passed as `''` rather than `undefined` (would otherwise literal-stringify); `syncToAddressbook` deliberately left at its default `false` (device-addressbook write is heavier/more consent-sensitive than a WhatsApp-only contact save).
  - `deleteContact`, `blockContact`, `unblockContact` — straightforward.
  - `getBlockedContacts()` — returns ids only (neutral common subset with Baileys); drops entries with unreadable wids.
  - `getProfilePicture(contactId)` — on throw, ALWAYS rethrows as `EngineTransportError`, never swallows to `null` — wwebjs throws for two indistinguishable reasons (contact resolution failure vs. profile-pic bridge failure) and returning `null` would be byte-identical to a genuine "no avatar" 200 response, corrupting any caller cache. Explicitly documented as the OPPOSITE behavior from the Baileys adapter's same interface method (which swallows to null) — the two engines disagree about what a throw means here, so this is deliberately NOT shared/harmonized into common code.

###### `src/engine/adapters/wwebjs-message-events.ts`
Message-domain client events (`message`, `message_create`, `message_ack`, `message_revoke_everyone`, `message_reaction`, `message_edit`) extracted from the adapter's event wiring — pure mapping to neutral events. Connection-state events live elsewhere (lifecycle module); this file never touches lifecycle latches.
- `registerWwebjsMessageEvents(client, host)` — wires all six listeners:
  - `message` — builds the base via `buildIncomingMessageBase`, then async-enriches: contact (synchronous fields only, `WEBHOOK_CONTACT_DETAILS=true` opts into the full field set via `mapContactFields`), location, capped inbound media (`host.capInboundMediaFor`), quoted message, and call-log detail (`extractWwebjsCall`) so missed/video calls render a labeled bubble on the live path too. All enrichment steps individually try/catch so one failure doesn't drop the whole message.
  - `message_create` — fires for every self-authored message including ones composed on a linked phone (never delivered via `message`); forwarded ONLY when `fromMe` (incoming is already handled by `message`); enriches with media through the same capped path.
  - `message_ack` — maps the wwebjs ack integer to neutral `DeliveryStatus`; drops an ack whose id is unreadable (reads `$1` fallback first) rather than letting it reach the DB UPDATE as `NULL` — which would match zero rows (`x = NULL` is never true in SQL) and silently strand the message at SENT, burning the one-shot retry.
  - `message_revoke_everyone` — maps `after`/`before` to `RevokedMessage`; `revokedId` (from `before.id`) needs the `$1` fallback even on a PATCHED tree, since `Client.js` overwrites the normalized id with a raw spread of `protocolMessageKey` that neither the structure constructor nor the injected serializer normalizes — the one place a patched build still hands back a raw key.
  - `message_reaction` — maps `Reaction.msgId` (assigned straight through from the wire, bypassing upstream normalization — same pattern as `protocolMessageKey`) with `$1` fallback, final fallback to `''` (matches Baileys' no-id sentinel) because TypeORM DROPS an `undefined` where-clause condition (would match an arbitrary row and misattribute reactions), whereas `''` matches nothing and returns cleanly.
  - `message_edit` — wwebjs keeps `message.timestamp` at ORIGINAL creation time, so this stamps the edit at receipt time instead (needed for ordering multiple edits), then projects through the shared `buildIncomingMessageBase`/`buildEditedMessage` mappers.

###### `src/engine/adapters/wwebjs-profile.ts`
Own-account profile operations extracted from `WhatsAppWebJsAdapter`; implements (part of) the `ProfileCapability` slice.
- **class `WwebjsProfile`** (constructed with `WwebjsEngineHost`):
  - `withPage(context, op)` (private) — same dead-transport-to-503 wrapper pattern used across delegates.
  - `createCallLink(type, startTime)` — maps the neutral `'audio'` type to wwebjs's `'voice'` (wwebjs only accepts `'voice'`/`'video'`); throws `EngineRefusedError` on wwebjs's documented empty-string-on-failure return rather than propagating the falsy value.
  - `deleteProfilePicture()` — `Client.deletePicture` actually has THREE outcomes despite its `Promise<boolean>` type: `undefined` (nothing to delete, no-op), `true` (success), `false` (genuine refusal). Only an explicit `false` throws `EngineRefusedError`; naive falsy-checking would wrongly turn a repeat/no-op delete into a refusal.
  - `setProfileName(name)` — throws `EngineRefusedError` on falsy result (WhatsApp refused the rename).
  - `setProfileStatus(status)` — straightforward, no refusal signal to check.
  - `setProfilePicture(media)` — converts via `toMessageMedia`, throws `EngineRefusedError` on falsy result.

###### `src/engine/adapters/wwebjs-stuck-auth.ts`
Stuck-auth detection/recovery and the shared LocalAuth-profile removal routine extracted from `WhatsAppWebJsAdapter` — covers what happens when a session authenticates but never reaches runtime readiness, plus the auth-dir cleanup both that recovery and a WhatsApp-initiated unlink share.
- `WwebjsStuckAuthHost` interface — `logger`, `config`, client getter/setter, `setStatus`, `getCallbacks()`.
- **class `WwebjsStuckAuth`** (constructed with the host):
  - `recoveryAttempted` (private) — guards the self-heal to run at most once per engine instance, standalone-use fallback only.
  - `recoverFromStuckAuth()` — the one-shot budget is decided SYNCHRONOUSLY, before any destructive I/O, preferring the session-owned `claimStuckAuthRecovery` callback (authoritative — survives across adapter regeneration on reconnect, so an automatic reconnect building a fresh adapter instance can't reset the budget and wipe LocalAuth repeatedly) over the instance-local boolean fallback (used only when no session lifecycle wraps the adapter, e.g. tests). Fails CLOSED: a throwing/exhausted claim marks the session `FAILED` without touching the auth directory at all, so a wedged claim path can never destroy the only copy of credentials. On a granted claim: nulls out the client reference, clears LocalAuth, sets status `DISCONNECTED`, fires `onDisconnected` (drives the lifecycle's reconnect → fresh QR), and destroys the wedged client in the background (non-blocking, so a hung Chromium `destroy()` can't block or skip recovery).
  - `clearLocalAuth()` — removes the session's LocalAuth directory with `maxRetries: 4` (mirrors LocalAuth's own default) because on a WhatsApp-initiated unlink the library never closes the browser, so Chromium is still rotating IndexedDB files underneath a concurrent tree-walk/removal, causing a bare `rm` to fail with `ENOTEMPTY` (#1072; Node's own default retry count is 0). Logs a `warn` at the point of deletion (not just on later symptoms) because this destroys the ONLY copy of the session's credentials (#981) — the alternative silent failure mode is indistinguishable from a WhatsApp-side logout.

##### Shared / cross-engine adapter infrastructure

###### `src/engine/adapters/message-mapper.ts`
Shared message/contact field-mapping helpers used by the whatsapp-web.js message-event handlers (and reused by other wwebjs delegates) to build neutral `IncomingMessage`/`EditedMessage`/`MessageContact` shapes from raw wwebjs payloads, keeping mapping logic unit-testable without a live `Message`/`Contact` instance.
- `mapWwebjsMessageType(raw)` — maps wwebjs `MessageTypes` strings to the neutral `MessageType` union (`'chat'`→`'text'`, `'ptt'`→`'voice'`, `'vcard'`/`'multi_vcard'`→`'contact'`, `'call_log'`→`'call'`, `'poll_creation'`→`'poll'`, etc.); anything unmapped becomes `'unknown'`.
- `RawMessageFields` interface — the synchronously-available subset of wwebjs `Message` fields used to build the base message; `id` is typed as the raw wid shape (not `{_serialized: string}`) specifically so the `$1` minifier-rename fallback (#747) is representable/readable without a cast.
- `buildIncomingMessageBase(msg)` — builds the synchronous base of an `IncomingMessage`. Determines `chatId` as `to` when `fromMe` else `from` (direction-dependent). Reads id via `_serialized` then `$1` fallback, defaulting to `''` only as a last resort (never `undefined`, since the sentinel is normalized to SQL `NULL` wherever persisted — critical because a non-partial unique index on `(sessionId, waMessageId)` would otherwise collide two such messages on `''`). Sets `isGroup` from the `@g.us` suffix, `kind` via `chatKind()`, `isStatusBroadcast` for the `status@broadcast` pseudo-JID, `author` for group sender identification, `mentionedIds`, `isLidSender` flag (for `@lid` senders, used by downstream code to opt into phone resolution, #263), synchronous push name from `_data.notifyName`, and `ephemeralDuration` when set.
- `buildEditedMessage(message, hasMedia)` — projects a neutral message base into the public edit-event contract shared across both engine adapters, preventing drift on identity/direction/group/type fields between them.
- `RawContactFields` interface — the synchronous (already-resolved, no network call) subset of wwebjs `Contact` fields.
- `mapContactFields(contact, full=false)` — maps only set values, never performs a network call (would risk rate-limiting on a per-message path). Default (`full=false`) returns just `name`/`pushName` (long-standing payload shape); `full=true` (operator opt-in via `WEBHOOK_CONTACT_DETAILS`) returns the complete field set including id, number, business flags, verification, labels, etc.

###### `src/engine/adapters/chromium-profile-hygiene.ts`
OS/container-level cleanup run before a whatsapp-web.js browser launches — explicitly NOT about the WhatsApp protocol (changes with Docker/Puppeteer/host platform, never with WhatsApp), which is why it lives outside the protocol adapter. Both functions are best-effort by contract: log at `debug`, never throw.
- `killOrphanedChromiumProcesses(sessionId, logger)` — SIGKILLs any Chromium process orphaned by a prior process lifetime of this app (e.g. after `kill -9`/crash/host reboot, where Puppeteer's exit hook never ran). Identifies orphans via a `--openwa-session=<id>` marker arg appended at launch (Chromium ignores the unknown flag; it's purely a `ps` label). Uses `execFile` (no shell — not injectable) with a raised `maxBuffer` (8MB, since `ps -eo args` on a busy host with many Chromium renderer flags can exceed the 1MB default). Matches the marker with a token-exact regex (not substring) specifically because a substring match would let session `sales` kill the live browser of a sibling session `sales2` whose marker shares a prefix. Also requires the matched process name to look like a browser (`chrome|chromium|headless`) so a stray `grep --openwa-session=…` probing the process table is never killed. Skips cleanly on unsupported platforms (only darwin/linux).
- `removeStaleSingletonFiles(sessionId, sessionDataPath, logger)` — removes Chromium's `SingletonLock`/`SingletonSocket`/`SingletonCookie` from the LocalAuth profile directory (same dir `clearLocalAuth` in wwebjs-stuck-auth.ts removes) before launch, since a hard-killed Chromium leaves them behind and (e.g. under Docker PID reuse) they can block the next launch otherwise.

###### `src/engine/adapters/inbound-media-cap.ts`
Shared inbound-media safety limits (size cap, concurrency, timeout, and the final byte-budget enforcement) used by both engine adapters' incoming-message/media handling pipelines.
- `inboundMediaMaxBytes()` — resolved per-download cap (default 50 MiB), env override `MEDIA_DOWNLOAD_MAX_BYTES` shared with the outbound download cap; garbage/non-positive overrides fall back to default.
- `inboundMediaConcurrency()` — max concurrent inbound downloads (default 4, env `INBOUND_MEDIA_CONCURRENCY`); bounds memory since each download fully materializes a decrypted buffer in heap — an unbounded fire-and-forget loop would let a sender flood the gateway with N parallel multi-MB allocations.
- `inboundMediaTimeoutMs()` — per-download wall-clock timeout (default 30s, env `MEDIA_DOWNLOAD_TIMEOUT_MS`).
- `withInboundDownloadTimeout(promise, timeoutMs, onTimeout?)` — races a download against a timeout; the byte cap and concurrency limiter don't bound TIME, so a slow-trickling remote sender could otherwise hold a concurrency slot indefinitely (a slow-loris). On timeout, resolves `null` (the same "no usable media" sentinel the byte-cap abort uses) and invokes an optional `onTimeout` hook to abort the source where abortable (e.g. a Baileys stream); a non-abortable source (wwjs's `downloadMedia()`) can't be stopped, so that caller must hold its concurrency slot until the real download eventually settles. Swallows a late post-settle rejection so it can't surface as an unhandled rejection.
- `isMediaDownloadEnabled()` — global kill switch, env `MEDIA_DOWNLOAD_ENABLED` (`'false'`/`'0'`/`'no'`, case/whitespace-tolerant, disables).
- `chatHistoryMediaBudgetBytes()` — aggregate base64 budget for ONE `getChatHistory(includeMedia=true)` call (default 25 MiB, env `CHAT_HISTORY_MEDIA_BUDGET_BYTES`); bounds the AGGREGATE across a whole history page, since the per-message cap alone would let a 100-message history stack ~100×50MiB of base64 into a single JSON response.
- `ingestMediaBudgetBytes(perItemMaxBytes)` — separate, larger aggregate budget for ingestion passes (e.g. status seeding) that supply their own per-item cap; derived as `max(chatHistoryMediaBudgetBytes(), perItemMaxBytes × 4 × 1.37)` — `INGEST_MEDIA_BUDGET_ITEMS=4` sized for a realistic story feed of full-size items while still bounding worst case (prevents a 50-item seed at a 10MiB cap from allocating ~650MiB of base64 on the heap at connect time).
- `coerceDeclaredSize(value)` — coerces a sender-declared size (number, Long-like `{toNumber()}`, numeric string, or absent) to a finite byte count; unknown/garbage → `0` meaning "don't pre-gate" (the streaming abort is the real backstop), never `NaN`.
- `capInboundMedia(args)` — the SECONDARY/final guard: within cap, base64-encodes lazily via `toBase64()` callback (never encoded if over cap, avoiding the +33% copy for discarded data); over cap, returns an `{mimetype, filename?, omitted:true, sizeBytes}` marker instead of the blob — keeps the `media` field present (contract with n8n/dashboard consumers) while never encoding/persisting/webhooking/broadcasting the oversized payload. Explicitly documented as NOT bounding the decrypted-download allocation itself (runs after bytes are already in heap) — that's the job of the pre-download declared-size gate plus streaming abort plus the concurrency limiter above; this is the last line of defense, not the OOM guard.

###### `src/engine/adapters/safe-link-preview.ts`
SSRF-hardened link-preview generator shared by both engines, deliberately bypassing Baileys' own built-in generator.
- `SafeUrlInfo` interface — the preview payload shape in Baileys' own field names (`'matched-text'`, `'canonical-url'`, `title`, `description?`). `matched-text` preserves the URL exactly as it appeared in the message (not the normalized form) because WhatsApp uses it to anchor the preview rendering to the right span of text.
- `generateSafeLinkPreview(matchedText, opts?)` — **security-critical**: Baileys' bundled generator delegates to `link-preview-js`, which carries an *unpatched* SSRF advisory (GHSA-4gp8-rjrq-ch6q, CWE-918 — IPv6/internal-loopback attacks). Since the input is attacker-influenced (any URL pasted into an inbound message triggers a server-side fetch), that generator is never reached — this function is passed as `getUrlInfo` in the caller's send options, which Baileys spreads last and so wins over its own hardcoded default. Delegates the actual fetch to `withSafeFetch` (from `common/security/ssrf-guard`), which validates the destination AND pins the connection to the vetted resolved address — closing the DNS-rebinding window a naive validate-then-fetch approach would leave open (a hostname resolving publicly once, then to `127.0.0.1` on the actual connection). Honors the deployment's `WEBHOOK_SSRF_PROTECT`/`SSRF_ALLOWED_HOSTS` settings. Returns `undefined` on ANY failure (blocked destination, DNS failure, timeout, malformed response, non-HTML content-type) — a preview is decoration and must never fail a message send. Default `timeoutMs=3000`, `maxBytes=512KiB` (a preview only needs `<head>`, which arrives first — no reason to accept a multi-GB response from an attacker-chosen host). Sends an `accept: text/html,application/xhtml+xml` header so a server can't stream back something huge to be read and discarded. Extracts `og:title`/`og:description` (with fallback to `<title>` and `name="description"` meta) via regex; falls back to the hostname as title when none found (a fact about the URL, not an invented value) since WhatsApp requires a title field.
- `normaliseUrl(matchedText)` (private) — accepts only `http`/`https`, explicitly rejecting any string that already carries a non-http(s) scheme (`file:`, `ftp:`, etc.) rather than blindly prefixing `https://` onto it — prefixing would turn `file:///etc/passwd` into a syntactically-valid `https://file:///etc/passwd` that then sails through the scheme filter it exists to enforce. A bare `example.com` (no scheme) gets `https://` prefixed, matching how a human reader would interpret it.
- `readCapped(response, maxBytes)` (private) — streams and decodes the response body up to `maxBytes`, cancelling the reader once the cap is hit.
- `firstMatch(html, patterns)` (private) — returns the first regex capture group match across a list of fallback patterns.
- `decodeEntities(value)` (private) — decodes the handful of HTML entities likely to appear in title/description text; decodes `&amp;` LAST deliberately, so a double-encoded `&amp;lt;` doesn't collapse into `<`.

###### `src/engine/adapters/vcard.ts`
Builds a vCard string for contact-card sends; shared by both engine adapters.
- `buildVCard(contact)` — produces a `VERSION:3.0` vCard (`BEGIN:VCARD`/`FN`/`TEL;type=CELL;type=VOICE;waid=…`/`END:VCARD`). Strips CR/LF from name and number before use so a crafted value (e.g. `name = "Alice\r\nEMAIL:..."`) cannot inject additional vCard lines/fields. Escapes vCard structural characters (`\`, `;`, `,`) per RFC 6350 §3.4 in the name field, escaping backslash FIRST so backslashes added for `;`/`,` escaping aren't themselves double-escaped (source uses double-backslash JS literals deliberately — `'\\;'` is a literal backslash+semicolon; a single `'\;'` would collapse to just `;'` via JS's unknown-escape handling). The `waid` parameter is reduced to digits only; the TEL value itself is used as-is after CR/LF stripping (not unconditionally `+`-prefixed).

---

## 6. Modules — Core Messaging

This section documents eleven `src/modules/**` subsystems of the OpenWA NestJS backend: `auth`, `session`, `message`, `channel`, `chat-media`, `media`, `call`, `events`, `webhook`, `status`, and `status-store`. All paths are relative to `backend-node/`.

---

### auth

The `auth` module is the API-key authentication/authorization system for the whole gateway. It owns the `ApiKey` entity, the global `ApiKeyGuard` (registered as `APP_GUARD`, so every route is protected unless marked `@Public()`), role-based access control (`ADMIN`/`OPERATOR`/`VIEWER`), per-key IP and session scoping, usage-stat tracking, and the API-key lifecycle REST surface. It is `@Global()`, so `AuthService` is injectable anywhere without importing `AuthModule`.

##### `src/modules/auth/api-key-hash.ts`
Hashes raw API keys for storage/lookup. `hashApiKey(rawKey, pepper?)` uses HMAC-SHA256 when a server-side `API_KEY_PEPPER` is configured, else plain SHA-256 (backward compatible with existing stored hashes).

##### `src/modules/auth/api-key-usage-tracker.service.ts`
**`ApiKeyUsageTracker`** — coalesces per-request `usageCount`/`lastUsedAt` writes to at most one DB write per key per 60s window, so the authentication hot path isn't a DB write per request.
- `record(apiKey)`: increments the in-memory pending counter and mutates the passed entity so the caller's response reflects the true (not-yet-flushed) count; flushes to DB only once the window has elapsed. Never throws.
- `forget(keyId)`: drops a key's pending counters (used on delete/revoke so a deleted key's accumulator doesn't resurrect the row via an `update`).
- `flushOnShutdown()`: best-effort bounded (5s) flush of all pending counters before the DB connection closes.
- (private) `flushPending()`: atomic `increment()` per key; failed keys stay pending for retry.

##### `src/modules/auth/auth-validate.controller.ts`
**Controller `AuthValidateController`** (`@Controller('auth')`)
| Method | Path | Handler | Description | Guards/Decorators |
|---|---|---|---|---|
| POST | `/auth/validate` | `validate` | Validates the presented `X-API-Key`; returns `{ valid, role }`. Relies entirely on the global `ApiKeyGuard` having already authenticated the request. | Behind global `ApiKeyGuard` (no `@Public()`) |

##### `src/modules/auth/auth.controller.ts`
**Controller `AuthController`** (`@Controller('auth/api-keys')`, class-level `@RequireUnscopedKey()` — session-scoped keys cannot manage keys at all)
| Method | Path | Handler | Description | Guards/Decorators |
|---|---|---|---|---|
| POST | `/auth/api-keys` | `create` | Create a new API key (returns the raw key once). Audits `API_KEY_CREATED`. | `@RequireRole(ADMIN)` |
| GET | `/auth/api-keys` | `findAll` | List all API keys (no raw key, only `keyPrefix`). | `@RequireRole(ADMIN)` |
| GET | `/auth/api-keys/:id` | `findOne` | Get one API key's details. | `@RequireRole(ADMIN)` |
| PUT | `/auth/api-keys/:id` | `update` | Update name/role/allowedIps/allowedSessions/expiresAt. Evicts the key's live WebSocket sockets if authorization-relevant fields changed. Audits `API_KEY_UPDATED`. 409 if it would strip the last usable admin. | `@RequireRole(ADMIN)` |
| DELETE | `/auth/api-keys/:id` | `delete` | Delete a key. Audits `API_KEY_DELETED`. 409 if it is the last usable admin. | `@RequireRole(ADMIN)`, 204 No Content |
| POST | `/auth/api-keys/:id/revoke` | `revoke` | Revoke (soft-disable) a key; evicts live sockets. Audits `API_KEY_REVOKED`. 409 if last usable admin. | `@RequireRole(ADMIN)` |

##### `src/modules/auth/auth.module.ts`
**Module `AuthModule`** (`@Global()`) — imports `TypeOrmModule.forFeature([ApiKey], 'main')`; declares `AuthController`, `AuthValidateController`; provides `AuthService`, `ApiKeyUsageTracker`, and registers `ProxyAwareThrottlerGuard` and `ApiKeyGuard` as global `APP_GUARD`s (throttler before auth); exports `AuthService`.

##### `src/modules/auth/auth.service.ts`
**`AuthService`** (`OnModuleInit`, `OnModuleDestroy`) — key lifecycle, seeding, validation, and the "last admin" safety invariant.
- `onModuleInit()`: seeds a default admin key on first boot (random `owa_k1_...`, or `API_MASTER_KEY`, or `dev-admin-key` if `ALLOW_DEV_API_KEY=true`); writes the raw key to `data/.api-key` (0600); prints the startup banner.
- `onModuleDestroy()`: flushes usage-stat accumulator.
- `createApiKey(dto)`: generates `owa_k1_<64 hex>`, hashes + stores it, returns `{apiKey, rawKey}`.
- `findAll()`, `findOne(id)`: read queries; `findOne` 404s.
- `update(id, dto)`: merge-patches a key; if the patch could strip the last usable unscoped admin, runs a guarded SQL UPDATE (`withLastAdminGuard`) that only succeeds if another usable admin survives, else 409. Evicts WebSocket sockets if role/allowedIps/allowedSessions/expiresAt changed.
- `delete(id)`, `revoke(id)`: same last-admin guard pattern for admin-role targets; non-admin targets skip the guard. Both drop usage-tracker state and remove the bootstrap key file if it matches.
- `validateApiKey(rawKey, clientIp?, sessionId?)`: hashes (after trim), looks up, checks `isActive`, `expiresAt`, IP allowlist (fail-closed if `allowedIps` set but no IP resolved), session allowlist; records usage; throws `UnauthorizedException` on any failure.
- `hasPermission(apiKey, requiredRole)`: role hierarchy check (`VIEWER` < `OPERATOR` < `ADMIN`).
- (private) `evictActiveSockets(keyId, reason)`: lazily resolves `EventsGateway` via `ModuleRef` (breaks a DI cycle) and calls `evictApiKey`.
- Exported helper functions: `resolveSeedApiKey()`, `bannerKeyLine(displayKey, isNewKey)`.

##### `src/modules/auth/bootstrap-key-file.ts`
Manages `data/.api-key` (path overridable via `BOOTSTRAP_KEY_FILE`), an operator-convenience file holding the raw bootstrap admin key.
- `bootstrapKeyFilePath()`, `readBootstrapKey(logger)`, `writeBootstrapKey(displayKey)` (0600), `removeBootstrapKey(reason, logger)` (idempotent, ENOENT = success).

##### `src/modules/auth/decorators/auth.decorators.ts`
- `RequireRole(role)` — metadata decorator requiring a minimum `ApiKeyRole`.
- `SessionScoped()` — marks a controller/route whose `:id` param is a session id, so the guard enforces `allowedSessions` against it.
- `Public()` — bypasses the `ApiKeyGuard` entirely.
- `RequireUnscopedKey()` — rejects session-scoped keys outright regardless of role (used on key-lifecycle and session-create routes).
- `CurrentApiKey()` — param decorator pulling the authenticated `ApiKey` off `request.apiKey`.

##### `src/modules/auth/dto/api-key.dto.ts`
`CreateApiKeyDto` (name, role?, allowedIps?, allowedSessions?, expiresAt?), `ApiKeyResponseDto`, `ApiKeyCreatedResponseDto` (adds raw `apiKey`), `ValidateApiKeyResponseDto` (`{valid, role?}`), `UpdateApiKeyDto` (all fields optional).

##### `src/modules/auth/dto/index.ts`
Re-exports `api-key.dto.ts`.

##### `src/modules/auth/dto/is-ip-or-cidr.validator.ts`
`isIpOrCidr(value)` / `IsIpOrCidrConstraint` — validates each `allowedIps` entry is a valid IPv4 address or IPv4 CIDR (`/0`–`/32`). IPv6 deliberately rejected (the matcher is IPv4-only).

##### `src/modules/auth/entities/api-key.entity.ts`
`ApiKeyRole` enum (`ADMIN`/`OPERATOR`/`VIEWER`). `ApiKey` entity (table `api_keys`): `id`, `name`, `keyHash` (unique), `keyPrefix`, `role`, `allowedIps: string[]|null`, `allowedSessions: string[]|null`, `isActive`, `expiresAt`, `lastUsedAt`, `usageCount`, `createdAt`, `updatedAt`.

##### `src/modules/auth/guards/api-key.guard.ts`
**`ApiKeyGuard`** (`CanActivate`, registered globally) — the gate every HTTP request passes through.
- `canActivate(context)`: skips if `@Public()`; else calls `authorize()`, auditing `API_KEY_AUTH_FAILED` on `Unauthorized`/`Forbidden`.
- (private) `authorize(request, context)`: extracts the key (`X-API-Key` header or `Authorization: Bearer`), resolves the session-id param (only trusted on `@SessionScoped()` controllers), resolves client IP via `resolveClientIp` (trusted-proxy aware), calls `authService.validateApiKey`, stamps the actor into async request context for audit attribution, enforces `@RequireRole`, enforces `@RequireUnscopedKey()` against `allowedSessions`, and attaches `request.apiKey` + `request.clientIp`.

---

### session

The `session` module is the WhatsApp session lifecycle and chat-query surface: creating/starting/stopping/deleting sessions, QR/pairing-code auth, reconnect backoff, multi-node ownership leases, presence, chat actions (archive/mute/pin/delete/read/typing), and the message-ingestion pipeline that projects engine events into the `messages` table and out to webhooks/WebSocket. It is the largest and most structurally decomposed module: `SessionService` owns CRUD + query proxies, `SessionEngineLifecycle` owns every engine-lifecycle verb and delegates to several extracted collaborator classes (`SessionEngineControls`, `SessionEngineEventWiring`, `SessionEngineLeafEvents`, `SessionLifecycleFences`, `SessionStatusBroadcaster`).

##### `src/modules/session/session.controller.ts`
**Controller `SessionController`** (`@Controller('sessions')`, class-level `@SessionScoped()` — `:sessionId` is fenced by the guard's `allowedSessions` check)
| Method | Path | Handler | Description | Guards |
|---|---|---|---|---|
| POST | `/sessions` | `create` | Create a new session (name, config, proxy). 409 if name exists. | `@RequireRole(OPERATOR)`, `@RequireUnscopedKey()` |
| GET | `/sessions` | `findAll` | List sessions, scoped to the key's `allowedSessions`; paginated (`limit`/`offset`). | — |
| GET | `/sessions/:sessionId` | `findOne` | Get one session. | — |
| GET | `/sessions/:sessionId/config` | `getConfig` | Get the tunable config (`autoRejectCalls`, `maxReconnectAttempts`, `reconnectBaseDelay`). | — |
| PATCH | `/sessions/:sessionId/config` | `updateConfig` | Merge-patch the tunable config; `null` clears a key to default. | `@RequireRole(OPERATOR)` |
| DELETE | `/sessions/:sessionId` | `delete` | Delete a session (tears down engine, purges credentials). 409 if a teardown is in flight or another node owns it. | `@RequireRole(OPERATOR)`, 204 |
| POST | `/sessions/:sessionId/start` | `start` | Launch the engine (QR/pairing flow begins). 400 if already started; 409 if name-teardown pending or owned elsewhere. | `@RequireRole(OPERATOR)` |
| POST | `/sessions/:sessionId/stop` | `stop` | Disconnect the engine, keep the session row. 409 if owned elsewhere; 502 if teardown incomplete. | `@RequireRole(OPERATOR)` |
| POST | `/sessions/:sessionId/logout` | `logout` | Engine-native unlink + local teardown; clears `phone`. 400 if not started; 502 if unlink incomplete. | `@RequireRole(OPERATOR)` |
| POST | `/sessions/:sessionId/force-kill` | `forceKill` | SIGKILL a wedged engine then tear down. 400 if not started. | `@RequireRole(OPERATOR)` |
| GET | `/sessions/:sessionId/qr` | `getQRCode` | Get the current QR code. 400 if not ready/already authenticated. | `@RequireRole(OPERATOR)` |
| POST | `/sessions/:sessionId/pairing-code` | `requestPairingCode` | Request an 8-char phone-link pairing code. | `@RequireRole(OPERATOR)` |
| GET | `/sessions/:sessionId/groups` | `getGroups` | List groups the session is in; 60s in-memory cache. Paginated. | — |
| GET | `/sessions/:sessionId/chats` | `getChats` | List active chats, most-recent first. Paginated. | — |
| POST | `/sessions/:sessionId/chats/read` | `markChatRead` | Mark a chat read/seen (optionally specific `messageIds`). | `@RequireRole(OPERATOR)` |
| POST | `/sessions/:sessionId/presence/subscribe` | `subscribeToPresence` | Subscribe to a chat's live presence (updates arrive via WS/webhook). 501 on whatsapp-web.js. | `@RequireRole(OPERATOR)` |
| PUT | `/sessions/:sessionId/presence` | `setOnlinePresence` | Set the account's own online/offline presence. | `@RequireRole(OPERATOR)` |
| GET | `/sessions/:sessionId/presence/:chatId` | `getPresence` | Read last reported presence for a chat (or null). | `@RequireRole(VIEWER)` |
| POST | `/sessions/:sessionId/chats/unread` | `markChatUnread` | Mark a chat unread. | `@RequireRole(OPERATOR)` |
| DELETE | `/sessions/:sessionId/chats/:chatId/messages` | `clearChatMessages` | Delete every message in a chat (chat survives). | `@RequireRole(OPERATOR)` |
| POST | `/sessions/:sessionId/chats/archive` | `archiveChat` | Archive/unarchive a chat. | `@RequireRole(OPERATOR)` |
| POST | `/sessions/:sessionId/chats/mute` | `muteChat` | Mute/unmute a chat until an epoch-ms timestamp. | `@RequireRole(OPERATOR)` |
| POST | `/sessions/:sessionId/chats/pin` | `pinChat` | Pin/unpin a chat (WhatsApp 3-pin cap). | `@RequireRole(OPERATOR)` |
| POST | `/sessions/:sessionId/chats/delete` | `deleteChat` | Delete a chat from the chat list. | `@RequireRole(OPERATOR)` |
| POST | `/sessions/:sessionId/chats/typing` | `sendChatState` | Send typing/recording/paused presence indicator. | `@RequireRole(OPERATOR)` |
| GET | `/sessions/stats/overview` | `getStats` | Aggregate session counts/status/memory usage, scoped to the key's sessions. | — |

##### `src/modules/session/session.module.ts`
**Module `SessionModule`** — imports `TypeOrmModule.forFeature([Session, Message], 'data')`, `WebhookModule`, `StatusStoreModule`, `ChatMediaModule`, `AutomationModule`. Controllers: `SessionController`. Providers: `SessionProxyInterceptor` (global `APP_INTERCEPTOR`), `SessionService`, `SessionEngineLifecycle`, `SessionErrorStore`, `SessionRestrictionStore`, `PresenceStore`, `SessionLidResolver`, `SessionLivenessWatchdog`, `SessionOwnershipService`, `MessageProjector`; binds `PLUGIN_SESSION_PORT` to `SessionService` via `useExisting`. Exports `SessionService`, `MessageProjector`, `SessionOwnershipService`.

##### `src/modules/session/session.service.ts`
**`SessionService`** (`OnModuleInit`, `OnApplicationBootstrap`, `OnModuleDestroy`, implements `PluginSessionPort`) — session-record CRUD, aggregate stats, and thin engine-query proxies. Every *lifecycle* verb (start/stop/logout/forceKill/delete) delegates one-directionally to `SessionEngineLifecycle`.
- `onModuleInit()`: resets this node's claimed active-status sessions to `DISCONNECTED` on boot (peer-owned sessions left alone).
- `onApplicationBootstrap()`: starts the liveness watchdog, wires ownership lease-loss handling, and — if `autoStartSessions` flag is on — detached-launches every previously-authenticated session (throttled 2s apart).
- `create(dto)`: transactional insert with 409 on duplicate name (race-safe via unique-violation catch).
- `findAll(allowedSessions?, opts)`, `findOne(id)`: scoped/paginated reads; attach runtime state (`lastError`, `restriction`) from in-memory stores.
- `getConfig(id)` / `updateConfig(id, dto)`: project/merge-patch the opaque `config` JSON column's three recognized keys.
- `delete(id)`, `start(id)`, `stop(id)`, `logout(id)`, `forceKill(id)`: delegate to `engineLifecycle`, wrapping ownership-claim/release and one bounded transient-failure retry on `start`.
- `getQRCode(id)`, `requestPairingCode(id, phone)`, `getGroups`, `getChats`, `subscribeToPresence`, `setOnlinePresence`, `getPresence`, `sendSeen`, `markUnread`, `clearChatMessages`, `archiveChat`, `muteChat`, `pinChat`, `deleteChat`, `sendChatState`: thin proxies to the live `IWhatsAppEngine`, each 400ing via `engines.require` if not started.
- `getStats(allowedSessions?)`: grouped-COUNT aggregate query + process memory usage.
- `isActive(id)`, `getActiveSessionIds()`, `stopOrphanEngines(ids)`: engine-registry introspection used by the infra-import pre-flight.
- Exports `AUTOSTART_THROTTLE_MS`.

##### `src/modules/session/session-engine-lifecycle.service.ts`
**`SessionEngineLifecycle`** — owns the live `IWhatsAppEngine` map (sole writer of `EngineRegistry`), reconnect backoff, and every engine-event callback wiring. Public surface is 7 control verbs forwarded (non-async pass-through) to `SessionEngineControls`: `start`, `stop`, `logout`, `forceKill`, `delete`, `shutdown`, `stopOrphanEngines`. Also exposes `markStopping`/`clearStopping`/`isEngineActive` fence helpers, `handleEngineReady`, `handleEngineDisconnected` (shared disconnect path for engine callbacks and the liveness watchdog; schedules reconnect via the pure `decideReconnect` policy), `reportRestrictionLifted`, and `updateStatus` (delegates to `SessionStatusBroadcaster`).
- Exported pure functions: `resolveReconnectConfig(config)` (clamps `maxReconnectAttempts`/`reconnectBaseDelay`), `resolveMaxConcurrentSessions(configService)`.
- `EngineInitTimeoutError` — thrown when `engine.initialize()` exceeds its deadline (mapped to 504).
- `initializeEngine(id, session)`: creates the engine, marks `INITIALIZING`, awaits that write (tracked in `pendingInitialStatuses` so a concurrent stop/delete can await it before its own teardown), re-validates liveness, then calls `engine.initialize()` with the 17-callback table built by `SessionEngineEventWiring`, racing a timeout.

##### `src/modules/session/session-engine-controls.ts`
**`SessionEngineControls`** (plain class, constructed by the lifecycle) — the 7 public control verbs' bodies, extracted for readability. Owns the duplicate-start reservation (`initializingSessions`), the max-concurrent-sessions cap, the credential-teardown fence before any mutation, and `delete`'s two-fence transactional cleanup (deletes `Message`/`MessageBatch`/`Webhook`/`Template`/`BaileysStoredMessage` rows + the session row in one transaction, then purges on-disk auth dirs). `logout()` carries the full "200 means engine-native unlink + local cleanup both completed; 502 `SESSION_LOGOUT_INCOMPLETE` otherwise" contract. `stop()` escalates a failed graceful disconnect to `forceDestroy()` and answers 502 `SESSION_STOP_INCOMPLETE` if that also fails.

##### `src/modules/session/session-engine-event-wiring.ts`
**`SessionEngineEventWiring`** — builds the 17-callback `EngineEventCallbacks` table (`onQRCode`, `onReady`, `onMessage`, `onHistoryMessages`, `onMessageCreate`, `onMessageAck`, `onMessageRevoked`, `onMessageReaction`, `onMessageEdited`, `onGroupEvent`, `onCall`, `onDisconnected`, `onStateChanged`, `onActionRequired`, `onCallOutcome`, `onPresenceUpdate`, `onAccountRestriction`, `onError`, `onCredentialTeardownStarted`, `claimStuckAuthRecovery`) passed to `engine.initialize()`. Each callback is gated on `isLiveEngine` (except the five deliberately-ungated ones) and fans out to `EventsGateway`, `WebhookService`, `HookManager`, and the various stores.

##### `src/modules/session/session-engine-leaf-events.ts`
**`SessionEngineLeafEvents`** — three stateless leaf behaviors extracted from the lifecycle:
- `seedStatuses(sessionId, engine)`: best-effort connect-time backfill of currently-active contact statuses (opt-in via `STATUS_SEED_ON_READY`), resolving `@lid` posters to names.
- `dispatchGroupEvent(id, event)`: fans a neutral `GroupEvent` out to WS (`emitGroupJoin`/`Leave`/`Update`/`JoinRequest`) and the matching webhook.
- `maybeAutoRejectCall(id, engine, callId)`: rejects a ringing call when `session.config.autoRejectCalls === true` (strict boolean).

##### `src/modules/session/session-lifecycle-fences.ts`
**`SessionLifecycleFences`** — the concurrency fences around engine teardown.
- `teardownEngineSafely(sessionId, engine, teardown, label, sessionName?)`: runs a teardown call racing a 10s deadline; tracks a `logout`'s raw promise in `pendingTeardowns` (keyed by session **name**, the auth-dir key).
- `trackPendingCredentialTeardown` / `awaitPendingTeardown(sessionName)`: fail-closed 409 `SESSION_NAME_TEARDOWN_PENDING` wait for an in-flight credential-wipe to settle before a new start/delete touches the same on-disk auth dir.
- `awaitInitialStatus(id, engine)`: waits (bounded) for a captured engine's in-flight `INITIALIZING` DB write before a retiring control's final write.
- `evictAndForceDestroy(id, engine)`: evict from the registry + best-effort SIGKILL.

##### `src/modules/session/session-status-broadcaster.ts`
**`SessionStatusBroadcaster`** — `updateStatus(id, status)` persists the session's status column and, only on an actual change (de-duped via `lastDispatchedStatus` map), emits `emitSessionStatus` over WS and dispatches the `session.status` webhook. `clear(id)` drops the de-dup entry on a committed delete.

##### `src/modules/session/session-ownership.service.ts`
**`SessionOwnershipService`** — the multi-node session-engine lease mechanism (who hosts which session's live engine).
- `nodeId` (from `NODE_ID`/config or hostname), `nodeUrl` (for request forwarding), `leaseTtlMs` (default 60s), `heartbeatMs` (default 20s).
- `claim(sessionId)`: conditional UPDATE — succeeds only if unclaimed, claimed by self, or lease lapsed.
- `release(sessionId)`, `releaseAll()`: give up claims (on a lapsed foreign claim too, so a deliberate stop doesn't look like an orphan).
- `startHeartbeat()`/`stopHeartbeat()`/`renew()`: periodically extends leases for sessions still `engineLiveness`-alive; on losing a previously-held claim, calls the registered `onLeaseLoss` handler (wired by `SessionService` to tear down the local engine).
- `suspendLossDetection()`: returns a release token; used by the infra-import path to prevent a heartbeat mid-transaction from misreading "no rows" as loss.
- `claimableWhere()`, `claimable(ids)`, `lapsedHeldByOthers()`, `isHeldByOtherNode(id)`, `heldByOtherNodes()`, `owns(sessionId)` (synchronous, in-memory — used on the engine-callback hot path).
- Exported `nodeOwnsSession(ownership, sessionId)` — the ownership fence used throughout the lifecycle; defaults `true` with no ownership service wired (single-node / direct-construction specs).

##### `src/modules/session/session-liveness-watchdog.service.ts`
**`SessionLivenessWatchdog`** — actively probes every registered `READY` (and observe-only `ACTION_REQUIRED`) engine every 60s (`probeLiveness()`, 15s timeout) and, after 2 consecutive failures, calls the `onDead` handler (same path as an engine-reported disconnect). Skips a strike during a concurrent heavy CDP op (`EngineRegistry.beginHeavyOp`) to avoid false positives from event-loop contention. Exports `SESSION_WATCHDOG_INTERVAL_MS`, `SESSION_WATCHDOG_PROBE_TIMEOUT_MS`, `SESSION_WATCHDOG_MAX_FAILURES`.

##### `src/modules/session/session-error-store.service.ts`
**`SessionErrorStore`** — synchronous in-memory `Map<sessionId, reason>` for the last failure/action-required reason. `set`, `get`, `clear`, `attachTo(session)` (populates `session.lastError`, only for `FAILED`/`ACTION_REQUIRED` statuses).

##### `src/modules/session/session-restriction-store.service.ts`
**`SessionRestrictionStore`** — in-memory `Map<sessionId, AccountRestriction>` for active WhatsApp-imposed restrictions (`tos_block`, `proxy_block`, `reachout_timelock`). `set` (returns whether it's new news), `get`/`inForce` (expiry-aware), `clear`, `clearIfDisprovedByReady` (a `reachout_timelock` survives a `READY` reconnect; connection-level blocks don't), `size()`, `attachTo(session)`.

##### `src/modules/session/presence-store.service.ts`
**`PresenceStore`** — in-memory per-session, per-chat last-known presence (`ChatPresence`), capped at 500 chats/session (oldest-observed eviction). `record(sessionId, event)` returns whether anything observable changed (suppresses WhatsApp's repeat-reports). `get`, `clear`.

##### `src/modules/session/session-lid-resolver.service.ts`
**`SessionLidResolver`** — resolves a `@lid` privacy-id sender to a phone number for inline message attachment, with a bounded (5000-entry) cache including negative results, and persists the resolution to the shared `LidMappingStoreService`. `resolveSenderPhone(sessionId, contactId)`.

##### `src/modules/session/session-proxy.interceptor.ts`
**`SessionProxyInterceptor`** (`NestInterceptor`, global) — routes a session-scoped request to the node that actually owns that session's live engine (multi-node deployments), via HTTP forwarding. Inert unless `NODE_URL` is configured. Exports `forwardTarget(originalUrl, ownerNodeUrl)` (origin-hijack-safe URL rebuild) and `FORWARDED_HEADER`.

##### `src/modules/session/reconnect-policy.ts`
Pure reconnect-backoff decision function, no I/O. `decideReconnect(state, now?, jitter?)` → `ReconnectExhausted | ReconnectScheduled`; implements stability reset (5 min), exponential backoff (capped at 1h), and periodic loop-alert (every 5th attempt). Exports `clampNumber`, `clampReconnectDelay`, and the tuning constants.

##### `src/modules/session/message-projector.service.ts`
**`MessageProjector`** — projects engine message events into the `messages` table and out to webhooks/WS; the data path for inbound/outbound/ack/revoke/reaction/edit and pre-connection history backfill.
- `handleInboundMessage(id, engine, message)`: runs `message:received` hook, persists via `insert()` (UNIQUE `(sessionId, waMessageId)` is the dedup oracle for engine re-fires), dispatches `message.received` webhook + WS emit + `message:persisted` hook + chat-media archive. Status-broadcast messages are routed to `ingestInboundStatus` instead.
- `handleOwnSendEcho(id, engine, message)`: handles the `message_create` echo (covers phone-composed sends), persists OUTGOING rows, dispatches `message.sent`.
- `handleMessageAck(id, engine, messageId, status)`: forward-only guarded UPDATE advancing message status (SENT→DELIVERED→READ or FAILED), retries once after 750ms to close a race with the send's second save; emits `message.ack` WS + webhook, `message.failed` webhook on failure.
- `handleMessageRevoked(id, engine, message)`: flags the row `type: 'revoked'`, dispatches.
- `persistHistoryMessages(id, messages)`: delegates to the stateless `message-history-projector.ts`.
- `applyReactionQueued`, `applyMessageEditQueued`, `enqueueMessageMutation`, `recordOutboundMessageEdit`: delegate to `MessageMutationProjector`, serialized per `${sessionId}:${messageId}` via a `KeyedMutationQueue`.

##### `src/modules/session/message-history-projector.ts`
`persistHistoryMessages(repo, configService, id, messages, logger)` — stateless function: de-dupes pre-connection history by `waMessageId`, respects `storeEphemeralMessages` flag, batched (chunk 400) insert-or-ignore.

##### `src/modules/session/message-mutation-projector.ts`
**`MessageMutationProjector`** (plain collaborator, shares `MessageProjector`'s mutation queue) — `applyReaction` (read-modify-write the metadata.reactions map, scoped UPDATE to avoid clobbering a concurrent ack), `applyMessageEdit`, `recordOutboundMessageEdit` (REST-originated edit echo).

##### `src/modules/session/message-row.mapper.ts`
`buildMessageMetadata(message, synthesizeOmittedMedia?)` — builds the `metadata` JSON column (media/quotedMessage/call), synthesizing an "omitted" media placeholder for echo/history paths that can arrive media-less. `storableWaMessageId(id)` — normalizes an empty id to `undefined` (NULL, not `''`, to not collide on the non-partial unique index).

##### `src/modules/session/entities/session.entity.ts`
`SessionStatus` enum (`created`/`initializing`/`qr_ready`/`authenticating`/`ready`/`disconnected`/`action_required`/`failed`). `Session` entity (table `sessions`): `id`, `name` (unique), `status`, `phone`, `pushName`, `config` (JSON), `proxyUrl`, `proxyType`, `connectedAt`, `lastActiveAt`, `nodeId`/`claimedAt`/`nodeUrl`/`leaseExpiresAt` (ownership lease), `createdAt`, `updatedAt`; transient (non-column) `lastError`, `restriction`.

##### `src/modules/session/dto/*`
- `index.ts` — re-exports all session DTOs.
- `create-session.dto.ts` — `CreateSessionDto` (name, config?, proxyUrl?, proxyType?).
- `session-config.dto.ts` — `UpdateSessionConfigDto` (autoRejectCalls/maxReconnectAttempts/reconnectBaseDelay, each nullable to reset), `SessionConfigResponseDto`.
- `session-response.dto.ts` — `AccountRestrictionDto`, `SessionResponseDto` (+ `fromEntity(session, engineLoaded)` static mapper stripping `config`/`proxyUrl`/`proxyType`), `QRCodeResponseDto`.
- `archive-chat.dto.ts` — `ArchiveChatDto` (chatId, archive: boolean).
- `chat-summary.dto.ts` — `ChatSummaryDto` (OpenAPI mirror of engine `ChatSummary`).
- `delete-chat.dto.ts` — `DeleteChatDto` (chatId).
- `mark-chat-read.dto.ts` — `MarkChatReadDto` (chatId, messageIds? capped at 100).
- `mark-chat-unread.dto.ts` — `MarkChatUnreadDto` (chatId).
- `mute-chat.dto.ts` — `MuteChatDto` (chatId, muteUntil: number|null).
- `pin-chat.dto.ts` — `PinChatDto` (chatId, pin: boolean).
- `presence.dto.ts` — `SetOwnPresenceDto`, `SubscribePresenceDto`, `ParticipantPresenceDto`, `ChatPresenceResponseDto`.
- `request-pairing-code.dto.ts` — `RequestPairingCodeDto` (phoneNumber), `PairingCodeResponseDto`.
- `send-chat-state.dto.ts` — `SendChatStateDto` (chatId, state: 'typing'|'recording'|'paused').
- `session-actions-response.dto.ts` — `SessionActionResponseDto`, `SessionGroupSummaryDto`, `SessionMemoryUsageDto`, `SessionsOverviewResponseDto`.

---

### message

The `message` module is the outbound/inbound chat-message REST surface: sending text/media/location/contact/poll/sticker, replying/forwarding, reactions, reading history, deleting/editing/pinning/starring, and bulk/batch sending. It layers moderation (`message:sending` hook gate), anti-ban pacing (`SendPacingService`), and dedup/persistence guarantees on top of the engine calls.

##### `src/modules/message/message.controller.ts`
**Controller `MessageController`** (`@Controller('sessions/:sessionId/messages')`)
| Method | Path | Handler | Description | Guards |
|---|---|---|---|---|
| GET | `/sessions/:sessionId/messages` | `getMessages` | Message history from the local DB; filter by `chatId`/`from`, paginated. | — |
| POST | `/sessions/:sessionId/messages/send-text` | `sendText` | Send a text message (mentions, link preview, quoted reply). | `@RequireRole(OPERATOR)` |
| POST | `.../send-template` | `sendTemplate` | Render a stored template and send as text. | `@RequireRole(OPERATOR)` |
| POST | `.../send-image` | `sendImage` | Send an image (URL or base64). | `@RequireRole(OPERATOR)` |
| POST | `.../send-video` | `sendVideo` | Send a video. | `@RequireRole(OPERATOR)` |
| POST | `.../send-audio` | `sendAudio` | Send audio or (ptt:true) a voice note. | `@RequireRole(OPERATOR)` |
| POST | `.../send-document` | `sendDocument` | Send a document/file. | `@RequireRole(OPERATOR)` |
| POST | `.../send-location` | `sendLocation` | Send a location pin. | `@RequireRole(OPERATOR)` |
| POST | `.../send-contact` | `sendContact` | Send a contact card. | `@RequireRole(OPERATOR)` |
| POST | `.../send-sticker` | `sendSticker` | Send a sticker. | `@RequireRole(OPERATOR)` |
| POST | `.../send-poll` | `sendPoll` | Send a native WhatsApp poll. | `@RequireRole(OPERATOR)` |
| POST | `.../reply` | `reply` | Reply (quote) a message. | `@RequireRole(OPERATOR)` |
| POST | `.../forward` | `forward` | Forward a message to another chat. | `@RequireRole(OPERATOR)` |
| POST | `.../react` | `react` | Add/remove a reaction (empty emoji removes). | `@RequireRole(OPERATOR)` |
| GET | `.../:chatId/history` | `getChatHistory` | Live chat history straight from WhatsApp (bypasses DB); `limit`, `includeMedia`, `deep` (raises ceiling to 2000, forces media off). | — |
| GET | `.../:chatId/:messageId/reactions` | `getReactions` | List reactions on a message. | — |
| GET | `.../:chatId/:messageId/media` | `getChatMedia` | Download a message's stored media (archived file, else inline copy). Served as attachment, inert octet-stream unless a safe mimetype. | — |
| POST | `.../delete` | `deleteMessage` | Delete a message (for everyone by default). | `@RequireRole(OPERATOR)` |
| POST | `.../vote-poll` | `votePoll` | Cast/replace a poll vote. 501 on Baileys. | `@RequireRole(OPERATOR)` |
| POST | `.../pin` | `pinMessage` | Pin a message (24h/7d/30d window). | `@RequireRole(OPERATOR)` |
| POST | `.../unpin` | `unpinMessage` | Unpin a message. | `@RequireRole(OPERATOR)` |
| POST | `.../star` | `starMessage` | Star/unstar a message. | `@RequireRole(OPERATOR)` |
| POST | `.../edit` | `edit` | Edit text of an own-sent message. | `@RequireRole(OPERATOR)` |
| POST | `.../send-bulk` | `sendBulk` | Create an async bulk-send batch. 202 Accepted. | `@RequireRole(OPERATOR)` |
| GET | `.../batch/:batchId` | `getBatchStatus` | Batch progress/results. | — |
| POST | `.../batch/:batchId/cancel` | `cancelBatch` | Cancel a running batch. | `@RequireRole(OPERATOR)` |

##### `src/modules/message/message.module.ts`
**Module `MessageModule`** — imports `TypeOrmModule.forFeature([Message, MessageBatch, Session], 'data')`, `SessionModule`, `TemplateModule`, `ChatMediaModule`. Providers: `MessageService`, `MessageSendService`, `BulkMessageService`, `MessageTypeBackfillService`, `PendingMessageReaperService`, `SendPacingService`; binds `PLUGIN_MESSAGE_PORT` to `MessageService`. Exports `MessageService`, `BulkMessageService`, `SendPacingService`.

##### `src/modules/message/message.service.ts`
**`MessageService`** (implements `PluginMessagePort`) — the query side + send pass-throughs.
- Send methods (`sendText`, `sendTemplate`, `sendImage`, `sendVideo`, `sendAudio`, `sendDocument`, `sendLocation`, `sendContact`, `sendPoll`, `sendSticker`, `reply`, `forward`, `saveOutgoingMessage`): thin forwarders to `MessageSendService`, kept here for a stable surface (controller, agent tools, bulk).
- `getMessages(sessionId, options)`: paginated DB query with chat/sender JID-dialect expansion (`resolveJidCandidates`, resolves `@lid` via `LidMappingStoreService`); spends an 8 MiB inline-media budget newest-first (`spendInlineMediaBudget`) so a page of rows can't blow past V8's string ceiling.
- `saveIncomingMessage`, `reactToMessage`, `getMessageReactions`, `getChatMedia` (archived file else inline base64 copy, mimetype allow-listed), `getChatHistory` (clamped limit 1–100, or 1–2000 with `deep`), `pinMessage`, `unpinMessage`, `starMessage`, `votePoll`, `deleteMessage`, `editMessage` (routes through `message:sending` gate + pacing).
- `applySendingGate`, `getEngine`: shared helpers.

##### `src/modules/message/message-send.service.ts`
**`MessageSendService`** — the actual engine-send execution path (one method per send type, each: gate → persist PENDING → call engine → `persistSentState`/`failSend`). Deliberately synchronous per-session (no BullMQ queue — the engine is itself the serialization point).
- `sendText`, `sendTemplate` (renders via `TemplateService` + `renderTemplate`, caps at `template.renderMaxChars`), `sendImage`, `sendVideo`, `sendAudio` (defaults `audio/ogg; codecs=opus` for `ptt`), `sendDocument`, `sendLocation`, `sendContact`, `sendPoll`, `sendSticker`, `reply`, `forward`.
- `saveOutgoingMessage(sessionId, data)`: persists a PENDING/SENT row; on a UNIQUE-violation race with the engine's own-send echo, merges state+metadata onto the echo's row instead of failing.
- `persistSentState(message, result)`: marks SENT, reconciles against a concurrent echo-persisted row (drops the redundant PENDING row, fires `message:deleted` hook for the ghost).
- `failSend(sessionId, type, message, input, error)`: marks FAILED (drops media payload), records breaker failure (`countsTowardSendBreaker`), fires `message:failed` hook, maps SSRF/HttpException/generic errors to client-facing exceptions.
- `simulateTypingIfEnabled`: opt-in (`SIMULATE_TYPING`) pre-send typing-indicator pause, length-scaled + jittered.
- `buildMediaInput(dto)`: resolves base64-vs-url, size cap, mimetype default.
- Exports `DEFAULT_TEMPLATE_RENDER_MAX_CHARS`, `SaveOutgoingMessageData`.

##### `src/modules/message/bulk-message.service.ts`
**`BulkMessageService`** (`OnApplicationBootstrap`) — async batch sending.
- `onApplicationBootstrap()`: marks any `PROCESSING` batch owned by this node FAILED (crash recovery; never auto-resumes to avoid double-sends). `reapProcessingBatches(sessionId, reason)`: same, scoped, for session-takeover.
- `createBatch(sessionId, dto)`: dedupes exact-duplicate entries, validates media cap, enforces per-process concurrent-batch cap (`BULK_MAX_CONCURRENT_BATCHES`), persists `PENDING` batch, kicks off `processBatch` detached.
- `getBatchStatus(sessionId, batchId)`, `cancelBatch(sessionId, batchId)` (guarded UPDATE so a race can't resurrect a cancelled batch; terminal statuses are exclusive).
- `processBatch`/`executeBatch`/`processBatchMessages`/`processBatchMessage`: per-item pipeline — template-variable substitution, pacing gate, `message:sending` hook gate, media-cap re-check, engine send, progress persisted every 10 messages (cancellation-guarded), inter-message delay (`calculateDelay`).
- Exported pure helpers: `resolveFinalBatchStatus`, `sanitizeBatchError`, `resolveMaxConcurrentBatches`.

##### `src/modules/message/message-type-backfill.service.ts`
**`MessageTypeBackfillService`** (`OnApplicationBootstrap`) — one-time idempotent backfill of legacy whatsapp-web.js message-type tokens (`chat`→`text`, `ptt`→`voice`, `vcard`/`multi_vcard`→`contact`) to the neutral vocabulary; runs on every boot (safe no-op once converted).

##### `src/modules/message/pending-message-reaper.service.ts`
**`PendingMessageReaperService`** (`OnModuleInit`, `OnModuleDestroy`) — sweeps (default every 10 min) outgoing `PENDING` rows older than a grace window (default 1h), marking them FAILED (`reapedAt` marker) and re-emitting `message:persisted` so stuck crash-window messages resolve. `sweep(opts, now)`, `resolvePendingMessageReaperOptions(env)`.

##### `src/modules/message/send-pacing.service.ts`
**`SendPacingService`** — anti-ban outbound governor: warm-up daily cap (by session age) + cold-reachout daily cap (first message to a stranger chat) + a consecutive-failure circuit breaker.
- `assertSendAllowed(sessionId, chatId?)`: throws 429 `SEND_PACING_LIMITED` if the breaker is open, the daily cap is spent, or the cold-reachout cap is spent.
- `assertReachoutAllowed(sessionId, contactIds)` / `chargeGroupReachouts`: same cold budget applied to bulk group-add reachouts (in-memory tally, since group adds persist no row).
- `recordSendFailure`/`recordSendSuccess`: breaker bookkeeping.
- `isPacingLimitedError(error)`, `countsTowardSendBreaker(error)` — exported classifiers used throughout message/status send paths.
- `SEND_PACING_LIMITED` constant (body `code`).

##### `src/modules/message/send-pacing.config.ts`
`SendPacingConfig` interface + `computeSendPacingConfig(env)` / `resolveSendPacingConfig(configService?)` — parses `SEND_PACING_*` env vars (warmup/cold schedules, breaker threshold/cooldown), malformed schedule falls back whole to default.

##### `src/modules/message/media-cap.util.ts`
`stripBase64DataUri(base64)`, `assertBase64WithinMediaCap(base64)` — rejects (413) an outbound base64 blob whose decoded size exceeds `MEDIA_DOWNLOAD_MAX_BYTES`, without allocating the decoded buffer.

##### `src/modules/message/message-status.util.ts`
`deliveryStatusToMessageStatus(status)`, `deliveryStatusToAck(status)` (deprecated legacy integer), `ackStatusTransitionFrom(target)` (forward-only transition guard list).

##### `src/modules/message/entities/message.entity.ts`
`bigintToNumberTransformer` (coerces PG bigint-as-string to number). `MessageDirection`, `MessageStatus` enums. `Message` entity (table `messages`): `id`, `sessionId`, `waMessageId` (nullable, unique with sessionId), `chatId`, `chatName?`, `author?` (group poster), `from`, `to`, `body`, `type`, `direction`, `timestamp`, `metadata` (JSON), `mediaPath?`/`mediaMimetype?` (archive pointer), `status`, `createdAt`.

##### `src/modules/message/entities/message-batch.entity.ts`
`BatchStatus`, `BatchMessageStatus` enums; `BatchMessageResult`, `BatchProgress` interfaces. `MessageBatch` entity (table `message_batches`, unique on `(sessionId, batchId)`): `batchId`, `sessionId`, `status`, `messages[]`, `options`, `progress`, `results[]`, `currentIndex`, timestamps.

##### `src/modules/message/dto/*`
- `index.ts` — re-exports `send-message.dto`.
- `send-message.dto.ts` — `CustomLinkPreviewDto`, `SendTextMessageDto`, `SendMediaMessageDto`, `SendAudioMessageDto` (extends media + `ptt`), `MessageResponseDto`; exported constants (`MENTIONS_MAX`, `MESSAGE_TEXT_MAX_LENGTH`, `QUOTED_MESSAGE_ID_DESCRIPTION`, etc.) and Swagger body examples (`SEND_TEXT_BODY_EXAMPLES`, etc.).
- `send-template.dto.ts` — `SendTemplateMessageDto` (templateId|templateName, vars, mentions, linkPreview).
- `bulk-message.dto.ts` — `SendBulkMessageDto` (+nested `BulkMediaDto`/`BulkMessageContentDto`/`BulkMessageItemDto`/`BulkMessageOptionsDto`), response DTOs `BulkMessageResponseDto`, `BatchProgressDto`, `BatchMessageErrorDto`, `BatchMessageResultDto`, `BatchStatusResponseDto`, `BatchCancelResponseDto`.
- `message-actions.dto.ts` — `SendLocationDto`, `SendContactDto`, `SendPollDto`, `ReplyMessageDto`, `ForwardMessageDto`, `ReactMessageDto`, `DeleteMessageDto`, `PinMessageDto` (+`PIN_DURATIONS_SECONDS`), `VotePollDto` (+`POLL_VOTE_MAX_OPTIONS`), `StarMessageDto`, `UnpinMessageDto`, `EditMessageDto`.
- `message-responses.dto.ts` — `MessageActionResponseDto`, `MessageListItemDto`, `MessageListResponseDto`, `ChatHistoryContactDto`, `ChatHistoryMediaDto`, `ChatHistoryQuotedMessageDto`, `ChatHistoryLocationDto`, `ChatHistoryCallDto`, `ChatHistoryMessageDto`, `MessageReactionSenderDto`, `MessageReactionDto`.
- `is-mention-wid.validator.ts` — `isMentionWid(value)` / `IsMentionWidConstraint`: only `<phone>@c.us`/`@s.whatsapp.net`/`<lid>@lid` individual WIDs are valid mention targets (not groups).

---

### channel

The `channel` module exposes WhatsApp Channels/newsletters: listing subscribed channels, reading channel messages, creating/deleting channels, muting, admin demotion, ownership transfer, and subscribe/unsubscribe by invite code. All routes proxy to `IWhatsAppEngine`; several are Baileys-only or whatsapp-web.js-only (documented per route).

##### `src/modules/channel/channel.controller.ts`
**Controller `ChannelController`** (`@Controller('sessions/:sessionId/channels')`)
| Method | Path | Handler | Description | Guards |
|---|---|---|---|---|
| GET | `/sessions/:sessionId/channels` | `findAll` | List subscribed channels. 501 on Baileys. | — |
| GET | `.../:channelId` | `findOne` | Get one channel. | — |
| GET | `.../:channelId/messages` | `getMessages` | Channel message history (`limit`, default 50/max 100). 501 on Baileys. | — |
| POST | `/sessions/:sessionId/channels` | `create` | Create a channel (account becomes owner). | `@RequireRole(OPERATOR)`, 201 |
| POST | `.../:channelId/delete` | `remove` | Delete a channel this account owns (irreversible). | `@RequireRole(OPERATOR)` |
| POST | `.../:channelId/mute` | `mute` | Mute/unmute a channel. | `@RequireRole(OPERATOR)` |
| POST | `.../:channelId/admins/demote` | `demoteAdmin` | Demote a channel admin to subscriber. 501 on whatsapp-web.js. | `@RequireRole(OPERATOR)` |
| POST | `.../:channelId/owner/transfer` | `transferOwnership` | Transfer ownership (irreversible). 501 on whatsapp-web.js. | `@RequireRole(OPERATOR)` |
| POST | `/sessions/:sessionId/channels/subscribe` | `subscribe` | Subscribe via invite code. 501 on whatsapp-web.js. | `@RequireRole(OPERATOR)`, 201 |
| DELETE | `.../:channelId` | `unsubscribe` | Unsubscribe from a channel. | `@RequireRole(OPERATOR)` |

##### `src/modules/channel/channel.module.ts`
**Module `ChannelModule`** — controllers: `ChannelController`; providers: `ChannelService`. No imports (engine access via injected `EngineRegistry`).

##### `src/modules/channel/channel.service.ts`
**`ChannelService`** — thin engine-access layer with the "session not started" guard and not-found mapping.
- `getSubscribedChannels`, `getChannelById` (404 if null), `getChannelMessages` (limit clamped 1–100), `createChannel`, `deleteChannel`, `muteChannel`, `subscribeToChannel`, `unsubscribeFromChannel`.
- `demoteChannelAdmin`, `transferChannelOwnership`: validate the target user id via `addressableUser` (400 if not an individual WID) before calling the engine.

##### `src/modules/channel/dto/*`
- `channel-response.dto.ts` — `ChannelDto`, `ChannelMessageDto`, `ChannelAckResponseDto`.
- `create-channel.dto.ts` — `CreateChannelDto` (name, description?).
- `demote-channel-admin.dto.ts` — `DemoteChannelAdminDto` (userId).
- `mute-channel.dto.ts` — `MuteChannelDto` (mute: boolean).
- `subscribe-channel.dto.ts` — `SubscribeChannelDto` (inviteCode).
- `transfer-channel-ownership.dto.ts` — `TransferChannelOwnershipDto` (newOwnerId).

---

### chat-media

A single-service module that archives inbound (and optionally outbound) chat-message media to the shared file store, independent of the inline base64 copy kept on the message row, plus retention and orphan-file reconciliation sweeps.

##### `src/modules/chat-media/chat-media-archive.service.ts`
**`ChatMediaArchiveService`** (`OnModuleInit`, `OnModuleDestroy`) — opt-in (`CHAT_MEDIA_ARCHIVE_ENABLED`, default off).
- `archive(row)`: writes the message's inline media to `chat-media/<sessionId>/<uuid>.<ext>` and points `mediaPath`/`mediaMimetype` at it; never throws; skips URL-pointer media, over-cap media, and rows already archived.
- `getMedia(sessionId, chatIds, waMessageId)`: resolves the archived file's path+mimetype for the message read endpoint.
- `purgeExpired(now)`: batched (500/batch, up to 200 batches/run) TTL deletion (`CHAT_MEDIA_ARCHIVE_TTL_DAYS`, 0 = keep forever).
- `sweepOrphanedMedia(now)`: hourly reconciliation removing `chat-media/` files no row references, after a grace window.

##### `src/modules/chat-media/chat-media.module.ts`
**Module `ChatMediaModule`** — standalone (no SessionModule/MessageModule import, to avoid a cycle — both import this instead). Imports `TypeOrmModule.forFeature([Message], 'data')`, `ConfigModule`, `StorageModule`. Provides/exports `ChatMediaArchiveService`.

---

### media

Server-side media transcoding (ffmpeg-based), scoped under a session path purely so session-restricted API keys can reach it — conversion itself never touches WhatsApp or a session's engine.

##### `src/modules/media/media.controller.ts`
**Controller `MediaController`** (`@Controller('sessions/:sessionId/media')`, class-level `@ApiParam('sessionId')` since no handler binds it)
| Method | Path | Handler | Description | Guards |
|---|---|---|---|---|
| GET | `/sessions/:sessionId/media/convert` | `conversionStatus` | Whether conversion is enabled AND ffmpeg is runnable. | — |
| POST | `.../convert/voice` | `convertVoice` | Convert audio to Ogg/Opus WhatsApp voice note. | `@RequireRole(OPERATOR)` |
| POST | `.../convert/video` | `convertVideo` | Convert video to baseline H.264/AAC MP4 (faststart, long edge ≤1280). | `@RequireRole(OPERATOR)` |

##### `src/modules/media/media.module.ts`
**Module `MediaModule`** — controllers: `MediaController`; providers/exports: `MediaConversionService`.

##### `src/modules/media/media-conversion.service.ts`
**`MediaConversionService`** — `convertToVoice(dto)`, `convertToVideo(dto)` (both call `convert()` with codec-specific args), `isAvailable()` (enabled flag + cached ffmpeg probe). `resolveInput(dto)`: decodes base64 (cap-checked) or SSRF-guarded URL fetch. Bounded by a `ConcurrencyLimiter` (default concurrency 2, queue 4×). Maps `FfmpegConversionError`/SSRF/queue-full to appropriate HTTP exceptions.

##### `src/modules/media/ffmpeg.ts`
Low-level ffmpeg process wrapper, no NestJS dependency.
- `buildFfmpegArgs(inputPath, outputPath, encodeArgs)`: `-protocol_whitelist file` (blocks ffmpeg from making its own HTTP requests), `-nostdin -y`.
- `voiceEncodeArgs()`: Opus/48kHz/mono/32kbps voip-tuned. `videoEncodeArgs()`: baseline H.264/yuv420p/faststart, scaled to ≤1280 long edge, AAC 128k.
- `runFfmpeg(input, inputExt, outputExt, encodeArgs, options)`: writes to a temp dir (required for seeking muxers), spawns, enforces `maxOutputBytes`, cleans up.
- `execute(args, options)`: spawns with a hard timeout (SIGKILL), captures last 4KB of stderr.
- `probeFfmpeg(ffmpegPath, timeoutMs?)`: runs `-version` to check runnability.
- `FfmpegConversionError` class.

##### `src/modules/media/dto/convert-media.dto.ts`
`ConvertMediaDto` (url? xor base64?, no mimetype field — ffmpeg sniffs the input).

##### `src/modules/media/dto/media-response.dto.ts`
`ConversionStatusResponseDto` (`available`), `ConvertedMediaResponseDto` (`base64`, `mimetype`, `bytes`).

---

### call

The `call` module covers WhatsApp voice/video call operations: generating shareable call links and rejecting a ringing incoming call.

##### `src/modules/call/call.controller.ts`
**Controller `CallController`** (`@Controller('sessions/:sessionId/calls')`)
| Method | Path | Handler | Description | Guards |
|---|---|---|---|---|
| POST | `/sessions/:sessionId/calls/link` | `createLink` | Generate a shareable WhatsApp call link (`type`: audio/video, `startTime`). 403 if WhatsApp refuses. | `@RequireRole(OPERATOR)` |
| POST | `.../:callId/reject` | `reject` | Reject a ringing incoming call. 404 if unknown/no-longer-ringing. | `@RequireRole(OPERATOR)` |

##### `src/modules/call/call.module.ts`
**Module `CallModule`** — controllers: `CallController`; providers/exports: `CallService`.

##### `src/modules/call/call.service.ts`
**`CallService`** — `rejectCall(sessionId, callId)`, `createCallLink(sessionId, type, startTime)`, both thin proxies to `IWhatsAppEngine` via `EngineRegistry.require` (400 "session not started" default).

##### `src/modules/call/dto/*`
- `call-link-response.dto.ts` — `CallLinkResponseDto` (`link`).
- `call-response.dto.ts` — `CallAckResponseDto` (`success`).
- `create-call-link.dto.ts` — `CreateCallLinkDto` (`type`: 'audio'|'video', `startTime`: epoch ms, required).

---

### events

The `events` module is the real-time WebSocket surface (`Socket.IO`, namespace `/events`) mirroring most webhook events live to subscribed dashboard/SDK clients, with its own authentication (API key over the handshake), per-key room-based subscription, in-process rate limiting, and optional Redis-backed cross-replica fan-out.

##### `src/modules/events/events.gateway.ts`
**`EventsGateway`** (`WebSocketGateway({ namespace: '/events' })`, implements `OnGatewayInit`, `OnGatewayConnection`, `OnGatewayDisconnect`, `OnModuleDestroy`)

**Connection lifecycle:**
- `handleConnection(client)`: per-IP handshake rate limit (pre-auth, `SlidingWindowLimiter`) → extracts API key from `auth.apiKey` or `X-API-Key` header (never the query string) → `authService.validateApiKey` → per-key socket cap (`maxSocketsPerKey`, default 16) → stores validated key + raw key on `client.data`, tracks the socket.
- `handleDisconnect(client)`: untracks the socket.
- `evictApiKey(keyId, reason)`: called by `AuthService` on revoke/delete/authorization-change/expiry; disconnects every live socket for that key with an `UNAUTHORIZED` error frame.
- Expiry sweep: every 60s, disconnects sockets whose key's `expiresAt` has passed.

**Client → Server messages** (`@SubscribeMessage('message')`, dispatched by `message.type`):
| Client message type | Handler | Description |
|---|---|---|
| `subscribe` | `handleSubscribe` | Re-validates the API key, enforces `allowedSessions` scope (`isSessionSubscriptionAllowed` — a scoped key cannot subscribe to `*` or an out-of-scope session), validates `events[]` against `SUBSCRIBABLE_EVENTS`, joins Socket.IO rooms `session:<id>:<event>`. Replies `subscribed`. |
| `unsubscribe` | `handleUnsubscribe` | Leaves all rooms matching the session. Replies `unsubscribed`. |
| `ping` | `handlePing` | Replies `pong`. |

Every inbound frame is metered by a per-key (or per-IP pre-auth) token-bucket `frameLimiter` (default 60/s, burst 120) before dispatch; over-budget frames get a `RATE_LIMITED` error frame and are not processed further.

**Server → Client emit methods** (room-based via `emitToRooms`, each event also reaches the `session:*:<event>`, `session:<id>:*`, and `session:*:*` wildcard rooms): `emitSessionStatus`, `emitSessionAuthenticated`, `emitSessionDisconnected`, `emitSessionRestriction`, `emitCallAccepted`, `emitCallRejected`, `emitCallMissed`, `emitPresenceUpdate`, `emitQRCode`, `emitMessage` (sheds inline media over a configurable byte cap), `emitMessageSent` (same shedding), `emitMessageAck`, `emitMessageRevoked`, `emitMessageReaction`, `emitMessageEdited`, `emitGroupJoin`, `emitGroupLeave`, `emitGroupUpdate`, `emitGroupJoinRequest`, `emitCallReceived`, `emitStatusReceived`.

Exported: `isSessionSubscriptionAllowed(allowedSessions, sessionId)`, `ApiKeyEvictionReason` type.

##### `src/modules/events/dto/ws-messages.dto.ts`
`SUBSCRIBABLE_EVENTS` (the canonical list of every WS-subscribable event name; must have a matching `emit*` method — enforced by a drift-guard spec). Client message types (`WSSubscribeRequest`, `WSUnsubscribeRequest`, `WSPingRequest`, union `WSClientMessage`); server response types (`WSSubscribedResponse`, `WSUnsubscribedResponse`, `WSEventMessage`, `WSErrorResponse`, `WSPongResponse`); `buildRoomName(sessionId, event)`.

##### `src/modules/events/events.module.ts`
**Module `EventsModule`** (`@Global()`) — imports `AuthModule`; providers/exports `EventsGateway`.

##### `src/modules/events/redis-io.adapter.ts`
**`RedisIoAdapter`** (extends `IoAdapter`) — attaches the `@socket.io/redis-adapter` pub/sub pair to the root Socket.IO server so room broadcasts fan out across replicas (`REDIS_ENABLED=true`). Falls back to in-memory (single-node) adapter if the Redis clients fail to construct, rather than refusing to boot. `close(server)` gracefully quits both clients with a 2s timeout then force-disconnects. Explicitly scoped: this distributes event fan-out only — key eviction, WS rate limits, and the engine registry stay process-local. Exports `isWsRedisEnabled()`, `wsRedisOptions()`, `WS_REDIS_QUIT_TIMEOUT_MS`.

##### `src/modules/events/ws-rate-limit.ts`
In-process (per-replica) rate limiting for the gateway, since WS frames bypass the Nest HTTP guard pipeline.
- **`TokenBucketLimiter`** — per-subject token bucket (`allow(subject)`), used for the frame limiter.
- **`SlidingWindowLimiter`** — per-subject fixed-window counter (`allow(subject)`, `refund(subject)`), used for the pre-auth handshake limiter (refunded once a handshake authenticates, so only genuine failures consume the budget).
- Both maps are capped (approximate LRU eviction) against unbounded growth from a distinct-key flood.
- `readWsRateLimitConfig(env?)` — reads `WS_RATE_LIMIT_FRAME_PER_SECOND`, `WS_RATE_LIMIT_FRAME_BURST`, `WS_RATE_LIMIT_HANDSHAKE_MAX`, `WS_RATE_LIMIT_HANDSHAKE_WINDOW_MS`, `WS_MAX_SOCKETS_PER_KEY`.

---

### webhook

The `webhook` module is the outbound event-delivery system: per-session webhook registration/CRUD, smart pre-filters, signed/queued/direct delivery with retries, a durable outbox + reconciler (closing the crash window between "event occurred" and "POST attempted"), and a durable delivery-failure log for operator visibility.

##### `src/modules/webhook/webhook.controller.ts`
**Controller `WebhookController`** (`@Controller('sessions/:sessionId/webhooks')`)
| Method | Path | Handler | Description | Guards |
|---|---|---|---|---|
| POST | `/sessions/:sessionId/webhooks` | `create` | Register a webhook. | `@RequireRole(OPERATOR)`, 201 |
| GET | `/sessions/:sessionId/webhooks` | `findBySession` | List a session's webhooks. | `@RequireRole(OPERATOR)` |
| GET | `.../:id` | `findOne` | Get one webhook. | `@RequireRole(OPERATOR)` |
| PUT | `.../:id` | `update` | Update a webhook. | `@RequireRole(OPERATOR)` |
| POST | `.../:id/test` | `test` | Send a test payload synchronously, report success/status/error. | `@RequireRole(OPERATOR)` |
| DELETE | `.../:id` | `delete` | Delete a webhook. | `@RequireRole(OPERATOR)`, 204 |

##### `src/modules/webhook/webhooks-list.controller.ts`
**Controller `WebhooksListController`** (`@Controller('webhooks')`, deployment-wide, not session-scoped)
| Method | Path | Handler | Description | Guards |
|---|---|---|---|---|
| GET | `/webhooks/delivery-failures` | `deliveryFailures` | List recently-failed (retries-exhausted) deliveries; `sessionId`/`limit`/`offset` filters, scoped to the key's `allowedSessions`. | `@RequireRole(ADMIN)` |
| GET | `/webhooks` | `findAll` | List webhooks visible to the key (scoped to its `allowedSessions`). | `@RequireRole(OPERATOR)` |

##### `src/modules/webhook/webhook.module.ts`
**Module `WebhookModule`** — imports `TypeOrmModule.forFeature([Webhook, WebhookDeliveryFailure, WebhookOutboxEvent, Session], 'data')`, `EngineModule`, and conditionally `QueueModule` (only if `QUEUE_ENABLED=true`, loaded via `require` to avoid a hard Redis dependency). Controllers: `WebhookController`, `WebhooksListController`. Providers: `WebhookService`, `WebhookDeliveryService`, `WebhookOutboxService`, `WebhookReconcilerService`. Exports `WebhookService`.

##### `src/modules/webhook/webhook.service.ts`
**`WebhookService`** (`OnModuleInit`, `OnModuleDestroy`) — registration/CRUD, the test probe, and failure-log queries. Event delivery itself lives on `WebhookDeliveryService`; `dispatch()` here is the stable facade every event producer calls.
- `onModuleInit()`: daily prune of `webhook_delivery_failures` older than `WEBHOOK_FAILURE_RETENTION_DAYS` (default 90).
- `create(sessionId, dto)`: 404 if session missing; SSRF-validates the URL (rejects embedded credentials always, full SSRF guard if enabled); enforces per-session webhook cap (`WEBHOOK_MAX_PER_SESSION`, default 16, soft/best-effort).
- `findBySession`, `findAll(allowedSessions?, opts)`, `findOne(sessionId, id)` (404), `update`, `delete`.
- `listDeliveryFailures(opts, allowedSessions?)`: scoped by the caller's key.
- `test(sessionId, webhookId)`: builds a synthetic `test` payload, signs it, POSTs via `withSafeFetch`.
- `dispatch(sessionId, event, data)`: delegates to `WebhookDeliveryService.dispatch`.
- `pruneDeliveryFailures(olderThanDays)`.

##### `src/modules/webhook/webhook-delivery.service.ts`
**`WebhookDeliveryService`** (`OnModuleInit`, `OnModuleDestroy`) — the delivery engine: fan-out, queueing, retries, dead-lettering.
- `dispatch(sessionId, event, data)`: loads active webhooks, filters by subscription + smart filters (`filterMatchingWebhooks`), sheds over-cap inline media once before per-webhook cloning, then runs each matching webhook through `dispatchWithLimit` (bounded by `ConcurrencyLimiter`, default 16 concurrent).
- `dispatchWithLimit`: opens a durable `WebhookOutboxService` row BEFORE attempting delivery (crash-safety), then `deliverOne`, then closes the outbox row.
- `deliverOne` → `preflightDelivery` (runs `webhook:before` hook, re-asserts identity fields after the hook, enforces `webhook.maxPayloadBytes` with a size-gated media-shed retry) → `enqueueWithFallback` (BullMQ job, `jobId: deliveryId` for exactly-once; falls back to direct delivery if `add()` throws) or `deliverDirect` (inline POST with its own retry/backoff loop in `deliverWebhook`).
- `redeliver(webhook, sessionId, event, idempotencyKey, data)`: reconciler replay entry point, reusing the stored idempotency key.
- Returns `WebhookDeliveryOutcome` (`'delivered'|'enqueued'|'cancelled'|'failed'`) rather than throwing, so the reconciler can tell a delivered event from a dead-lettered one.
- `onModuleDestroy()`: bounded drain (`WEBHOOK_SHUTDOWN_DRAIN_MS`, default 5s) of in-flight direct deliveries; logs abandoned ones.
- `sanitizeCustomHeaders(custom)`, `generateSignature(payload, secret)` (HMAC-SHA256, `sha256=` prefix).

##### `src/modules/webhook/webhook-outbox.service.ts`
**`WebhookOutboxService`** (`OnModuleInit`, `OnModuleDestroy`) — durable row-lifecycle for one outbound delivery (`pending`→`dispatched`/`failed`).
- `open(row)`: insert as `pending`, idempotent on `(webhookId, idempotencyKey)` conflict.
- `close(webhookId, idempotencyKey, state)`: retire the row, null out the payload.
- `findStale(olderThan, limit)`: the reconciler's input — pending rows past the grace window.
- `countAttempt(id, attempts)`.
- `pruneSettled(olderThanDays)`: daily prune of settled rows (`WEBHOOK_OUTBOX_RETENTION_DAYS`, default 7); pending rows are never pruned by age.

##### `src/modules/webhook/webhook-reconciler.service.ts`
**`WebhookReconcilerService`** (`OnModuleInit`, `OnModuleDestroy`) — closes the crash window on outbound delivery. Every `WEBHOOK_RECONCILE_INTERVAL_MS` (default 60s), sweeps stale `pending` outbox rows and replays them via `WebhookDeliveryService.redeliver`; rows past `WEBHOOK_RECONCILE_MAX_ATTEMPTS` (default 5) or whose webhook was deleted/deactivated are marked `failed` and left to the delivery-failure table. Does not claim rows (two nodes may both replay; receivers dedupe on the shared idempotency key). `sweep(opts, now)`, `resolveWebhookReconcilerOptions(env)`.

##### `src/modules/webhook/entities/webhook.entity.ts`
`Webhook` entity (table `webhooks`): `id`, `sessionId` (indexed, FK cascade), `url`, `events: string[]`, `secret?`, `headers` (JSON), `filters?: WebhookFilters|null`, `active`, `retryCount`, `lastTriggeredAt?`, timestamps.

##### `src/modules/webhook/entities/webhook-delivery-failure.entity.ts`
`WebhookDeliveryFailure` entity (table `webhook_delivery_failures`) — one durable row per delivery that exhausted all retries: `webhookId`, `sessionId`, `event`, `url`, `idempotencyKey`, `deliveryId`, `attempts`, `lastStatusCode?`, `lastError`, `createdAt`.

##### `src/modules/webhook/entities/webhook-outbox-event.entity.ts`
`WebhookOutboxState` type (`'pending'|'dispatched'|'failed'`). `WebhookOutboxEvent` entity (table `webhook_outbox_events`, unique on `(webhookId, idempotencyKey)`) — the durable pre-attempt record: `payload` (nulled once an outcome is recorded), `state`, `attempts`, `lastAttemptAt`.

##### `src/modules/webhook/dto/index.ts`
Re-exports `webhook.dto`.

##### `src/modules/webhook/dto/webhook.dto.ts`
`WEBHOOK_EVENTS` (the full catalog of dispatchable event names) + `WEBHOOK_RESERVED_EVENTS` (currently empty). `CreateWebhookDto` (url, events?, secret? min 16 chars, headers?, filters?, retryCount? 0–5), `UpdateWebhookDto` (all optional; empty-string secret clears it), `WebhookResponseDto` (+`fromEntity`/`fromEntities`, deliberately omits `secret`/`headers`), `WebhookDeliveryFailureDto`, `WebhookTestResponseDto`. Includes Swagger-only metadata classes `WebhookFilterConditionDto`/`WebhookFiltersDto` mirroring the `WebhookFilters` interface.

##### `src/modules/webhook/dto/is-header-map.validator.ts`
`IsHeaderMap()` — validates operator-supplied custom headers: valid header-name chars, string values, no control chars (CR/LF injection), ≤50 entries, value ≤1024 chars.

##### `src/modules/webhook/entities/*` — see above.

##### `src/modules/webhook/filters/filter-types.ts`
The smart-filter type system: `FilterOperator` (`is`/`isNot`/`contains`/`equals`), `FieldKind` (`id`/`idArray`/`text`/`enum`/`boolean`), `WebhookFilterCondition`, `WebhookFilters`, `FieldDefinition`. `FILTER_FIELDS` registry (keyed by event family, currently only `message`: `sender`, `recipient`, `body`, `type`, `isGroup`, `fromMe`, `hasMedia`, `mentions`). `eventFamily(event)`, `getFieldDefinition(family, field)`, `findFieldDefinition(field)`. Guard-rail constants `MAX_CONDITIONS` (20), `MAX_VALUES_PER_CONDITION` (100), `MAX_TEXT_VALUE_LENGTH` (1000).

##### `src/modules/webhook/filters/filter-evaluator.ts`
`evaluateFilters(filters, event, data, resolve?)` — returns true (fire) when every condition matches (AND); absent/empty filters always pass. Canonicalizes JIDs across user dialects (`@c.us`/`@s.whatsapp.net`/`@lid`) via `toNeutralJid` so a phone filter matches regardless of which dialect the engine emitted. `LidResolver` type.

##### `src/modules/webhook/filters/filter-validation.ts`
`collectFilterErrors(value)` — pure validator returning human-readable problems for a `WebhookFilters` object (field existence, operator validity per field kind, value shape/size). `IsValidWebhookFilters()` class-validator decorator wrapping it.

##### `src/modules/webhook/utils/deliver-once.ts`
`postWebhookPayload(url, body, headers, timeoutMs, fetch?)` — the shared SSRF-guarded POST + response classification core used by both the direct and queued delivery paths. `recordTerminalFailure(failureRepository, logger, input)` — shared wrapper writing a terminal failure row.

##### `src/modules/webhook/utils/idempotency.util.ts`
`generateIdempotencyKey(event, data, occurredAt?)` — deterministic per-event-family key derivation (content-based for one-shot events like `message.received`; `occurredAt`-salted for recurring events like `message.edited`/`session.status`/`presence.update`). `generateDeliveryId()` — `dlv_<uuid>`.

##### `src/modules/webhook/utils/record-delivery-failure.ts`
`statusCodeFromError(message)` — parses `HTTP <code>: ...` prefix. `recordWebhookDeliveryFailure(repo, logger, input)` — appends one row per lost delivery (deduped on `(webhookId, idempotencyKey)` so a replayed failure isn't recorded twice), best-effort (never throws back into the dispatch loop).

---

### status

The `status` module covers WhatsApp Status/Stories: reading ingested statuses (served from the local store, not the engine, since Baileys never implemented status reads), posting text/image/video/voice statuses, streaming status media, and deleting own statuses.

##### `src/modules/status/status.controller.ts`
**Controller `StatusController`** (`@Controller('sessions/:sessionId/status')`)
| Method | Path | Handler | Description | Guards |
|---|---|---|---|---|
| GET | `/sessions/:sessionId/status` | `getStatuses` | All status updates visible to the session, grouped by contact. | — |
| GET | `.../:id` | `getContactStatus` | Statuses from one contact. | — |
| GET | `.../:statusId/media` | `getStatusMedia` | Stream stored status media (attachment, inert mimetype unless safe). | — |
| POST | `.../send-text` | `sendTextStatus` | Post a text status. | `@RequireRole(OPERATOR)`, 201 |
| POST | `.../send-image` | `sendImageStatus` | Post an image status. | `@RequireRole(OPERATOR)`, 201 |
| POST | `.../send-video` | `sendVideoStatus` | Post a video status. | `@RequireRole(OPERATOR)`, 201 |
| POST | `.../send-voice` | `sendVoiceStatus` | Post an audio status as a voice note (Ogg/Opus only — convert first via media module). | `@RequireRole(OPERATOR)`, 201 |
| DELETE | `.../:id` | `deleteStatus` | Delete own status. | `@RequireRole(OPERATOR)` |

Recipients allow-list (`recipients` field on all three send-media/text DTOs) is honored on Baileys only; whatsapp-web.js broadcasts per the account's own status-privacy setting.

##### `src/modules/status/status.module.ts`
**Module `StatusModule`** — imports `MessageModule`, `StatusStoreModule`. Controllers: `StatusController`. Providers/exports: `StatusService`.

##### `src/modules/status/status.service.ts`
**`StatusService`** — status posting/reading, through the same `message:sending` moderation gate and `SendPacingService` as chat sends.
- `getStatuses(sessionId)`, `getContactStatus(sessionId, contactId)`: read from `StatusStoreService` (not the engine).
- `getStatusMedia(sessionId, statusId)`: resolves the stored file; mimetype restricted to `image|video|audio` and explicitly excludes `image/svg+xml` (scriptable) — falls back to inert octet-stream otherwise; 404 if the row/file is gone (TTL purge race).
- `postTextStatus`, `postImageStatus`, `postVideoStatus`, `postVoiceStatus` (defaults mimetype `audio/ogg; codecs=opus`, no caption field — WhatsApp has nowhere to render one): each validates url-xor-base64 + media cap, runs the `gate()` (pacing + `message:sending` hook), re-validates the (possibly plugin-rewritten) media via `guardGatedMedia`, then calls the engine through `recordedPost` (feeds the send-pacing breaker).
- `deleteStatus(sessionId, statusId)`.

##### `src/modules/status/dto/send-text-status.dto.ts`
`SendTextStatusDto` (text, backgroundColor? hex, font? WhatsApp enum index, recipients? up to 256 JIDs).

##### `src/modules/status/dto/send-media-status.dto.ts`
`StatusMediaInput` (url xor base64 + mimetype), `SendImageStatusDto`, `SendVideoStatusDto` (both + caption + recipients), `SendVoiceStatusDto` (+ backgroundColor, no caption, + recipients).

##### `src/modules/status/dto/status-response.dto.ts`
`StatusContactDto`, `StatusDto` (id, contact, type, caption?, mediaUrl?, media?, backgroundColor?, font?, timestamp, expiresAt), `StatusListResponseDto`, `StatusResultDto` (statusId, timestamp, expiresAt), `StatusDeletedResponseDto`.

---

### status-store

A standalone persistence service (no controller — consumed by `status`, `session`, and the message projector) that ingests inbound status/story broadcasts into a 24h-TTL table with media archived to the shared file store, plus retention and orphan-reconciliation sweeps mirroring `chat-media`.

##### `src/modules/status-store/status-store.module.ts`
**Module `StatusStoreModule`** — imports `TypeOrmModule.forFeature([StatusUpdate], 'data')`, `ConfigModule`, `StorageModule`. Provides/exports `StatusStoreService`.

##### `src/modules/status-store/status-store.service.ts`
**`StatusStoreService`** (`OnModuleInit`, `OnModuleDestroy`) — the persistence engine behind status reads.
- `ingest(sessionId, s: IncomingStatus)`: idempotent insert on `(sessionId, waStatusId)` (row-first, then media write — crash-safe ordering); returns `{row, created}` so a caller can gate a once-per-status webhook dispatch on `created`.
- `applyMediaDecision(row, s)` / `attachMedia(row, sessionId, s)`: decides whether a media blob is kept (within `status.mediaMaxBytes`, default 10 MiB, not engine-omitted) and writes it to `statuses/<sessionId>/<uuid>.<ext>`, recording `omitReason` (`over_cap`/`engine_omitted`/`write_failed`) otherwise.
- `list(sessionId)`, `listByContact(sessionId, contactJid)`: exclude expired rows; `listByContact` expands JID dialect candidates (phone ↔ `@lid`) via `LidMappingStoreService`.
- `getMedia(sessionId, statusId)`: path+mimetype for the status media route.
- `purgeExpired(now)`: deletes rows (and their files) past `expiresAt`; a failed file-delete keeps the row for retry.
- `sweepOrphanedMedia(now)`: hourly reconciliation of `statuses/`-prefixed files no row references (grace-windowed, in-memory first-seen tracking).
- Exported constants: `STATUS_TTL_MS` (24h), `DEFAULT_MEDIA_MAX_BYTES` (10 MiB).

#### `src/modules/status-store/entities/status-update.entity.ts`
`StatusUpdate` entity (table `status_updates`, unique on `(sessionId, waStatusId)`, indexed on `(sessionId, contactJid)`): `contactJid`, `contactName?`, `contactPushName?`, `waStatusId`, `type` (`text`/`image`/`video`/`voice`), `caption?`, `mediaPath?`/`mediaMimetype?`/`mediaOmitted`/`omitReason?`, `backgroundColor?`, `font?`, `postedAt` (epoch ms), `expiresAt` (epoch ms, indexed).

#### `src/modules/status-store/incoming-status.ts`
`IncomingStatus` interface — the engine-neutral shape `StatusStoreService.ingest` consumes. `buildIncomingStatus(msg: IncomingMessage)`: converts an inbound status-broadcast `IncomingMessage` to an `IncomingStatus`, or `null` if not a usable status broadcast (not status-flagged, missing id, or poster unresolved/is the `status@broadcast` pseudo-JID itself). `statusType(t)` collapses the rich `MessageType` to the status union (`text`/`image`/`video`/`voice`).

---

## 7. Modules — Contacts & Social

This section documents nine `src/modules/**` subsystems: `contact`, `group`, `label`, `catalog`, `template`, `takeover`, `wa-chat`, `profile`, and `staff-notify`. All routes below are mounted under the global API prefix used by the rest of the gateway (session-scoped modules are mounted at `sessions/:sessionId/...`). Guard notes (`@RequireRole`) refer to the API-key role hierarchy; routes without a `@RequireRole` decorator require only a valid API key (any role) unless otherwise noted. `ENGINE_NOT_READY_409`, `ENGINE_REFUSED_403`, `ENGINE_NOT_SUPPORTED_501`, `GROUP_NOT_FOUND_404`, `LABEL_NOT_FOUND_404`, `SESSION_NOT_STARTED_404` are shared OpenAPI response-description constants imported from `src/common/openapi/engine-status-responses.ts`.

---

### contact — `src/modules/contact/`

Exposes the per-session WhatsApp addressbook: listing/looking up contacts, number-existence checks, profile pictures, block/unblock, and lid→phone resolution. All operations proxy to the active `IWhatsAppEngine` for a session via `EngineRegistry`; the service layer adds validation (e.g. refusing group/lid ids where a phone-keyed addressbook write is required) and not-found mapping that the raw engine calls don't provide.

#### `src/modules/contact/contact.controller.ts`
Controller exposing the contacts REST surface for a session. `@Controller('sessions/:sessionId/contacts')`.

| Method | Path | Handler | Description | Guard |
|---|---|---|---|---|
| GET | `/sessions/:sessionId/contacts` | `findAll` | List all contacts, windowed by `limit`/`offset` query params (max ~1000, default 1000). Returns a bare array. | API key |
| GET | `/sessions/:sessionId/contacts/profile-pictures` | `getProfilePictures` | Batch-resolve profile picture URLs for up to 50 comma-separated `ids`. Declared before `:contactId` so the literal segment wins. | API key |
| GET | `/sessions/:sessionId/contacts/blocked` | `getBlockedContacts` | List blocked contact ids (bare ids only — the honest common subset across engines). Declared before `:contactId`. | API key |
| GET | `/sessions/:sessionId/contacts/:contactId` | `findOne` | Get one contact by id; 404 if not found. | API key |
| GET | `/sessions/:sessionId/contacts/check/:number` | `checkNumber` | Check if a phone number is registered on WhatsApp; returns `{number, exists, whatsappId}`. | API key |
| GET | `/sessions/:sessionId/contacts/:contactId/profile-picture` | `getProfilePicture` | Get one contact's profile picture URL (`{url}`). | API key |
| GET | `/sessions/:sessionId/contacts/:contactId/phone` | `resolvePhone` | Best-effort resolve a contact id (e.g. `@lid`) to an MSISDN phone number. | API key |
| PUT | `/sessions/:sessionId/contacts/:contactId` | `upsertContact` | Save or edit an addressbook entry (firstName/lastName). | `@RequireRole(OPERATOR)` |
| DELETE | `/sessions/:sessionId/contacts/:contactId` | `deleteContact` | Remove a contact from the addressbook. | `@RequireRole(OPERATOR)` |
| POST | `/sessions/:sessionId/contacts/:contactId/block` | `blockContact` | Block a contact. | `@RequireRole(OPERATOR)` |
| DELETE | `/sessions/:sessionId/contacts/:contactId/block` | `unblockContact` | Unblock a contact. | `@RequireRole(OPERATOR)` |

#### `src/modules/contact/contact.module.ts`
NestJS module. Imports: none. Controllers: `ContactController`. Providers: `ContactService`. Exports: `ContactService`.

#### `src/modules/contact/contact.service.ts`
`ContactService` — owns engine access for contact operations; houses the "session not started" guard and contact business rules.
- `getContacts(sessionId, opts)` — fetches all contacts from the engine, then paginates via `limit`/`offset`.
- `getContactById(sessionId, contactId)` — fetches one contact; throws `NotFoundException` if null.
- `getBlockedContacts(sessionId)` — returns neutral blocked-contact ids.
- `checkNumberExists(sessionId, number)` / `getNumberId(sessionId, number)` — thin passthroughs to the engine.
- `resolveContactPhone(sessionId, contactId)` — resolves a contact id to a phone; swallows (logs at debug) lookup errors to return `null`, but re-throws `HttpException`s (e.g. 400 not-started) unchanged.
- `getProfilePicture(sessionId, contactId)` — single picture URL lookup.
- `getProfilePictures(sessionId, ids)` — batches up to 50 ids (`PROFILE_PICTURES_MAX_IDS`), 5 concurrent lookups per chunk, each with an 8s per-id timeout (`PROFILE_PICTURE_LOOKUP_TIMEOUT_MS`); per-id failure/timeout yields `null`, never fails the whole batch.
- `blockContact(sessionId, contactId)` / `unblockContact(sessionId, contactId)` — validate via `assertBlockable` (must name an individual: phone-based or `@lid`) then normalize the id via `toAddressableId` before calling the engine.
- `assertBlockable(contactId)` (private) — rejects ids that don't name an individual (group ids or free text).
- `assertAddressable(contactId)` (private) — rejects `@lid` or non-phone ids for addressbook writes (upsert/delete), since the addressbook is keyed by phone number.
- `isBareNumber(contactId)` (private) — detects a digits-only id.
- `toAddressableId(contactId)` (private) — qualifies a bare number to `@c.us` / normalizes to the neutral JID dialect before engine calls.
- `upsertContact(sessionId, contactId, firstName, lastName?)` — validates addressability, then saves/edits the addressbook entry.
- `deleteContact(sessionId, contactId)` — validates addressability, then removes the entry.

#### `src/modules/contact/dto/contact-response.dto.ts`
Response DTOs (raw handler payloads, no envelope):
- `ContactDto` — `id`, `name?`, `pushName?`, `number`, `isMyContact`, `isBlocked`, `profilePicUrl?`.
- `ProfilePictureResponseDto` — `{url: string | null}`.
- `ProfilePicturesResponseDto` — `{pictures: {[contactId]: string | null}}`.
- `NumberCheckResponseDto` — `{number, exists, whatsappId: string | null}`.
- `ResolvedPhoneResponseDto` — `{contactId, phone: string | null}`.
- `ContactAckResponseDto` — `{success: true, message}`.

#### `src/modules/contact/dto/upsert-contact.dto.ts`
`UpsertContactDto` — `firstName` (required, 1–100 chars), `lastName?` (optional, ≤100 chars). Exports `ADDRESSBOOK_NAME_MAX_LENGTH = 100`.

---

### group — `src/modules/group/`

Exposes group lifecycle and administration: info/listing, creation, participant management (add/remove/promote/demote), membership-request approval, settings (announce/locked/ephemeral/member-add-mode), subject/description, picture, invite codes, and join/leave. Participant-affecting writes are rate-"paced" via `SendPacingService` to curb WhatsApp ban risk from bulk cold outreach.

#### `src/modules/group/group.controller.ts`
`@Controller('sessions/:sessionId/groups')`. Note: the bare group-list route lives on `SessionController` (`GET /sessions/:sessionId/groups`), not here, to avoid a path collision — this controller owns only `:groupId/...` sub-resources plus a couple of literal-prefixed helper routes.

| Method | Path | Handler | Description | Guard |
|---|---|---|---|---|
| GET | `/sessions/:sessionId/groups/join-info` | `joinInfo` | Preview a group from an invite `code` without joining (read-only). Declared before `:groupId`. | API key |
| GET | `/sessions/:sessionId/groups/for-contact` | `getSharedGroups` | List groups this session shares with one `contactId` (server-side computed, bounded concurrency). Declared before `:groupId`. | API key |
| GET | `/sessions/:sessionId/groups/:groupId` | `findOne` | Get detailed group info with participants; 404 if not found. | API key |
| POST | `/sessions/:sessionId/groups/join` | `join` | Join a group via invite code. | `@RequireRole(OPERATOR)` |
| GET | `/sessions/:sessionId/groups/:groupId/settings` | `getSettings` | Get announce/locked/ephemeral/memberAddMode settings. | API key |
| PUT | `/sessions/:sessionId/groups/:groupId/settings` | `updateSettings` | Update one or more settings; empty patch = 400. | `@RequireRole(OPERATOR)` |
| POST | `/sessions/:sessionId/groups` | `create` | Create a new group (Baileys-only; whatsapp-web.js answers 501). Paced. | `@RequireRole(OPERATOR)` |
| POST | `/sessions/:sessionId/groups/:groupId/participants` | `addParticipants` | Add participants; paced (cold-reachout budget); per-participant results in response. | `@RequireRole(OPERATOR)` |
| DELETE | `/sessions/:sessionId/groups/:groupId/participants` | `removeParticipants` | Remove participants; per-participant results. | `@RequireRole(OPERATOR)` |
| POST | `/sessions/:sessionId/groups/:groupId/participants/promote` | `promoteParticipants` | Promote participants to admin. | `@RequireRole(OPERATOR)` |
| POST | `/sessions/:sessionId/groups/:groupId/participants/demote` | `demoteParticipants` | Demote participants from admin. | `@RequireRole(OPERATOR)` |
| GET | `/sessions/:sessionId/groups/:groupId/membership-requests` | `getMembershipRequests` | List pending join requests (admin-only on both engines). | API key |
| POST | `/sessions/:sessionId/groups/:groupId/membership-requests/approve` | `approveMembershipRequests` | Approve named requesters, or all pending if body omits `participants`. Not paced. | `@RequireRole(OPERATOR)` |
| POST | `/sessions/:sessionId/groups/:groupId/membership-requests/reject` | `rejectMembershipRequests` | Reject named requesters, or all pending if omitted. Not paced. | `@RequireRole(OPERATOR)` |
| PUT | `/sessions/:sessionId/groups/:groupId/subject` | `setSubject` | Change group name/subject. | `@RequireRole(OPERATOR)` |
| PUT | `/sessions/:sessionId/groups/:groupId/description` | `setDescription` | Change group description. | `@RequireRole(OPERATOR)` |
| POST | `/sessions/:sessionId/groups/:groupId/leave` | `leave` | Leave the group. | `@RequireRole(OPERATOR)` |
| GET | `/sessions/:sessionId/groups/:groupId/picture` | `getPicture` | Get group picture URL (`{url}`, null if none). | API key |
| PUT | `/sessions/:sessionId/groups/:groupId/picture` | `setPicture` | Set group picture via URL or base64. | `@RequireRole(OPERATOR)` |
| DELETE | `/sessions/:sessionId/groups/:groupId/picture` | `deletePicture` | Remove group picture. | `@RequireRole(OPERATOR)` |
| GET | `/sessions/:sessionId/groups/:groupId/invite-code` | `getInviteCode` | Get invite code + constructed `https://chat.whatsapp.com/<code>` link. Admin-only. | API key |
| POST | `/sessions/:sessionId/groups/:groupId/invite-code/revoke` | `revokeInviteCode` | Revoke and regenerate the invite code. | `@RequireRole(OPERATOR)` |

#### `src/modules/group/group.module.ts`
Imports: `MessageModule`. Controllers: `GroupController`. Providers: `GroupService`. Exports: `GroupService`.

#### `src/modules/group/group.service.ts`
`GroupService` — engine access + business rules for groups.
- `assertAddressableParticipants(participants)` (private) — rejects non-individual participant ids (shared logic also matters for MCP agent tools that bypass the DTO validation). Runs before pacing.
- `getGroups(sessionId, opts)` — full list + `paginate(limit, offset)`.
- `getGroupInfo(sessionId, groupId)` — 404s if the engine returns null.
- `getGroupsForParticipant(sessionId, contactId, opts)` — matches a contact against every group's participant list by last-10-digits phone key; bounded concurrency (5) over `getGroupInfo` calls; `limit` caps groups scanned (default 100).
- `createGroup(sessionId, name, participants)` — validates participants, checks `pacing.assertReachoutAllowed`, creates via engine, charges reachout cost.
- `addParticipants(sessionId, groupId, participants)` — same pacing pattern as create.
- `removeParticipants` / `promoteParticipants` / `demoteParticipants` — validate then passthrough (not paced).
- `getGroupMembershipRequests(sessionId, groupId)` — passthrough.
- `approveGroupMembershipRequests` / `rejectGroupMembershipRequests` — optional `participants` (undefined = act on all); validated only if provided; not paced.
- `setGroupSubject` / `setGroupDescription` / `leaveGroup` / `getGroupInviteCode` / `revokeGroupInviteCode` — thin passthroughs.
- `getGroupJoinInfo(sessionId, inviteCode)` — requires non-empty code (400 otherwise).
- `joinGroupViaInviteCode(sessionId, inviteCode)` — passthrough.
- `assertGroupId(groupId)` (private) — rejects non-group ids before reaching the group-picture routes (both engines reuse the account profile-picture primitive, which is dangerous on a non-group id).
- `getGroupPicture` / `setGroupPicture` / `deleteGroupPicture` — validate group id; `setGroupPicture` builds a `MediaInput` from url/base64 (base64 wins), requires `mimetype` with base64, enforces the media size cap via `assertBase64WithinMediaCap`.
- `getGroupSettings(sessionId, groupId)` — derives `{announce, locked, ephemeralSeconds?, memberAddMode?}` from `getGroupInfo`.
- `updateGroupSettings(sessionId, groupId, settings)` — applies only present fields; order is deliberate (`ephemeralSeconds` first since it's the only field with a deterministic engine refusal, so a failure there means nothing was applied yet); a later-step failure throws an `HttpException` naming the failed field and what was already applied (partial-apply visibility).

#### `src/modules/group/dto/group-response.dto.ts`
Response DTOs: `GroupParticipantDto` (`id, number, name?, isAdmin, isSuperAdmin`), `GroupSummaryDto` (`id, name, participantsCount?, isAdmin?, linkedParentJID?`), `GroupInfoDto` (full detail incl. `participants[]`, `isReadOnly?`, `isAnnounce?`, `announce?`, `locked?`, `ephemeralSeconds?`, `memberAddMode?`), `GroupJoinInfoDto` (pre-join preview, `participantCount?` not a list), `GroupSettingsResponseDto`, `GroupAckResponseDto` (`{success, message}`), `ParticipantOperationResultDto` (`{id, success, status?, message?}`), `ParticipantsOperationResponseDto extends GroupAckResponseDto` (adds `results[]`), `GroupMembershipRequestDto` (`{participantId, addedById?, method?, requestedAt?}`), `GroupJoinedResponseDto` (`{success, groupId}`), `GroupPictureResponseDto` (`{url: string|null}`), `GroupInviteCodeResponseDto` (`{inviteCode, inviteLink}`), `GroupInviteCodeRevokedResponseDto extends GroupInviteCodeResponseDto` (adds `message`).

#### `src/modules/group/dto/group.dto.ts`
Request DTOs. Exports `GROUP_NAME_MAX_LENGTH=100`, `GROUP_DESCRIPTION_MAX_LENGTH=1024`, `GROUP_PARTICIPANTS_MAX=256`.
- `CreateGroupDto` — `name` (≤100), `participants: string[]` (1–256 items).
- `ParticipantsDto` — `participants: string[]` (1–256 items).
- `MembershipRequestActionDto` — `participants?: string[]`; uses `@ValidateIf` (not `@IsOptional`) so an explicit `null` 400s instead of being read as "act on all" — avoids accidentally mass-approving/rejecting.
- `GroupSubjectDto` — `subject` (≤100).
- `GroupDescriptionDto` — `description` (≤1024, may be empty to clear).
- `JoinGroupDto` — `inviteCode` (≤128).
- `SetGroupPictureDto` — `url?` (http/https, required if no base64), `base64?` (required if no url), `mimetype?` (must match `^image/`).
- `GroupSettingsDto` — `announce?`, `locked?` (both `@ToStrictBoolean`), `ephemeralSeconds?` (`@ToStrictNumber`, ≥0), `memberAddMode?` (`'all' | 'admins'`); all use `@ValidateIf` on definedness so only truly-set fields validate.

---

### label — `src/modules/label/`

Exposes WhatsApp Business label management: list/read labels, create-or-update/delete (Baileys-only — the label-edit protocol write), list chats by label (whatsapp-web.js-only read), and per-chat label add/remove. The two engines have asymmetric capabilities here (Baileys can write but not query by label; whatsapp-web.js can query/assign but not edit), reflected throughout the controller's 501 responses.

#### `src/modules/label/label.controller.ts`
`@Controller('sessions/:sessionId/labels')`.

| Method | Path | Handler | Description | Guard |
|---|---|---|---|---|
| GET | `/sessions/:sessionId/labels` | `findAll` | List all labels (WhatsApp Business only). | API key |
| GET | `/sessions/:sessionId/labels/:labelId` | `findOne` | Get one label; 404 if not found. | API key |
| GET | `/sessions/:sessionId/labels/:labelId/chats` | `getChatsByLabel` | List chats carrying a label. whatsapp-web.js only; Baileys 501s (no label query). | API key |
| PUT | `/sessions/:sessionId/labels/:labelId` | `upsertLabel` | Create or update a label (caller-chosen id). Baileys only; whatsapp-web.js 501s (can't edit). | `@RequireRole(OPERATOR)` |
| DELETE | `/sessions/:sessionId/labels/:labelId` | `deleteLabel` | Delete a label from every chat it's on. Baileys only. | `@RequireRole(OPERATOR)` |
| GET | `/sessions/:sessionId/labels/chat/:chatId` | `getChatLabels` | Get labels applied to a chat. | API key |
| POST | `/sessions/:sessionId/labels/chat/:chatId` | `addLabelToChat` | Add a label (`labelId` in body) to a chat. | `@RequireRole(OPERATOR)` |
| DELETE | `/sessions/:sessionId/labels/chat/:chatId/:labelId` | `removeLabelFromChat` | Remove a label from a chat. | `@RequireRole(OPERATOR)` |

#### `src/modules/label/label.module.ts`
Imports: none. Controllers: `LabelController`. Providers: `LabelService`. Exports: `LabelService`.

#### `src/modules/label/label.service.ts`
`LabelService`.
- `getLabels(sessionId)` — passthrough.
- `getLabelById(sessionId, labelId)` — 404s if the engine returns null.
- `getChatLabels(sessionId, chatId)` — passthrough.
- `upsertLabel(sessionId, labelId, body: {name?, color?})` — requires at least one of `name`/`color` set (400 otherwise, mirroring group-settings' "at least one field" rule); treats `null` as "not set".
- `deleteLabel(sessionId, labelId)` — passthrough.
- `getChatsByLabel(sessionId, labelId)` — passthrough.
- `addLabelToChat(sessionId, chatId, labelId)` / `removeLabelFromChat(sessionId, chatId, labelId)` — passthroughs.

#### `src/modules/label/dto/add-label.dto.ts`
`AddLabelDto` — `labelId: string` (required, non-empty).

#### `src/modules/label/dto/label-response.dto.ts`
- `LabelDto` — `id, name, hexColor` (hex is a display-only read value; the write side takes a color index 0–19 instead, since neither engine exposes the index↔hex mapping).
- `LabelChatDto` — `id, name, isGroup (legacy), kind, unreadCount, timestamp, lastMessage?`.
- `LabelAckResponseDto` — `{success: true}`.

#### `src/modules/label/dto/upsert-label.dto.ts`
`UpsertLabelDto` — `name?` (1–100 chars, omit to leave unchanged), `color?` (int 0–19, WhatsApp's 20 predefined label colors; `@ToStrictNumber` guards against `Number('')===0` silently recoloring).

---

### catalog — `src/modules/catalog/`

Exposes WhatsApp Business catalog reads (catalog summary, product list/detail) and product-message sending. Baileys-only across the board — whatsapp-web.js has no catalog API and 501s every route. Catalog reads walk a business-catalog IQ that WhatsApp may simply never answer for an account without a catalog, hence the dedicated 503 (`CATALOG_TIMEOUT_503`) rather than treating a timeout as "no catalog."

#### `src/modules/catalog/catalog.controller.ts`
`@Controller('sessions/:sessionId')` (routes nest under `catalog` and `messages`).

| Method | Path | Handler | Description | Guard |
|---|---|---|---|---|
| GET | `/sessions/:sessionId/catalog` | `getCatalog` | Get business catalog summary (Baileys only). | API key |
| GET | `/sessions/:sessionId/catalog/products` | `getProducts` | List catalog products, paginated via `page`/`limit` query (`ProductQueryDto`). | API key |
| GET | `/sessions/:sessionId/catalog/products/:productId` | `getProduct` | Get a specific product. | API key |
| POST | `/sessions/:sessionId/messages/send-product` | `sendProduct` | Send a product card message (Baileys only). | `@RequireRole(OPERATOR)` |

#### `src/modules/catalog/catalog.module.ts`
Imports: `MessageModule`. Controllers: `CatalogController`. Providers: `CatalogService`. Exports: `CatalogService`.

#### `src/modules/catalog/catalog.service.ts`
`CatalogService`.
- `getCatalog(sessionId)` — requires an engine (404 if not found/connected), returns `engine.getCatalog()`.
- `getProducts(sessionId, page=1, limit=20)` — paginated product list.
- `getProduct(sessionId, productId)` — single product lookup.
- `sendProduct(sessionId, chatId, productId, body?)` — real outbound message; calls `pacing.assertSendAllowed` first (unlike MessageService-driven sends, this path persists no DB row and fires no message hooks).
- `sendCatalog(sessionId, chatId, body?)` — paced the same way; both engines currently 501 this, but it's pre-wired so future engine support doesn't silently open an unpaced path. **Note:** no controller route currently calls this method — it exists on the service only.

#### `src/modules/catalog/dto/catalog-response.dto.ts`
- `CatalogDto` — `id` (synthesized from first collection), `name, description?, productCount, url`.
- `ProductDto` — `id, name, description?, price, currency, priceFormatted (gateway-synthesized), imageUrl?, url, isAvailable, retailerId?`.
- `ProductPaginationDto` — `{page, limit, total, totalPages}`.
- `PaginatedProductsDto` — `{products: ProductDto[], pagination: ProductPaginationDto}`.
- `ProductMessageResponseDto` — `{id, timestamp}`; deliberately uses `id` not `messageId` (unlike MessageService-routed sends) since this bypasses MessageService entirely.

#### `src/modules/catalog/dto/send-product.dto.ts`
- `SendProductDto` — `chatId, productId, body?`.
- `ProductQueryDto` — `page?` (default 1, ≥1), `limit?` (default 20, ≥1), both `@Type(() => Number)`.

---

### template — `src/modules/template/`

CRUD for per-session, DB-persisted message templates ({{variable}} placeholders with optional header/footer) used by the send-template message flow. Backed by a Postgres/TypeORM `data` connection; template names are unique per session.

#### `src/modules/template/template.controller.ts`
`@Controller('sessions/:sessionId/templates')`. All routes require `@RequireRole(ApiKeyRole.OPERATOR)`.

| Method | Path | Handler | Description | Guard |
|---|---|---|---|---|
| POST | `/sessions/:sessionId/templates` | `create` | Create a template; 409 if name already exists for the session. | `@RequireRole(OPERATOR)` |
| GET | `/sessions/:sessionId/templates` | `findBySession` | List all templates for the session. | `@RequireRole(OPERATOR)` |
| GET | `/sessions/:sessionId/templates/:id` | `findOne` | Get a template by id; 404 if not found. | `@RequireRole(OPERATOR)` |
| PUT | `/sessions/:sessionId/templates/:id` | `update` | Update a template; 404 if not found, 409 on name collision. | `@RequireRole(OPERATOR)` |
| DELETE | `/sessions/:sessionId/templates/:id` | `delete` | Delete a template. Returns 204 No Content. | `@RequireRole(OPERATOR)` |

#### `src/modules/template/template.module.ts`
Imports: `TypeOrmModule.forFeature([Template], 'data')`. Controllers: `TemplateController`. Providers: `TemplateService`. Exports: `TemplateService`.

#### `src/modules/template/template.service.ts`
`TemplateService` (uses the `'data'`-connection `Repository<Template>`).
- `create(sessionId, dto)` — inserts; catches unique-violation (`isUniqueViolation`) and rethrows as `ConflictException`.
- `findBySession(sessionId)` — all templates for the session, newest first (`createdAt DESC`).
- `findOne(sessionId, id)` — 404s if not found.
- `resolve(sessionId, {templateId?, templateName?})` — used by the send-template message flow; resolves by id first, else by name (deterministic tie-break: earliest `createdAt`); 404s if neither identifier is given or matches.
- `update(sessionId, id, dto)` — partial field update; same unique-violation → 409 mapping.
- `delete(sessionId, id)` — removes the row.

#### `src/modules/template/dto/index.ts`
Barrel re-export: `export * from './template.dto'`.

#### `src/modules/template/dto/template.dto.ts`
- `CreateTemplateDto` — `name` (≤100, unique per session), `body` (≤4096), `header?` (≤1024), `footer?` (≤1024).
- `UpdateTemplateDto` — same fields, all optional.
- `TemplateResponseDto` — `id, sessionId, name, body, header?, footer?, createdAt, updatedAt`.

#### `src/modules/template/entities/template.entity.ts`
`Template` TypeORM entity (`@Entity('templates')`), table `templates`. Fields: `id` (uuid PK), `sessionId` (varchar, FK to `Session` via `@ManyToOne`/`@JoinColumn`, `onDelete: CASCADE`), `name` (varchar 100), `body` (text), `header` (text, nullable), `footer` (text, nullable), `createdAt`, `updatedAt`. Unique composite index `IDX_templates_session_name` on `(sessionId, name)`, mirrored by a migration for non-synchronize DBs.

---

### takeover — `src/modules/takeover/`

Background sweep that adopts WhatsApp sessions whose previous owning node's ownership lease has lapsed (peer crash, or a container-recreate race against boot auto-start), restarting them on this node through the normal session-start path and reconciling any stuck in-flight bulk-message batches. No HTTP surface — purely a lifecycle service.

#### `src/modules/takeover/session-takeover.service.ts`
`SessionTakeoverService implements OnApplicationBootstrap, OnModuleDestroy`.
- Module-level constants: `TAKEOVER_STATUSES` — the set of session statuses worth adopting (`READY, INITIALIZING, AUTHENTICATING, ACTION_REQUIRED, DISCONNECTED`; deliberately excludes `QR_READY` — nothing to resume — and `FAILED` — needs human attention). `TAKEOVER_START_STAGGER_MS = 2000` — pause between successive engine launches during a sweep, matching boot auto-start's Chromium stagger.
- `stopping` (private getter) — true once either `shuttingDown` is set or `ShutdownService.isShuttingDown()` reports true; both gate every tick and every loop iteration.
- `onApplicationBootstrap()` — if `autoStartSessions` feature flag is off, does nothing; otherwise starts a `setInterval` sweep loop (default 30s, configurable via `session.takeoverSweepMs`), guarded against overlap with `sweepInFlight`.
- `onModuleDestroy()` — sets `shuttingDown = true` and clears the interval (does not abort an in-flight sweep).
- `sweep()` (public, exposed for tests) — one pass: queries `ownership.lapsedHeldByOthers()`, filters to eligible sessions, then for each: calls `sessionService.start(session.id)`, logs adoption, calls `bulkMessages.reapProcessingBatches(session.id, reason)` to fail-out any batches stuck in PROCESSING from the dead node. A `ConflictException` (another node won the claim race) is logged at debug and skipped; other errors logged as warnings. Re-checks `stopping` before each iteration and staggers starts by `TAKEOVER_START_STAGGER_MS`.
- `isEligible(session)` (private) — true only if the session has a `phone` set (authenticated) and its status is in `TAKEOVER_STATUSES`.

#### `src/modules/takeover/takeover.module.ts`
Imports: `SessionModule`, `MessageModule` (placed above both to reach `SessionService` and `BulkMessageService` without an import cycle, since `MessageModule` already imports `SessionModule`). Providers: `SessionTakeoverService`. No controllers, no exports.

---

### wa-chat — `src/modules/wa-chat/`

Shared MySQL integration layer connecting this Node gateway to a separate Laravel application ("WaChat"/WAHA-branded product surface) that manages companies, staff, and per-company WhatsApp sessions on the *same* MySQL database Laravel owns. This is how the gateway achieves **per-company session scoping**: a `wa_chat_token` presented on a request resolves (via the `companies` table) to a `company_id`, which downstream code uses to isolate what a given API caller can see — a request authenticated with company A's token should never observe company B's sessions or message logs. It also relays inbound-message events to Laravel's automation engine and logs message activity into Laravel's own `waha_message_logs` table for cross-system visibility. Despite directory/variable naming (`waha_enabled`, `WahaMessage`), the actual underlying WhatsApp engine is open-wa, not WAHA — see project memory on this.

#### `src/modules/wa-chat/mysql.service.ts`
`MysqlService implements OnModuleDestroy` — thin wrapper around a `mysql2/promise` connection pool to the **shared** Laravel database (not the gateway's own Postgres `data`/`control` connections).
- `getPool()` (private) — lazily creates a `mysql.Pool` from `SHARED_DB_HOST/PORT/DATABASE/USERNAME/PASSWORD` env vars (defaults: `localhost:3306/waapi/root/<empty>`), `connectionLimit: 10`.
- `query<T>(sql, values?)` — runs a prepared statement, returns rows as `T[]`.
- `execute(sql, values?)` — runs a prepared statement for side effects (no return value).
- `onModuleDestroy()` — ends the pool on shutdown.

#### `src/modules/wa-chat/wa-chat-auth.middleware.ts`
`WaChatAuthMiddleware implements NestMiddleware` — applied to `'*'` routes by `WaChatModule`. Exports the `WaChatCompany` interface (`id, name, wa_chat_token, waha_enabled`) and augments Express's `Request` with an optional `waChatCompany` field.
- `use(req, res, next)` — skips `/health`, `/docs`, `/swagger` paths. Reads a token from `X-WA-Chat-Token`, `X-Wa-Chat-Token`, or a `Bearer` `Authorization` header. If absent, calls `next()` unmodified — falls through to the gateway's own `ApiKeyGuard`. If present, queries `companies` for a row matching `wa_chat_token = ? AND waha_enabled = 1`; on a match, attaches `req.waChatCompany` (this is the company-scoping hook other per-company logic reads off the request). MySQL errors are logged and swallowed (never blocks the request).

#### `src/modules/wa-chat/wa-chat-log.service.ts`
`WaChatLogService` — writes outbound message activity into Laravel's `waha_message_logs` table.
- `logMessage(entry: MessageLogEntry)` — `entry` fields: `company_id, session_id, recipient_phone?, recipient_type? ('contact'|'group', default 'contact'), message_type? (default 'text'), status ('sent'|'failed'), waha_message_id?, error_message?, campaign_name?`. Inserts a row with `sent_at/created_at/updated_at = NOW()`. Errors are logged and swallowed — a logging failure never fails the caller's message send.

#### `src/modules/wa-chat/automation-event.service.ts`
`AutomationEventService` — bridges inbound WhatsApp messages to Laravel's automation engine and logs them.
- `handleMessageEvent(sessionId, message: WahaMessage)` — called by the webhook handler when a message arrives; no-ops if `message.payload.fromMe`. Looks up a company row (query joins `companies` with a `waha_sessions` subselect keyed on `session_id` — **note:** the outer `WHERE` only filters `waha_enabled = 1` with `LIMIT 1` and does not filter by company for the given session, which looks like it may not scope correctly to the specific company owning `sessionId`); if a `waha_webhook_url` is found, POSTs a normalized `{event: 'message', session, payload: {from, fromMe: false, body, type, chatId}}` body to the resolved Laravel webhook URL (or `LARAVEL_WEBHOOK_URL`/`LARAVEL_BASE_URL` env fallback) with a 5s timeout. Errors/non-OK responses are logged and swallowed.
- `logInboundMessage(sessionId, companyId, from)` — inserts a `received`-status row into `waha_message_logs` (strips the `@...` suffix off `from` to store a bare phone). Errors logged and swallowed.

#### `src/modules/wa-chat/wa-chat.module.ts`
`WaChatModule implements NestModule`. Providers: `MysqlService, WaChatAuthMiddleware, WaChatLogService, AutomationEventService`. Exports: `MysqlService, WaChatLogService, AutomationEventService` (not the middleware — it's applied, not injected elsewhere). `configure()` applies `WaChatAuthMiddleware` to all routes (`forRoutes('*')`).

---

### profile — `src/modules/profile/`

Exposes writes to the WhatsApp account's *own* profile: display name, about/status text, and profile picture (set/remove). All session-scoped, operator-gated writes; no reads (the account's own profile isn't separately exposed here — only the mutation surface).

#### `src/modules/profile/profile.controller.ts`
`@Controller('sessions/:sessionId/profile')`. All routes require `@RequireRole(ApiKeyRole.OPERATOR)`.

| Method | Path | Handler | Description | Guard |
|---|---|---|---|---|
| PUT | `/sessions/:sessionId/profile/name` | `setName` | Set the account display name. whatsapp-web.js may 403 on refusal; Baileys has no acceptance signal and answers 200 even if WhatsApp declined. | `@RequireRole(OPERATOR)` |
| PUT | `/sessions/:sessionId/profile/status` | `setStatus` | Set the about/status text (may be empty to clear). | `@RequireRole(OPERATOR)` |
| PUT | `/sessions/:sessionId/profile/picture` | `setPicture` | Set profile picture via URL or base64; 413 if decoded base64 exceeds the media cap. | `@RequireRole(OPERATOR)` |
| DELETE | `/sessions/:sessionId/profile/picture` | `deletePicture` | Remove the profile picture. | `@RequireRole(OPERATOR)` |

#### `src/modules/profile/profile.module.ts`
Imports: none. Controllers: `ProfileController`. Providers: `ProfileService`. Exports: `ProfileService`.

#### `src/modules/profile/profile.service.ts`
`ProfileService`.
- `setProfileName(sessionId, name)` — passthrough.
- `setProfileStatus(sessionId, status)` — passthrough.
- `deleteProfilePicture(sessionId)` — idempotent; no picture to remove is a no-op.
- `setProfilePicture(sessionId, dto)` — builds a `MediaInput` from `url`/`base64` (base64 wins when both present, mirroring the message module's `buildMediaInput`); requires `mimetype` when using base64; requires at least one of `url`/`base64` (400 otherwise); enforces media size cap via `assertBase64WithinMediaCap`.

#### `src/modules/profile/dto/profile-response.dto.ts`
`ProfileAckResponseDto` — `{success: true, message}`.

#### `src/modules/profile/dto/profile.dto.ts`
- `SetProfileNameDto` — `name` (required, ≤25 chars — WhatsApp's own limit).
- `SetProfileStatusDto` — `status` (≤139 chars, may be empty).
- `SetProfilePictureDto` — `url?` (http/https, required if no base64), `base64?` (required if no url), `mimetype?` (must match `^image/`, required when using base64).

---

### staff-notify — `src/modules/staff-notify/`

Real-time staff-presence and notification relay used by the Laravel-side CRM/support product: a WebSocket gateway lets staff clients (mobile app / web dashboard) connect and receive push notifications (new lead, AI handoff, etc.), while an internal HTTP controller lets the Laravel backend push those notifications and mark staff online. Authentication is JWT-based (shared secret with Laravel), with company id resolved server-side — never trusted from the client — closing a prior vulnerability where any socket could claim to be any staff member.

#### `src/modules/staff-notify/staff-notify.gateway.ts`
`StaffNotifyGateway implements OnGatewayConnection, OnGatewayDisconnect` — `@WebSocketGateway({cors: {origin: '*'}, namespace: '/staff'})`. Maintains an in-memory `Map<staffId, socketId>`.

Socket events:
- **Connection (`handleConnection`)** — on every new socket to namespace `/staff`: reads a JWT from `handshake.auth.token` or an `Authorization: Bearer <token>` header; disconnects immediately if no token. Verifies the JWT with `jwt.verify(token, process.env.JWT_SECRET, {algorithms: ['HS256']})` (disconnects if `JWT_SECRET` is unset — fail-closed); extracts `staffId` from the `sub` claim (Laravel JWTAuth encodes it as a string). Looks up `company_id` from the `users` table by `staffId` (server-resolved, never client-supplied); disconnects if the user isn't found. On success: stores `{staffId, companyId}` on `client.data`, registers the socket in `staffSockets`, upserts a `staff_availability` row (`is_online=1, status='online'`), and emits `staff_online_ack` `{ok: true}` back to the client.
- **Disconnect (`handleDisconnect`)** — if the socket had completed authentication and is still the registered socket for that staffId, removes it from `staffSockets` and updates `staff_availability` to `is_online=0, status='offline'`.
- **`staff_offline` (client→server, `@SubscribeMessage('staff_offline')`, handler `handleStaffOffline`)** — explicit "going offline" signal; acts only on the staffId resolved at connection time (ignores any client-supplied id), removes from `staffSockets`, updates `staff_availability` to offline.
- **`emitToStaff(staffId, event, data)` (public method, not a socket event)** — called by `InternalController` to push a named event + payload to one staff member's socket, if currently connected. Returns `true`/`false` for delivered/offline.
- Server-emitted events: `staff_online_ack` (on successful auth), and whatever arbitrary `event` name `InternalController.emitNotification` forwards via `emitToStaff` (payload shape is caller-defined, e.g. new-lead or AI-handoff notifications).

#### `src/modules/staff-notify/internal.controller.ts`
`@Controller('api/internal')` — internal (Laravel-to-Node) API, protected by a shared `INTERNAL_API_KEY` secret (not the normal API-key guard system).

| Method | Path | Handler | Description | Guard |
|---|---|---|---|---|
| POST | `/api/internal/staff-online` | `staffOnline` | Called by Laravel when a staff member comes online via the app (not via this gateway's socket). Upserts `staff_availability` to online for `{staff_id, company_id}`. | `x-internal-key` header must equal `process.env.INTERNAL_API_KEY` (fails closed if unset — `UnauthorizedException`) |
| POST | `/api/internal/emit-notification` | `emitNotification` | Called by Laravel jobs to push a real-time notification `{type, staff_id, data}` to a connected staff socket via `gateway.emitToStaff`. Returns `{ok, delivered}`. | same internal-key check |

`checkAuth(key)` (private) — compares the `x-internal-key` header against `process.env.INTERNAL_API_KEY`; throws `UnauthorizedException` if unset or mismatched. Comment notes this used to silently no-op (open endpoints) when the env var was unset; env validation now refuses to boot without it, but the check stays defensive here too.

#### `src/modules/staff-notify/staff-notify.module.ts`
Imports: `WaChatModule` (for `MysqlService`). Providers: `StaffNotifyGateway`. Controllers: `InternalController`. Exports: `StaffNotifyGateway`.

---

## 8. Modules — Automation, Integration & Ops

This section documents thirteen `src/modules/**` subsystems: `automation`, `integration`, `plugins`, `mcp`, `queue`, `search`, `settings`, `metrics`, `audit`, `health`, `infra`, `docker`, and `stats`. All paths are relative to `backend-node/`.

---

### automation

The automation module implements per-session **autoreply rules**: operator-defined, single-message rules that are evaluated on every inbound message and, on a match, send a canned reply back into the same chat through the ordinary send path. It is intentionally decoupled from the module graph that drives it (SessionModule imports AutomationModule, so AutomationModule cannot import back into SessionModule/MessageModule) — the reply path is resolved lazily via `ModuleRef` to avoid a DI cycle.

##### `src/modules/automation/entities/automation-rule.entity.ts`
Purpose: TypeORM entity for the `automation_rules` table — one autoreply rule per row.
Shape: `id` (uuid), `sessionId` (varchar, indexed, FK to `Session` with `onDelete: CASCADE`), `name` (varchar 100), `enabled` (boolean, default true), `conditions` (JSON, nullable — reuses the webhook filter shape for the `message` family; null/empty matches every inbound message), `replyText` (text), `cooldownSeconds` (int, default 60 — per-(rule,chat) quiet period after a reply, which bounds an autoreply-vs-autoreply loop), `createdAt`, `updatedAt`.

##### `src/modules/automation/dto/automation-rule.dto.ts`
Purpose: Request/response DTOs for the automation-rule CRUD routes.
- `AUTOMATION_COOLDOWN_MAX_SECONDS` — exported constant, 86 400 (1 day), the max allowed `cooldownSeconds`.
- `CreateAutomationRuleDto` — `name` (string, ≤100), `replyText` (string, ≤`MESSAGE_TEXT_MAX_LENGTH`), `conditions?` (validated via `@IsValidWebhookFilters()`), `cooldownSeconds?` (int 0–86400, default 60), `enabled?` (boolean, default true).
- `UpdateAutomationRuleDto` — same fields, all optional (partial update).
- `AuditLogResponseDto`-style: `AutomationRuleResponseDto` — `id`, `sessionId`, `name`, `enabled`, `conditions`, `replyText`, `cooldownSeconds`, `createdAt`, `updatedAt`.
  - `static fromEntity(rule): AutomationRuleResponseDto` — maps an entity to the response DTO via `plainToInstance` with `excludeExtraneousValues`.

##### `src/modules/automation/automation-rules.service.ts`
Purpose: CRUD for automation rules plus the inbound-message evaluator that fires replies.
Constants: `COOLDOWN_SWEEP_THRESHOLD = 10_000` (triggers an expired-cooldown sweep before inserting a new cooldown entry); `MAX_MESSAGE_AGE_SECONDS = 300` (messages older than this never get an automated answer — guards against bursty replies to an offline-queue replay on reconnect).
Exported class `AutomationRulesService`:
- `create(sessionId, dto)` — enforces a per-session rule cap (`automation.maxPerSession`, default 32, soft/racy bound) then inserts the rule.
- `findAll(sessionId)` — rules ordered by `createdAt ASC, id ASC` (evaluation order; id is the tiebreak because SQLite `createdAt` has 1-second precision).
- `findOne(sessionId, id)` — throws `NotFoundException` if missing.
- `update(sessionId, id, dto)` — partial field update + save.
- `remove(sessionId, id)` — deletes the rule.
- `evaluateInbound(sessionId, message)` — called fire-and-forget from the message projector on every inbound message. Guards: ignores `fromMe === true`, requires a `chatId`, drops messages older than `MAX_MESSAGE_AGE_SECONDS`. Loads enabled rules in evaluation order, resolves lid→phone via `LidMappingStoreService` for filter matching, finds the first rule whose `conditions` match via the shared `evaluateFilters` (webhook filter evaluator), checks/enters cooldown (entered **before** the send to collapse a burst of matches into one reply), then sends via the lazily-resolved `PluginMessagePort` (`MessageService.sendText` bound at the core-plugin layer). All failures are swallowed/logged — this path must never break inbound message receipt.
- Private: `resolveMessagePort()` (lazy `ModuleRef.get` of `PLUGIN_MESSAGE_PORT`), `inCooldown`/`enterCooldown` (in-memory `Map<"ruleId:chatId", untilEpochMs>`, per-process).

##### `src/modules/automation/automation-rule.controller.ts`
Controller prefix: `sessions/:sessionId/automation-rules`. All routes require `@RequireRole(ApiKeyRole.OPERATOR)`.

| Method | Path | Handler | Description |
|---|---|---|---|
| POST | `/sessions/:sessionId/automation-rules` | `create` | Create an autoreply rule for the session. 201 on success; 400 on invalid rule. |
| GET | `/sessions/:sessionId/automation-rules` | `findAll` | List the session's rules in evaluation order. |
| GET | `/sessions/:sessionId/automation-rules/:ruleId` | `findOne` | Get one rule; 404 if not found. |
| PUT | `/sessions/:sessionId/automation-rules/:ruleId` | `update` | Update a rule; 404 if not found. |
| DELETE | `/sessions/:sessionId/automation-rules/:ruleId` | `remove` | Delete a rule; 204 No Content; 404 if not found. |

##### `src/modules/automation/automation.module.ts`
`AutomationModule` — imports `TypeOrmModule.forFeature([AutomationRule], 'data')`; declares `AutomationRuleController`; provides/exports `AutomationRulesService`. Deliberately imports no feature module (see service doc above) — the message-send dependency is resolved lazily via `ModuleRef` to avoid a DI cycle with `SessionModule`.

---

### integration

The "Integration Fabric" module implements the inbound (ingress) side of third-party plugin integrations: a public, per-plugin-instance HTTP ingress endpoint that providers (Chatwoot, Meta, etc.) POST webhook deliveries to, plus the provisioning API for integration instances (secrets, session scope, config), redrive of dead-lettered deliveries, conversation-mapping (bot/human handover) tracking, and retention/reconciliation background jobs. It is the mirror image of the outbound `webhook` module.

##### `src/modules/integration/integration.constants.ts`
Purpose: single constant, `INGRESS_DISPATCH_TIMEOUT_MS = 5000` (mirrors `SANDBOX_HOOK_TIMEOUT_MS`).

##### `src/modules/integration/ingress-url.ts`
Purpose: builds the ingress URLs shown to operators for a provisioned instance.
- `IngressUrl` — DTO class `{ route, url }`.
- `buildIngressUrls(baseUrl, pluginId, instanceId, routes): IngressUrl[]` — absolute URL when `BASE_URL` is set (trailing slash trimmed), else a relative path; never throws.

##### `src/modules/integration/ingress-ack.ts`
Purpose: renders the host-side synchronous ack for a route's `response.ack` spec.
- `AckRenderCtx` / `AckResult` types.
- `renderAck(spec, ctx): AckResult` — default `{status:202, body:'accepted'}` when no spec; otherwise applies `spec.status`/`spec.body`/`spec.headers`. `{rawBody}`/`{timestamp}`/`{id}` substitution done via `split/join` (never `String.replace` with a pattern, to avoid `$`-interpretation of provider-controlled bytes). Total/never-throws.

##### `src/modules/integration/ingress-preflight.ts`
Purpose: host-side preflight checks declared in a route's manifest (currently only `session-alive`), run after signature verification and before the dedup persist.
- `evaluatePreflight(route, sessionScope, sessionStatus): PreflightRejection | null` — returns `{status, body}` to reject (e.g. 503 "session not ready") or `null` to pass. Skips the check for wildcard/null scope or when `sessionStatus` is unwired (pure unit tests).

##### `src/modules/integration/ingress-signature.ts`
Purpose: verifies inbound provider signatures for every supported scheme.
- `resolveIngressTimestampToleranceSec(env)` — default 300s replay window, env-overridable (`INGRESS_TIMESTAMP_TOLERANCE_SEC`).
- `verifyIngressSignature(spec, input): {ok, reason?}` — dispatches on `spec.scheme`: `'none'` always passes; `'standard-webhooks'` delegates to the Standard Webhooks verifier (`webhook-id`/`webhook-timestamp`/`webhook-signature` headers, `v1,` candidate list, base64 HMAC-SHA256 over `${id}.${ts}.${rawBody}`); `'shared-secret'` constant-time string compare; `'hmac-sha256'` substitutes `{rawBody}`/`{timestamp}`/`{id}` into `contentTemplate` (function-replacer, not string-replace, to avoid `$`-interpretation of attacker-controlled rawBody) and HMACs with the instance secret.
- `safeEqualStr(a, b)` — constant-time compare, delegates to `common/security/constantTimeEqual`.

##### `src/modules/integration/ingress.service.ts`
Purpose: the pure, DI-free **fast-ack ingress pipeline** — the core logic behind `POST /ingress/:pluginId/:instanceId/*path`. Pluggable via an `IngressDeps` interface so it is unit-testable without Nest.
Exported class `IngressService`:
- `handle(req: IngressRequest): Promise<{status, body?, headers?}>` — pipeline: resolve instance (404 if unknown/disabled) → resolve manifest route (404 if unknown) → GET challenge handshake (constant-time verifyToken compare, 200/403) → body-size cap (declared `maxBodyBytes`, falling back to the process-wide body limit with a one-time warning per route; 413 on overflow) → signature verify (401 on failure) → host-side preflight (`session-alive`, logged on rejection) → dedup via `events.recordOrSkip` keyed on `(pluginId, instanceId, providerDeliveryId)` (200 "duplicate" if already seen) → derive `providerConversationId` → enqueue (`enqueue(data, jobId)`, awaited for a plain route, fire-and-forget for a `response`-declared sync-ack route) → return the rendered ack (202 by default).
- `extractConversationId(spec, headers, rawBody)` — exported helper; extracts a conversation key from a declared header or JSON-pointer into the body; total, never throws.
- `redactSensitiveHeaders(headers)` — exported helper; redacts `authorization`, `proxy-authorization`, `cookie`, and the provider signature headers before persisting the event payload (names survive, values don't).
- `deriveDeliveryId(req)` (private) — deterministic sha256 of `pluginId+instanceId+route+rawBody` used when the provider sends no dedup header, so retries still dedup.

##### `src/modules/integration/ingress-enqueue.service.ts`
Purpose: the shared queue-or-inline enqueue path for inbound ingress jobs, reused by the live ingress path and by `RedriveService`.
- `EnqueueOutcome` type: `{outcome: 'queued'|'dispatched'|'failed', error?}`.
- `resolveIngressJobOptions()` — BullMQ retry policy: `attempts` (default 3, env `INGRESS_MAX_ATTEMPTS`), exponential `backoff.delay` (default 5000ms, env `INGRESS_RETRY_DELAY_MS`).
- `sanitizeIngressJobId(jobId, namespace)` — maps BullMQ-refused jobId shapes (pure integer strings, bad colon counts, `'0'`/`'0:'`-prefixed) to a deterministic sha256-prefixed id namespaced by `pluginId\0instanceId`, so BullMQ's jobId-level dedup doesn't collide across unrelated instances sharing a provider's numeric id scheme.
- `buildIngressDeadLetterRow(data, error?)` — builds an `IntegrationDeliveryFailure` partial row for an inline-dispatch failure (mirrors the processor's final-attempt DLQ row shape; `attempts: 1`).
- Class `IngressEnqueueService implements OnApplicationBootstrap`:
  - `onApplicationBootstrap()` — fails boot if `QUEUE_ENABLED=true` but the ingress BullMQ queue did not resolve (so a broken wiring crashes loudly instead of silently running everything inline).
  - `enqueue(data, jobId): Promise<EnqueueOutcome>` — if `queue.enabled` and the queue resolved, `queue.add('ingress', data, {jobId: sanitized, ...retryOptions})` → `'queued'`; on a `queue.add` throw (Redis unreachable), falls through to inline dispatch. Otherwise dispatches inline via `PluginLoaderService.dispatchWebhookForInstance` → `'dispatched'` or `'failed'` (error swallowed and returned, never thrown — callers decide DLQ follow-up).

##### `src/modules/integration/ingress-event.service.ts`
Purpose: persistence of the inbound dedup/event log (`ingress_events` table) — the "persist-before-ack" durability handle.
Exported class `IngressEventService`:
- `recordOrSkip(input): Promise<boolean>` — inserts a new row stamped `dispatchState: 'pending'`; returns `true` if newly recorded, `false` on a unique-constraint violation (duplicate delivery).
- `markDispatchOutcome(key, outcome)` — on `'failed'`, increments `dispatchAttempts` and bumps `lastDispatchAt` (payload kept so the reconciler can replay); on `'queued'/'dispatched'`, sets `dispatchState: 'dispatched'` and **retires the payload to NULL** (the dispatch tier now owns the data).

##### `src/modules/integration/ingress-reconciler.service.ts`
Purpose: background sweeper that closes the "silent loss" window between persist and dispatch — replays stranded `'pending'` rows.
- `resolveIngressReconcilerOptions(env)` — `intervalMs` (default 60000, 0 disables), `graceMs` (default 60000 — live path gets this long to record its own outcome), `batchSize` (default 50), `maxAttempts` (default 5, after which a row is dead-lettered).
- Class `IngressReconcilerService implements OnModuleInit, OnModuleDestroy`:
  - `onModuleInit()` — starts an unref'd `setInterval` sweep (skipped entirely if `intervalMs <= 0`).
  - `sweep(opts, now?)` — one bounded, overlap-guarded pass: finds stale `'pending'` rows (`createdAt < cutoff`, still in cooldown rows skipped), re-resolves instance eligibility (skips disabled/deleted instances), and calls `reconcileRow` for each eligible row.
  - `reconcileRow(row, maxAttempts, now)` (private) — replays via `IngressEnqueueService.enqueue` keyed by the **original** deliveryId (idempotent against an already-enqueued job); on non-`'failed'` outcome, retires the row's payload and marks any matching unredrivendead-letter row as redriven; on `'failed'`, increments attempts and, once `maxAttempts` is exhausted, writes/ensures a DLQ row and marks the event `'failed'` (terminal).
  - `jobDataFor(row)` (private) — rebuilds the dispatch job from the persisted row, re-deriving `providerConversationId` from the **current** manifest route.

##### `src/modules/integration/integration-retention.service.ts`
Purpose: bounds growth of `ingress_events` and `integration_delivery_failures` via a daily prune.
Class `IntegrationRetentionService implements OnModuleInit, OnModuleDestroy`:
- `onModuleInit()` — runs once at startup then daily (unref'd `setInterval`). Two independent windows: `INGRESS_DEDUP_RETENTION_DAYS` (default 7; a non-positive value is clamped back to the default with a warning — dedup pruning can never be disabled) and `INGRESS_RETENTION_DAYS` (default 90; `<=0` disables **only** the failure-row prune).
- `pruneOlderThan(eventsDays, failuresDays?)` — the actual `DELETE ... WHERE createdAt < cutoff` on both tables, returns counts removed.

##### `src/modules/integration/plugin-instance.service.ts`
Purpose: CRUD + secret lifecycle for `plugin_instances` rows (one configured adapter instance, e.g. one Chatwoot account). Implements `PluginInstancePort` (the core-plugin capability port).
- `normalizeSecret(supplied?)` (module fn) — auto-generates a 32-byte hex secret if absent; rejects a supplied secret shorter than 16 chars.
- `InstanceExistsError` — thrown by `create()` on a duplicate `(pluginId, instanceId)`.
- Class `PluginInstanceService`:
  - `mint(pluginId, instanceId, opts)` — idempotent create-or-return (used by non-HTTP callers).
  - `resolve(pluginId, instanceId)` — lookup by composite id `${pluginId}:${instanceId}`.
  - `maskedView(instance, schema?)` — returns a copy with `secret` replaced by `SECRET_SENTINEL` and `config` recursively redacted per the plugin's `configSchema` (delegates to `redactSecretConfig`).
  - `create(pluginId, instanceId, opts)` — throws `InstanceExistsError` on conflict.
  - `list(pluginId)` / `listAll()` — list instances (optionally across all plugins, used by boot-time scope-binding reconciliation).
  - `regenerateSecret(pluginId, instanceId)` — mints a new random secret.
  - `setEnabled(pluginId, instanceId, enabled)`.
  - `update(pluginId, instanceId, patch, schema?)` — restores masked-sentinel config fields from the stored value via `restoreSecretConfig` before persisting.
  - `remove(pluginId, instanceId)`.

##### `src/modules/integration/scope-binding.service.ts`
Purpose: the provisioning bridge that makes a persisted `plugin_instances` row's config and session scope reach the live plugin runtime (`PluginLoaderService`'s `activeSessions`/`sessionConfig`), so the ingress dispatcher can resolve `ctx.config` for a given instance.
Class `ScopeBindingService implements OnApplicationBootstrap`:
- `onApplicationBootstrap()` — re-derives every **enabled** instance's runtime binding from the persisted rows at boot (restores a binding that may have been lost at provisioning time, e.g. because the plugin was momentarily unloaded). Rows are sorted concrete-scope-first, then wildcard/null, so the wildcard's `['*']` is always the last write (deterministic regardless of DB row order). Calls `warnIfScopeHasNoSession` per restored row (diagnostic only).
- `applyScopeBinding(pluginId, scope, config, activate, opts?)` — the core bind/unbind logic: for a null/`'*'` scope, activates/deactivates the plugin's base config + `['*']` in `activeSessions` (retiring `'*'` only when no other enabled wildcard instance remains bound); for a concrete scope, sets `setPluginSessionConfig`/`setPluginSessions`, carefully preserving state a still-enabled sibling instance depends on in both directions. `opts.additive` (used only by the boot reconciler) means "only add, never remove" so it never undoes an operator's explicit `PUT /plugins/:id/sessions`. Best-effort: swallows failures as a WARN audit log entry rather than failing provisioning.

##### `src/modules/integration/instance-throttler.guard.ts`
Purpose: per-`(pluginId, instanceId)` rate limiting for the public ingress route, so one noisy tenant sharing a provider's egress IP with other tenants doesn't starve them at the global per-IP throttler.
Class `InstanceThrottlerGuard extends ProxyAwareThrottlerGuard`:
- `onModuleInit()` — replaces `this.throttlers` with two **self-contained** tiers (bypassing the shared `@Throttle` tier-name mechanism, which would otherwise retarget the global IP guard too): `instance` (keyed `ingress:<pluginId>:<instanceId>`, default 120/60s, env `INGRESS_INSTANCE_LIMIT`/`INGRESS_INSTANCE_TTL`) and `ingress-ip` (keyed on client IP, default 1200/60s, env `INGRESS_IP_LIMIT` — the only bound an unauthenticated `@Public` caller cannot route around by varying the path).
- `shouldSkip()` — always returns `false`; this guard deliberately ignores a bare `@SkipThrottle()` (the controller carries one only to exempt the *global* per-IP guard).
- `getTracker(req)` — keys on `(pluginId, instanceId)` route params; falls back to the inherited IP tracker if params are absent.

##### `src/modules/integration/conversation-mapping.service.ts`
Purpose: maps a WhatsApp chat ↔ a provider conversation id (both directions) and tracks bot/human handover state. Implements `PluginConversationMappingPort`.
- `ConversationMappingConflict` — thrown when a `providerConversationId` is already bound to a *different* chat for the same `(pluginId, instanceId)` (the reverse-unique key has no safe fallback).
- Class `ConversationMappingService`:
  - `upsert(key, providerConversationId, patch?)` — find-then-update, with a unique-violation race handled by re-reading the forward key (converge) or surfacing `ConversationMappingConflict` (genuine reverse-key collision).
  - `get(key)` — forward lookup.
  - `findHandoverForChat(sessionId, chatId)` — the most-recently-updated `'human'`/`'closed'` row for the chat, **ignoring** `pluginId` (a handover taken by one plugin governs every plugin on that chat).
  - `getByProvider(pluginId, instanceId, providerConversationId)` — reverse lookup.
  - `setHandover(id, state)`.
  - `delete(id)` / `rebindSession(id, sessionId)` — repair path for a mapping whose session was deleted and re-paired under a new id; on a forward-key collision, deletes the stale row instead (superseded by the fresher one).

##### `src/modules/integration/ordering-lock.ts`
Purpose: shared per-key async mutex used by both the ingress worker (per-conversation ordering) and `RedriveService` (per-instance serialization).
- `KeyedAsyncLock` — `run<T>(key, fn)` chains `fn` after the current tail promise for `key`, swallowing a prior rejection so one failure doesn't poison the chain; cleans up its map entry once settled.
- `orderingKeyFor(job: IngressJobData)` — `${instanceId}:${providerConversationId}` when a conversation id was extracted, else `instance:${instanceId}` (coarser per-instance serialization fallback).

##### `src/modules/integration/redrive.service.ts`
Purpose: replays dead-lettered (DLQ'd) inbound ingress deliveries on operator request.
Class `RedriveService`:
- `redriveInstance(pluginId, instanceId, sessionIdFilter)` — serialized per `(pluginId, instanceId)` via `KeyedAsyncLock`; delegates to `redriveBatch`.
- `redriveBatch` (private) — reads up to `REDRIVE_BATCH_SIZE = 100` un-redriven DLQ rows (ordered `attempts ASC, createdAt ASC` so a repeatedly-failing row doesn't livelock the batch), re-enqueues each via the shared `IngressEnqueueService.enqueue` with a freshly-minted `redrive:<rowId>` jobId, and on success marks both the matching `ingress_events` row (if `'pending'`) and the DLQ row as redriven. Returns `{redriven, remaining, batchSize}`.

##### `src/modules/integration/integration-instance.controller.ts`
Controller prefix: `integration/plugins/:pluginId/instances`, class-level `@RequireRole(ApiKeyRole.ADMIN)`. ADMIN-only provisioning surface for per-plugin integration instances.

| Method | Path | Handler | Description |
|---|---|---|---|
| POST | `/integration/plugins/:pluginId/instances` | `create` | Create an instance; requires the plugin to declare an ingress route + `webhook:ingress` permission. 201, reveals the plaintext secret/verifyToken once. 409 if the instance id already exists. |
| GET | `/integration/plugins/:pluginId/instances` | `list` | List instances for the plugin, filtered to the calling key's `allowedSessions`, secrets masked. |
| GET | `/integration/plugins/:pluginId/instances/:instanceId` | `getOne` | Get one instance (secret masked); 404 if out of scope or missing. |
| POST | `/integration/plugins/:pluginId/instances/:instanceId/regenerate-secret` | `regenerate` | Mint a new secret; reveals it once. |
| PATCH | `/integration/plugins/:pluginId/instances/:instanceId` | `patch` | Update `enabled`/`sessionScope`/`config`; re-applies scope binding, tearing down the old scope first if it changed. |
| DELETE | `/integration/plugins/:pluginId/instances/:instanceId` | `remove` | Delete the instance and tear down its scope binding. 204. |

All routes audit via `AuditService` (`INTEGRATION_INSTANCE_CREATED/UPDATED/SECRET_REGENERATED/DELETED`). A session-scoped API key may only act on instances bound within its `allowedSessions` fence (enforced via `sessionScopeVisible`); out-of-scope resolves 404, not 403, to avoid leaking existence.

##### `src/modules/integration/redrive.controller.ts`
Controller prefix: `integration/instances`, class-level `@RequireRole(ApiKeyRole.ADMIN)`.

| Method | Path | Handler | Description |
|---|---|---|---|
| POST | `/integration/instances/:pluginId/:instanceId/redrive` | `redriveInstance` | Re-dispatch one bounded batch of DLQ'd inbound deliveries for the instance. A scoped key is authorized against — and filtered by — the instance's *current* `sessionScope` (prevents replaying another tenant's rows after a rebind). Audited (`INTEGRATION_INSTANCE_REDRIVEN`). |

##### `src/modules/integration/ingress.controller.ts`
Controller prefix: `ingress`. Class-level `@Public()` (bypasses the global `ApiKeyGuard` — providers can't present an API key) and `@SkipThrottle()` (exempts the *global* per-IP throttle; `InstanceThrottlerGuard` on the route carries the real bounds). Request body is read raw from `req.rawBody` (stashed by main.ts's JSON verify callback) — never DTO-bound, so the global `ValidationPipe` never rejects a provider's unknown keys and the exact signed bytes reach the HMAC verifier.

| Method | Path | Handler | Description |
|---|---|---|---|
| ALL (GET/POST/etc.) | `/ingress/:pluginId/:instanceId/*path` | `receive` | The single ingress entry point. Delegates entirely to `IngressService.handle`. Guarded by `@UseGuards(InstanceThrottlerGuard)` for the per-instance + per-IP rate bounds. Response type forced to `text/plain` (never `text/html`) because the body can echo provider-controlled strings (`hub.challenge`), which would otherwise be an XSS vector if a browser parsed it as HTML. |

Response codes (documented via `@ApiResponse`): 200 (GET challenge echo / duplicate), 202 (primary success — queued/dispatched), 401 (signature failure), 403 (GET challenge failed), 404 (unknown instance/route), 413 (body too large), 429 (rate-limited, with `Retry-After-instance`/`Retry-After-ingress-ip` header naming which bucket fired).

##### `src/modules/integration/ingress.service.ts` — see above (business logic section).

##### `src/modules/integration/integration.module.ts`
`IntegrationModule` — imports `TypeOrmModule.forFeature([PluginInstance, IngressEvent, IntegrationDeliveryFailure, Session], 'data')` plus `QueueModule` **only** when `process.env.QUEUE_ENABLED === 'true'` (avoids a Redis connection attempt when queueing is off). Declares controllers `IngressController`, `RedriveController`, `IntegrationInstanceController`. Providers: `PluginInstanceService`, `IngressEventService`, `IngressEnqueueService`, `IngressReconcilerService`, `RedriveService`, `ScopeBindingService`, `IntegrationRetentionService`; aliases `PLUGIN_INSTANCE_PORT → PluginInstanceService`; and a factory-built `IngressService` whose `IngressDeps` are wired here (instance resolution, manifest route lookup, event dedup, the O(1) in-memory `sessionStatus` probe via `EngineRegistry`, structured preflight-rejection logging, and the `enqueue` closure that records dispatch outcome + writes a DLQ row on inline failure). Exports `PluginInstanceService`, `IngressEventService`.

##### `src/modules/integration/entities/conversation-mapping.entity.ts`
Shape: `conversation_mappings` table — `id` (uuid), `sessionId`, `chatId`, `pluginId`, `instanceId`, `providerConversationId`, `handoverState` (`'bot'|'human'|'closed'`, default `'bot'`), `metadata` (JSON, nullable), `updatedAt`. Two unique indexes: forward `(sessionId, chatId, pluginId, instanceId)` and reverse `(pluginId, instanceId, providerConversationId)`.

##### `src/modules/integration/entities/ingress-event.entity.ts`
Shape: `ingress_events` table — host-minted `id` (`@PrimaryColumn`, not auto-generated), `instanceId`, `pluginId`, `providerDeliveryId`, `route`, `payload` (JSON, nullable — retired to NULL once a dispatch outcome is recorded), `payloadHash` (sha256 hex, survives payload retirement), `sessionId` (nullable), `dispatchState` (`'pending'|'dispatched'|'failed'|null` — NULL means "not watched", used for backward-compat with pre-column rows), `dispatchAttempts` (int, default 0), `lastDispatchAt` (nullable), `createdAt`. Unique index on `(pluginId, instanceId, providerDeliveryId)` (the dedup oracle); indexes on `createdAt` and `(dispatchState, createdAt)`.

##### `src/modules/integration/entities/integration-delivery-failure.entity.ts`
Shape: `integration_delivery_failures` table (DLQ for both inbound/ingress and outbound/provider-egress) — `id`, `direction` (`'inbound'|'outbound'`), `pluginId`, `instanceId`, `sessionId` (nullable, provenance only), `deliveryId` (nullable), `attempts`, `lastError`, `payload` (JSON, nullable), `redriven` (boolean, default false), `createdAt`. Index on `(pluginId, instanceId)`.

##### `src/modules/integration/entities/plugin-instance.entity.ts`
Shape: `plugin_instances` table — `id` (`${pluginId}:${instanceId}`), `pluginId`, `instanceId`, `sessionScope` (nullable — null means inherit manifest sessions), `secret` (host-minted ingress HMAC secret, plaintext at rest, masked on API reads), `verifyToken` (nullable), `config` (JSON, nullable, **not** secret-redacted at rest — redaction happens at the API boundary), `enabled` (default true), `createdAt`, `updatedAt`. Unique index on `(pluginId, instanceId)`.

##### `src/modules/integration/__fixtures__/`
Test fixture data only (`chatwoot-message_created.json`) — not documented further per assignment scope.

---

### plugins

This is the Plugins **API** module (`PluginsApiModule`) — the HTTP-facing controller/service for plugin lifecycle management (install, enable/disable, config, catalog, update, uninstall). It is distinct from `src/core/plugins`, which owns the actual plugin loader/runtime/sandbox (covered elsewhere); this module is a thin HTTP layer over `PluginLoaderService`.

##### `src/modules/plugins/catalog.ts`
Purpose: shape and pure annotation logic for the remote plugin catalog (a `plugins.json` manifest list fetched from an operator-configured URL).
- `CatalogEntry` — one published catalog entry (id, name, version, description, download URL, etc.; extra fields tolerated).
- `CatalogPlugin extends CatalogEntry` — adds `installed`, `installedVersion`, `updateAvailable`.
- `compareSemver(a, b)` — simple `MAJOR.MINOR.PATCH` comparator (pre-release suffix ignored).
- `annotateCatalog(entries, installed)` — pure function, annotates each catalog entry with this instance's install state; `updateAvailable` true iff installed and the catalog version is strictly newer.

##### `src/modules/plugins/plugin-download.ts`
Purpose: SSRF-guarded download + integrity verification for plugin packages fetched from a URL (install-from-url / update-from-url).
- `expectedSha256FromUrl(url)` — reads an optional `#sha256=<64 hex>` URL **fragment** (never sent to the server, so it can't collide with a download host's own query params) as a content-integrity pin; throws if present-but-malformed (fail closed, not silently unpinned).
- `assertDownloadSha256(url, body)` — no-op if unpinned; otherwise throws on a digest mismatch.
- `assertPluginInstallUrl(url)` — transport gate enforced **before** any fetch: `https://` accepted as-is; plain `http://` only accepted with a content pin; and in production (or `PLUGIN_INSTALL_REQUIRE_PIN=true`), an integrity pin is **required** regardless of scheme (installing a plugin is executing third-party code — HTTPS only authenticates the channel, not the reviewed bytes).
- `fetchSafeBuffer(url, opts)` — streams the download through `withSafeFetch` (the shared SSRF guard, redirects followed with each hop re-validated), enforcing a byte cap (`opts.maxBytes`, default 5 MiB) both from `Content-Length` and while streaming (so an absent/wrong header can't bypass the cap).

##### `src/modules/plugins/plugin-installer.ts`
Purpose: parses and validates an uploaded/downloaded plugin `.zip` package without touching the filesystem — the single validation funnel shared by upload-install and URL-install.
Constants: re-exports `RESERVED_PLUGIN_IDS`, `INSTALLABLE_TYPES` from `core/plugins`. `DEFAULT_PACKAGE_LIMITS = {maxEntries: 200, maxTotalBytes: 20MiB}`.
- `readEntryData(entry, maxBytes)` (private) — decompresses one zip entry with a hard output-byte cap; specially handles an entry that lies about being empty (`header.size===0` but has compressed bytes), which `adm-zip` would otherwise inflate with no cap (memory-exhaustion vector).
- `parsePluginPackage(buffer, limits?): ParsedPackage` — locates the package root (shallowest `manifest.json`, supporting both flat and single-folder zips), parses + validates the manifest via the shared `validatePluginManifest` (same validation the boot-time loader runs — mapped to a clean `BadRequestException` here), enforces the size cap off declared zip headers **before** decompressing (zip-bomb guard), zip-slip-safely resolves every entry path (rejects absolute/`..` paths), enforces a running actual-decompressed-bytes cap (catches a "many lying size=0 entries" bypass of the header-based cap), and confirms the manifest's declared `main` file is present among the entries.

##### `src/modules/plugins/redact-config.ts`
Purpose: schema-driven, depth-aware secret redaction/restoration for plugin config objects — shared by `PluginsService` and `PluginInstanceService`.
- `SECRET_SENTINEL = '***'`.
- `redactSecretConfig(config, schema?)` — masks every `secret: true`-flagged field (recursively, including array-of-object rows) to the sentinel. **Fails closed** when no schema is available: masks every meaningful value rather than risk leaking a credential.
- `restoreSecretConfig(incoming, existing, schema?)` — the write-side inverse: a sentinel/empty value for a secret field is treated as "keep the existing stored value" (or drop the key if nothing was stored); a genuinely new value is kept as submitted. For arrays, matches incoming rows to stored rows by their **non-secret-field signature** (not index), so reordering/appending doesn't mis-attribute a stored secret to the wrong row; falls back to positional matching only when unambiguous.

##### `src/modules/plugins/plugins.service.ts`
Purpose: the business logic behind every plugin-lifecycle route — install/update/uninstall are serialized per plugin id (promise-chain, mirrors `session.service.ts`) so two lifecycle ops on the same plugin can't interleave.
- `isIngressCapable(manifest)` — exported helper: true iff the manifest declares both an `ingress` route and the `webhook:ingress` permission.
Class `PluginsService`:
  - `findAll()` / `findOne(id)` — map loader-held `PluginRuntime` state to `PluginDto` (config/sessionConfig redacted via `redactSecretConfig`).
  - `enable(id)` / `disable(id)` — serialized; persist the operator's enable/disable **decision** (`setOperatorEnabled`) separately from whether the lifecycle call succeeded, so a plugin that failed to enable isn't retried forever on every boot, and a plugin whose *code went missing* can still be disabled/uninstalled by acting on its registry entry alone (no 404 just because nothing is loaded).
  - `updateSessions(id, sessions)` — full-replacement of `activeSessions`; reachable only via the `@RequireUnscopedKey()`-fenced controller route.
  - `updateConfig(id, config)` / `updateSessionConfig(id, sessionId, config)` — restore-then-apply pattern via `restoreSecretConfig` so a round-tripped sentinel never overwrites a stored secret.
  - `getConfigUiHtml(id)` — reads the plugin's sandboxed config-UI entry HTML for iframe `srcdoc` injection; path is lexically zip-slip-guarded **and** symlink-resolved (`fs.realpathSync`) and re-checked for containment before reading.
  - `install(file?)` — validates via `parsePluginPackage`, refuses a conflicting id (loaded or an un-registered leftover directory not owned by this gateway), writes entries, `loadPlugin`, and rolls back (deleting only the files this call wrote, preserving any pre-existing operator data) on any failure.
  - `installFromUrl(url)` — downloads via the SSRF-guarded `downloadPackage` (outside the per-id lock), peeks the manifest id, then serializes the actual `install()` call.
  - `downloadPackage(url)` (private) — the shared URL-source funnel: transport-rule check → SSRF-guarded fetch → sha256 pin verification.
  - `getCatalog()` — fetches + parses the configured remote `plugins.json` (capped at 1 MiB) and annotates it via `annotateCatalog`.
  - `updatePackage(id, buffer)` / `updatePackageInner` — crash-safe in-place update: stages the new tree to a sibling `staging` dir and fully validates it **before** stopping the running plugin; swap is two renames (`live→backup`, `staging→live`) so a crash mid-swap is recoverable at next boot via the loader's interrupted-update recovery; on any post-swap failure, restores from `backup` and reloads the previous version; preserves `ctx.storage` key files across the swap (copied from backup unless the new package explicitly supplies that path).
  - `updateFromUrl(id, url)` — downloads then `updatePackage`.
  - `uninstall(id)` / `uninstallInner` — serialized; tolerates a plugin whose code is missing (acts on the registry entry alone).
  - `healthCheck(id)` — delegates to `PluginLoaderService.checkPluginHealth` (reaches a sandboxed plugin's worker-side health check, unlike a stale `plugin.instance` check).

##### `src/modules/plugins/plugins.controller.ts`
Controller prefix: `plugins`. `MAX_PLUGIN_UPLOAD_BYTES = 5 MiB`. Every route except `updateSessionConfig` carries both `@RequireRole(ApiKeyRole.ADMIN)` and `@RequireUnscopedKey()` (plugin lifecycle is deployment-global, executes code as the process user — a session-scoped key must never reach it).

| Method | Path | Handler | Description |
|---|---|---|---|
| GET | `/plugins` | `findAll` | List all plugins. |
| POST | `/plugins/install` | `install` | Multipart-upload a plugin `.zip` (field `file`, ≤5 MiB). 201/400/409. |
| POST | `/plugins/install-url` | `installFromUrl` | Install a plugin by downloading its `.zip` from a URL (SSRF-guarded, optional sha256 pin). 201/400/409. |
| GET | `/plugins/catalog` | `catalog` | List the remote plugin catalog annotated with install state. (Declared before `:id` to avoid route capture.) |
| GET | `/plugins/:id` | `findOne` | Get one plugin by id. 404 if missing. |
| POST | `/plugins/:id/enable` | `enable` | Enable a plugin. |
| POST | `/plugins/:id/disable` | `disable` | Disable a plugin. |
| PUT | `/plugins/:id/config` | `updateConfig` | Update the plugin's base configuration. |
| GET | `/plugins/:id/config-ui` | `getConfigUi` | Serve the plugin's sandboxed config-UI HTML (`Content-Security-Policy: sandbox`, `X-Content-Type-Options: nosniff`) for iframe `srcdoc` injection. 404 if none. |
| PUT | `/plugins/:id/config/:sessionId` | `updateSessionConfig` | Set a per-session config override (empty body clears it). **Not** `@RequireUnscopedKey()` — fenced instead by the `:sessionId` route param via the standard guard. 400 if the plugin is global (not session-scoped). |
| PUT | `/plugins/:id/sessions` | `updateSessions` | Full-replacement of which sessions the plugin is activated for. 403 for a session-scoped key (full-set replacement could delete another tenant's activation). |
| POST | `/plugins/:id/update` | `update` | Update an installed plugin in place from a URL, preserving config/enabled state. 400 on id mismatch or built-in. |
| DELETE | `/plugins/:id` | `uninstall` | Uninstall a plugin (removes files; built-ins protected). 400/404. |
| GET | `/plugins/:id/health` | `healthCheck` | Run the plugin's health check. |

##### `src/modules/plugins/dto/plugin.dto.ts`
Shape summary: `PluginDto` (full plugin state: id/name/version/type/status/config/builtIn/provides/ingressCapable/sessionScoped/activeSessions/configSchema/configUi/i18n/sessionConfig/loadedAt/enabledAt/error). `PluginConfigDto` (`{config}`). `PluginSessionsDto` (`{sessions: string[]}`). `InstallFromUrlDto` (`{url}`, validated `@IsUrl` http/https absolute). `PluginActionResponseDto` (`{success, message}`). `PluginHealthResponseDto` (`{healthy, message?}`). `PluginCatalogEntryDto` (catalog entry fields + `installed`/`installedVersion`/`updateAvailable`).

##### `src/modules/plugins/dto/index.ts`
Re-exports `./plugin.dto`.

##### `src/modules/plugins/plugins.module.ts`
`PluginsApiModule` — declares `PluginsController`; provides/exports `PluginsService`. No imports (relies on `PluginLoaderService` being `@Global()` from `core/plugins`).

---

### mcp

Implements OpenWA's **Model Context Protocol (MCP) server** — a Streamable-HTTP MCP endpoint (default `POST /mcp`) that exposes the same tool registry used by the agent-tools core (`core/agent-tools`) to any MCP-speaking client, authenticated with the same API-key scheme as the REST API.

##### `src/modules/mcp/mcp-rate-limit.ts`
Purpose: rate-limit configuration + a per-key sliding-window limiter for the MCP mount (the global/REST throttler doesn't cover this raw-Express route, and collapses everyone behind one IP-keyed bucket anyway).
- `readRateLimitConfig(env?)` — per-key limits: `MCP_RATE_LIMIT_MAX` (default 60), `MCP_RATE_LIMIT_WINDOW_MS` (default 60000).
- `readIpRateLimitConfig(env?)` — pre-auth per-IP limits: `MCP_IP_RATE_LIMIT_MAX` (default 120), `MCP_IP_RATE_LIMIT_WINDOW_MS` (default 60000).
- `KeyRateLimiter` — in-memory sliding-window limiter (`check(key)` throws `429 HttpException` once a key's window is full); approximate-LRU-capped at `maxKeys` (default 50 000) so a distinct-key flood can't grow process memory unbounded; touches a key's LRU position even on a throttled check (so an active abuser can't drift to eviction and get a fresh budget).

##### `src/modules/mcp/tool-result.ts`
Purpose: formats MCP `CallToolResult` payloads and maps thrown errors to tool-error results without leaking server internals.
- `smartToolResult(data)` — inlines small payloads (<4 KB) as text; offloads larger ones to an embedded base64 `resource` so the response stays compact.
- `jsonToolResult(data, isError?)` — compact JSON text result.
- `handleToolError(error)` — `HttpException` → client-safe message from the exception response (mirrors REST error bodies); any other `Error`/unknown → a generic `"Internal error"` message (stack traces logged server-side only, never put on the wire).

##### `src/modules/mcp/mcp.server.ts`
Purpose: builds the MCP server and mounts it on the existing Express/Nest HTTP adapter.
- `McpRequestContext` type — `{ipAddress?, method?, path?}`, forwarded to the audit trail on an auth failure.
- `extractApiKey(extra)` — reads `X-Api-Key` or `Authorization: Bearer` from the MCP request headers.
- `auditMcpAuthFailure(auditService, error, reqContext)` — mirrors the REST `ApiKeyGuard`'s audit behavior: logs a WARN `API_KEY_AUTH_FAILED` only for `UnauthorizedException`/`ForbiddenException` (401/403 only, not every tool-input error) — without this, credential-probing against `/mcp` left no forensic record (the mount is raw Express, outside the Nest guard pipeline).
- `buildServer(registry, authService, rateLimiter, readOnly, serverInfo, auditService, reqContext)` — builds one `McpServer` instance, registering every tool from `ToolRegistryService.list({readOnly})` with `readOnlyHint`/`destructiveHint`/`idempotentHint` annotations; each tool handler extracts the API key, calls the shared `invokeTool` (auth + rate-limit + dispatch), and formats the result via `smartToolResult`/`jsonToolResult` per the tool's `resultDisposition`.
- `createIpThrottle(ipRateLimiter)` — pre-auth, per-IP Express middleware; returns a JSON-RPC `429` body directly (raw Express doesn't auto-convert a thrown `HttpException`).
- `resolveMcpReadOnly(optionsReadOnly?)` — **secure default**: read-only unless `MCP_READONLY=false` is explicitly set (an unset var previously defaulted to read-write, silently exposing state-mutating tools).
- `mountMcpServer(httpAdapter, registry, authService, rateLimiter, ipRateLimiter, options?, auditService?)` — mounts `POST {basePath}` (default `/mcp`) with `createIpThrottle` → a route-local `express.json()` (defensive fallback behind the process-wide capped parser) → the per-request handler, which mints a fresh `McpServer` + `StreamableHTTPServerTransport` (stateless, `sessionIdGenerator: undefined`) per request to sidestep the SDK's single-transport constraint under concurrency, tearing both down on `res.close`.

##### `src/modules/mcp/mcp.module.ts`
`McpModule implements NestModule` — a `DynamicModule`-style module configured via the static `forRoot(options)` (stores `basePath`/`serverInfo` in a module-level variable, read later by `configure()`, which runs after DI resolution). `configure(consumer)` builds the two `KeyRateLimiter`s and calls `mountMcpServer` directly against the resolved `HttpAdapterHost`. Wired conditionally by `AppModule` only when `MCP_ENABLED` (env flag) is on.

---

### queue

Wraps BullMQ for OpenWA's two background queues — `webhook-queue` (outbound webhook delivery) and `ingress-queue` (inbound plugin-ingress dispatch) — plus Bull Board admin UI mounting. Only wired into the app when `QUEUE_ENABLED=true`; without it, deliveries run inline instead (see `WebhookService`/`IngressEnqueueService` fallback paths).

##### `src/modules/queue/queue-names.ts`
Purpose: single source for queue name strings, extracted to avoid a circular import between the module and its processors. `QUEUE_NAMES = {WEBHOOK: 'webhook-queue', INGRESS: 'ingress-queue'}`.

##### `src/modules/queue/redis-connection.ts`
Purpose: Worker-specific Redis connection options and concurrency resolvers.
- `WorkerConnectionOptions` type.
- `workerConnectionOptions()` — host/port/username/password/connectTimeout from `REDIS_*` env vars. Deliberately **not** the same connection object as the shared BullMQ producer (`enableOfflineQueue: false`): a Worker must tolerate a brief Redis reconnect (BullMQ's own recommendation), so the Worker connection leaves the offline queue at ioredis's default `true`.
- `webhookWorkerConcurrency()` — `WEBHOOK_WORKER_CONCURRENCY` env, default 10 (BullMQ defaults a Worker to 1, which would head-of-line-block every session's webhooks behind one slow receiver).
- `ingressWorkerConcurrency()` — `INGRESS_WORKER_CONCURRENCY` env, default 10 (safe to raise because per-conversation ordering is now enforced by the in-processor `KeyedAsyncLock`, not by single-worker serialization).

##### `src/modules/queue/processors/webhook.processor.ts`
Purpose: the BullMQ `Worker` that actually delivers queued outbound webhook jobs.
Constant: `STALL_EXHAUSTION_MESSAGE` — the exact `failedReason` BullMQ 5.80.x sets when a job stalls twice (`maxStalledCount` default 1); such a job never reaches `process()`.
Class `WebhookProcessor extends WorkerHost`, decorated `@Processor(QUEUE_NAMES.WEBHOOK, {connection: workerConnectionOptions(), concurrency: webhookWorkerConcurrency()})`:
- `process(job)` — POSTs via `postWebhookPayload` (SSRF-guarded), honoring `webhook.timeout` (default 10000ms); on success, records `lastTriggeredAt` and fires the `webhook:delivered` hook; on failure, re-throws to trigger BullMQ retry/backoff.
- `postToReceiver` (private) — the actual HTTP POST + response-time measurement.
- `recordSuccessfulDelivery` (private) — post-delivery bookkeeping; never lets a bookkeeping failure cascade back into the failure path (would cause a false duplicate retry/DLQ).
- `recordDeliveryFailure` (private) — on the **final** attempt, fires `webhook:error`, persists a durable `webhook_delivery_failures` row via `recordWebhookDeliveryFailure`, and bumps the `openwa_webhook_delivery_failures_total` metric. Client-facing error is SSRF-redacted (`redactSsrfError`) before logging/hooking.
- `onWorkerFailed(job, error)` — `@OnWorkerEvent('failed')` handler; fires **only** for the stall-exhaustion sentinel (a job that died twice without ever calling `process()` otherwise has no failure-channel coverage at all — no DLQ row, no metric, no hook).

##### `src/modules/queue/processors/ingress.processor.ts`
Purpose: the BullMQ `Worker` that dispatches queued inbound ingress jobs to the owning plugin.
- `IngressJobData` interface — exported, the job payload shape (`pluginId`, `instanceId`, `route`, `method?`, `deliveryId`, `sessionId?`, `providerConversationId?`, `payload`).
Class `IngressProcessor extends WorkerHost`, decorated `@Processor(QUEUE_NAMES.INGRESS, {connection: workerConnectionOptions(), concurrency: ingressWorkerConcurrency()})`:
- `process(job)` — wraps `PluginLoaderService.dispatchWebhookForInstance(d)` in a per-conversation `KeyedAsyncLock.run(orderingKeyFor(d), ...)` (mutual exclusion + in-order start per conversation; raised worker concurrency then parallelizes *unrelated* conversations rather than serializing everything). On failure, logs, and on the **final** BullMQ attempt fires the `ingress:error` hook and persists a dead-letter row to `integration_delivery_failures` (full payload retained for redrive). Always re-throws to let BullMQ apply backoff/retry.

##### `src/modules/queue/queue.module.ts`
`QueueModule` — `WEBHOOK_QUEUE_JOB_OPTIONS` (exported constant: bounded `removeOnComplete`/`removeOnFail` retention, since a failed job's durable record is the `webhook_delivery_failures` row, not the Redis job). Imports: `TypeOrmModule.forFeature([Webhook, WebhookDeliveryFailure, IntegrationDeliveryFailure], 'data')`, `HooksModule`, `PluginsModule` (core), `BullModule.forRootAsync` (shared producer connection, `enableOfflineQueue: false` so `queue.add()` fails fast and callers fall back to inline dispatch), `BullModule.registerQueue` for both `webhook-queue` and `ingress-queue`, and `BullBoardModule` (mounts the admin dashboard at `/admin/queues` with one feature panel per queue). Providers: `WebhookProcessor`, `IngressProcessor`. Exports `BullModule`.

---

### search

Implements OpenWA's pluggable full-text message search: a provider-registry pattern with one built-in, DB-native FTS provider (SQLite FTS5 / Postgres `tsvector`) and a hook for plugin-backed providers (e.g. Meilisearch/Elasticsearch) running inside the plugin sandbox. Wired only when `SEARCH_ENABLED !== 'false'`.

##### `src/modules/search/search.types.ts`
Purpose: the provider contract and query/result shapes.
- `SearchProvider` interface — `id`, `label`, `search(query)`, `health()`.
- `SearchHealth`, `SearchQuery` (q, sessionIds? [host-injected scope, never user-supplied], sessionId?, chatId?, direction?, type?, from?, dateFrom?/dateTo? [epoch ms], limit?, offset?), `SearchResults` (`hits`, `total`, `tookMs`, `provider`), `SearchHit` (messageId, waMessageId, sessionId, chatId, body, snippet [`<mark>`-delimited, safe only as text — never `dangerouslySetInnerHTML`], timestamp, type, direction, from, score?).

##### `src/modules/search/search.constants.ts`
Purpose: host-side pagination bounds applied **before** any provider sees the query (so a plugin-backed provider can't be coaxed into returning an unbounded result set).
- `SEARCH_LIMIT_MAX` — env `SEARCH_LIMIT_MAX`, default 100.
- `SEARCH_OFFSET_MAX` — fixed 100 000 (not env-driven).
- `SEARCH_DEFAULT_LIMIT` — 50.

##### `src/modules/search/search-provider.registry.ts`
Purpose: in-memory registry of available `SearchProvider`s and the currently active one. Implements `PluginSearchRegistryPort`.
Class `SearchProviderRegistry`:
- `register(provider)` — adds a provider; auto-promotes the first registered provider to active.
- `unregister(id)` — removes a provider; re-picks an arbitrary remaining one as active if the active one was removed.
- `setActive(id)` — throws if unknown.
- `active()` — returns the active provider or `null` (drives the 501 at the controller when nothing is registered).
- `list()`.

##### `src/modules/search/providers/builtin-fts.provider.ts`
Purpose: the DB-native full-text provider — queries only, never writes the index (indexing is DB-trigger-maintained; see migration `1782400000000-AddMessagesFts`).
Class `BuiltInFtsProvider implements SearchProvider, OnModuleInit`:
- `onModuleInit()` — **self-heals** the FTS schema (`ensureFtsSchema`) at boot so search still works under `DATABASE_SYNCHRONIZE=true` (TypeORM creates the `messages` table from the entity but never runs migrations, so the FTS migration would otherwise be silently skipped on a fresh box). Caches the result in `ftsAvailable`.
- `search(query)` — dialect-branches to `buildSqlite`/`buildPostgres`, executes, maps rows to `SearchHit[]`; maps SQLite FTS5 query-grammar errors (bad `"`, `(`, `*`, bare boolean operators) to a clean `400 BadRequestException` rather than a raw 500 (Postgres's `websearch_to_tsquery` has no equivalent failure mode).
- `health()` — reflects actual FTS-schema availability, not just DB connectivity.
- `buildSqlite`/`buildPostgres` (private) — dialect-specific SQL builders using `snippet()`/`ts_headline()` respectively, both pinned to `<mark>`/`</mark>` highlight delimiters for a dialect-agnostic `SearchHit.snippet` contract.
- `applyFilters` (private) — shared WHERE-clause builder for `sessionIds`/`sessionId`/`chatId`/`from`/`direction`/`type`/`dateFrom`/`dateTo` (ms→seconds conversion at the boundary, since `messages.timestamp` is stored in epoch-seconds).
- `count` (private) — exact count query for pagination (skipped when the result page is already smaller than the limit at offset 0 — the common case needs no second query).
- `toFts5Query(raw)` (private, static) — quotes every token so SQLite FTS5 treats user input as a literal match (phone numbers/chatIds containing `@`/digits would otherwise trip the FTS5 grammar).

##### `src/modules/search/providers/plugin-search-provider.ts`
Purpose: a `SearchProvider` backed by a sandboxed plugin's worker, routed through the plugin host's `PluginSearchTransport`.
- `PluginSearchTransport` interface — `dispatchSearch({query, timeoutMs})`, `healthCheck(timeoutMs)` — satisfied structurally by `PluginWorkerHost`, so this module has no static dependency on the sandbox.
- `validatePluginSearchResults(results)` — runtime shape validator for the untrusted wire payload crossing the worker IPC boundary (returns the first violation description or `null`); guards against a plugin bug/hostile worker fabricating `total`, a non-array `hits`, or hits missing required string fields.
Class `PluginSearchProvider implements SearchProvider` (constructed `(pluginId, label, transport, timeoutMs)`, `id = plugin:<pluginId>`):
- `search(query)` — dispatches via the transport; `!reply.ok` → `503 ServiceUnavailableException`; invalid shape → `502 BadGatewayException`; then **defense-in-depth re-filters** hits by `query.sessionIds` host-side (never trusts the plugin to honor scope), adjusting `total` only when a leak was actually stripped (preserves pagination semantics in the well-behaved case).
- `health()` — maps the transport's general `healthCheck` result to `SearchHealth`.

##### `src/modules/search/search.service.ts`
Purpose: the one entry point for `/search`, enforcing scope and pagination bounds before delegating to the active provider.
Class `SearchService`:
- `search(query, callerSessionIds?)` — throws `501 NotImplementedException` if no provider is active; otherwise overwrites `sessionIds` with the caller's **authoritative** scope and clamps `limit`/`offset` to `SEARCH_LIMIT_MAX`/`SEARCH_OFFSET_MAX` before calling `provider.search`.
- `health()`.

##### `src/modules/search/search.controller.ts`
Controller prefix: `search`.

| Method | Path | Handler | Guards/Decorators | Description |
|---|---|---|---|---|
| GET | `/search` | `search` | `@RequireRole(ApiKeyRole.OPERATOR)` | Searches messages across sessions via the active provider. `q` required/non-empty (400 otherwise). Scope is derived **only** from `apiKey.allowedSessions`, never the query string. |

Documented response codes: 200 (results), 400 (empty `q`), 501 (no provider configured), 502 (plugin provider returned an invalid shape), 503 (plugin provider unreachable/timed out — retryable).

##### `src/modules/search/search.module.ts`
`SearchModule` — exports `bootstrapSearchProviders(registry, builtin, cfg)` (a factory function, also used as the `SEARCH_BOOTSTRAP` DI provider): registers `builtin-fts` unless `search.provider === 'none'` (which leaves the registry empty so the route 501s rather than 404s — distinct from `SEARCH_ENABLED=false`, which omits the whole module and 404s). Providers: `SearchProviderRegistry`, `SearchService`, `BuiltInFtsProvider`, the `SEARCH_BOOTSTRAP` factory, and an alias `PLUGIN_SEARCH_REGISTRY_PORT → SearchProviderRegistry` for the core plugin-host capability port.

##### `src/modules/search/dto/search-query.dto.ts`
`SearchQueryDto` — `q` (required string), `sessionId?`, `chatId?`, `from?`, `direction?` (enum `MessageDirection`), `type?` (free string — matched against stored `messages.type`), `dateFrom?`/`dateTo?` (epoch ms, `@Type(() => Number)` + `@IsNumber()` so a non-numeric query string 400s cleanly instead of reaching the provider as `NaN`), `limit?` (`@Min(1)`), `offset?` (`@Min(0)`). No `sessionIds` field — scope is host-injected only.

##### `src/modules/search/dto/search-response.dto.ts`
`SearchHitDto` (messageId, waMessageId, sessionId, chatId, body, snippet, timestamp [unix seconds], type, direction, from, score?) and `SearchResultsResponseDto` (`hits`, `total`, `tookMs`, `provider`).

---

### settings

A small, read-only "settings" reflection endpoint for the dashboard — surfaces effective environment-derived deployment configuration (never user-mutable through this module; actual mutation lives in `infra`).

##### `src/modules/settings/dto/settings-response.dto.ts`
Shape: `SettingsGeneralDto` (`apiBaseUrl`, `autoReconnect` [always true], `debugMode`), `SettingsApiDto` (`rateLimit`, `rateLimitWindow`, `enableDocs`), `SettingsNotificationsDto` (`emailEnabled`, `notificationEmail`, `webhookAlerts` — currently hardcoded placeholders, not wired to real config), and the wrapping `SettingsResponseDto`.

##### `src/modules/settings/settings.controller.ts`
Controller prefix: `settings`. Reads real configuration once in the constructor (`BASE_URL`, `database.logging`, `api.rateLimit.mediumLimit`/`mediumTtl`, `isSwaggerEnabled(ENABLE_SWAGGER, NODE_ENV)`) plus hardcoded notification placeholders.

| Method | Path | Handler | Guards | Description |
|---|---|---|---|---|
| GET | `/settings` | `get` | `@RequireRole(ApiKeyRole.ADMIN)`, `@RequireUnscopedKey()` | Returns the current effective settings snapshot. Gated ADMIN + unscoped because the data describes the deployment, not any one session. |

##### `src/modules/settings/settings.module.ts`
`SettingsModule` — declares `SettingsController` only (no providers of its own; depends on the global `ConfigService`).

---

### metrics

Serves Prometheus-format metrics at `GET /api/metrics`, and wires the global HTTP RED (rate/errors/duration) observation interceptor.

##### `src/modules/metrics/metrics.service.ts`
Purpose: hand-rolled Prometheus text-exposition renderer (no `prom-client` dependency — the surface is small).
Constant: `METRICS_RENDER_TTL_MS = 5000` (render memoization window — `getOverview()` runs a full session scan + several aggregate queries, so back-to-back scrapes/replicas reuse the same render).
Class `MetricsService`:
- `assertScrapeAuthorized(authorizationHeader)` — throws `404 NotFoundException` if `METRICS_TOKEN` is unset (endpoint disabled — a scanner can't even confirm it exists); throws `401 UnauthorizedException` on a missing/wrong bearer when a token **is** configured. Compare is constant-time (`constantTimeEqual`) and length-hiding (hashes both sides first) because this route is `@Public` and externally timeable.
- `render()` — memoized for `METRICS_RENDER_TTL_MS`. Emits always-available series (`openwa_up`, process uptime/memory) plus DB-derived series (`openwa_sessions_total`, `openwa_sessions{status=...}`, `openwa_messages_total{direction=...}`, `openwa_messages_failed_total`) **only** when `StatsService.getOverview()` succeeds — a failed DB read **omits** those series (rather than reporting zero, which would falsely alert "every session dropped") and sets `openwa_stats_available 0`. Also emits counters for webhook-delivery failures, session reconnect attempts/loop-alerts, restricted-session count, send-pacing refusals (only once a refusal has occurred), and the HTTP RED series via `renderHttpRequestMetrics()`.
- `escapeLabel(value)` (private) — escapes `\`, `"`, newline for Prometheus label-value safety.

##### `src/modules/metrics/metrics.controller.ts`
Controller prefix: `metrics`, class-level `@Public()` + `@SkipThrottle()` (scrape interval must not eat the rate-limit budget; access is instead gated by `METRICS_TOKEN` inside the service).

| Method | Path | Handler | Description |
|---|---|---|---|
| GET | `/metrics` | `scrape` | Prometheus exposition text. Requires `METRICS_TOKEN` bearer if configured (401 if wrong/missing, 404 if the feature is disabled). `Content-Type: text/plain; version=0.0.4`, `Cache-Control: no-store`. |

##### `src/modules/metrics/metrics.module.ts`
`MetricsModule implements NestModule` — imports `ConfigModule`, `StatsModule`; declares `MetricsController`; provides `MetricsService` and registers `RequestMetricsInterceptor` as a **global** `APP_INTERCEPTOR` (one HTTP RED observation per inbound request, skipped for `/api/health` and `/api/metrics`). `configure()` wires `requestMetricsBoundaryMiddleware` on `'*'` (every `/api` route) — runs **before** the global guards, so it also sees requests the guards reject (429/401/403) that the interceptor itself never would; the pair coordinate via a per-request claim so each response is counted exactly once.

---

### audit

The structured, queryable audit trail for security- and operations-relevant actions across the gateway (API key lifecycle, session lifecycle, send-pacing enforcement, integration-instance provisioning, infra operations, etc.). Backed by the `main` (SQLite) connection, global module.

##### `src/modules/audit/entities/audit-log.entity.ts`
Purpose: the `AuditAction` enum (every auditable action name, grouped by subsystem — API key, rate-limit, queue-board, session, message, send-pacing, webhook, integration-instance, infra) and `AuditSeverity` enum (`info|warn|error`), plus the `AuditLog` entity.
Shape: `id` (uuid), `action` (varchar 50, indexed), `severity` (varchar 10, default info), `apiKeyId`/`apiKeyName` (nullable, indexed on id), `sessionId`/`sessionName` (nullable, indexed on id), `ipAddress`, `userAgent`, `method`, `path`, `statusCode`, `metadata` (simple-json, nullable — free-form), `errorMessage`, `createdAt` (indexed).

##### `src/modules/audit/intentionally-unemitted-actions.ts`
Purpose: an explicit, documented registry of `AuditAction` values that are deliberately **not** emitted anywhere (e.g. `API_KEY_USED` — too high-volume; `MESSAGE_SENT`/`MESSAGE_FAILED` — redundant with the `messages` table). A companion coverage spec (`audit-coverage.spec.ts`) fails the build for any action neither emitted nor listed here (and fails if a listed action actually *is* emitted — keeps the registry honest in both directions).

##### `src/modules/audit/audit.service.ts`
Purpose: writes and queries audit rows.
Constant: `MAX_AUDIT_PAGE_SIZE = 200` (hard cap on `findAll`'s page size, regardless of requested `limit`).
Class `AuditService implements OnModuleInit, OnModuleDestroy`:
- `onModuleInit()` — schedules a daily prune (`AUDIT_RETENTION_DAYS`, default 90; `<=0` disables it), run once at startup then every 24h via an unref'd `setInterval`.
- `log(action, context?, severity?)` / `logInfo` / `logWarn` / `logError` — auto-attributes `apiKeyId`/`apiKeyName`/`ipAddress` from the per-request async-local context (`getRequestActor()`) when the call site didn't pass them explicitly, and stamps the active `requestId` into `metadata`. **Best-effort**: a failed insert is logged and swallowed (`return null`), never propagated — audit logging must never turn a succeeded operation into a 500.
- `findAll(options?, allowedSessions?)` — `allowedSessions` (from the calling key) is **authoritative**; `options.sessionId` may only narrow within it via `resolveSessionScope` (a session-scoped ADMIN key cannot read another tenant's rows via the query param). Clamps `limit` to `MAX_AUDIT_PAGE_SIZE` and `offset` to non-negative.
- `getRecentByApiKey(apiKeyId, limit?)` / `getRecentBySession(sessionId, limit?)`.
- `cleanup(olderThanDays?)` — the actual `DELETE ... WHERE createdAt < cutoff`, returns rows removed.

##### `src/modules/audit/audit.controller.ts`
Controller prefix: `audit`.

| Method | Path | Handler | Guards | Description |
|---|---|---|---|---|
| GET | `/audit` | `findAll` | `@RequireRole(ApiKeyRole.ADMIN)` | Paginated, filterable audit log list (`action`, `severity`, `sessionId`, `apiKeyId`, `limit`, `offset`). Scoped to the calling key's `allowedSessions` so a session-restricted ADMIN key can't read other tenants' rows via `sessionId`. |
| DELETE | `/audit` | `clear` | `@RequireRole(ApiKeyRole.ADMIN)` | Deletes audit logs older than `days` (omit or `0` = delete all). Returns `{deleted}`. |

##### `src/modules/audit/dto/audit-response.dto.ts`
Shape: `AuditLogDto` (full row projection, nullable fields match the entity) and `AuditListResponseDto` (`{data: AuditLogDto[], total}`).

##### `src/modules/audit/audit.module.ts`
`AuditModule` — `@Global()`. Imports `TypeOrmModule.forFeature([AuditLog], 'main')`; declares `AuditController`; provides/exports `AuditService` (injectable anywhere without an explicit import, since the module is global).

---

### health

Basic and Kubernetes-style health/liveness/readiness probes, all `@Public` and unthrottled.

##### `src/modules/health/dto/health-response.dto.ts`
Shape: `HealthCheckResponseDto` (`status`, `timestamp`, `version?` [only for an authenticated caller]), `LivenessResponseDto` (`status`), `ReadinessResponseDto` (`status`, `details: {[dep]: object}`).

##### `src/modules/health/health.controller.ts`
Controller prefix: `health`, class-level `@Public()` + `@SkipThrottle()`. `READINESS_PROBE_TIMEOUT_MS = 3000`. Reads the running `APP_VERSION` live from `package.json` at module load.

| Method | Path | Handler | Description |
|---|---|---|---|
| GET | `/health` | `check` | Basic health check — always `{status:'ok', timestamp}`. Includes `version` **only** if the request carries a valid API key (resolved manually via `hasValidApiKey`, since the route is `@Public` and the guard never runs). An invalid-but-presented key is audited (`API_KEY_AUTH_FAILED`, rate-bounded per IP via an in-process `SlidingWindowLimiter(10, 60_000)` so a probing flood can't fill the audit trail). |
| GET | `/health/live` | `liveness` | Always `{status:'ok'}` — deliberately static (process-liveness only; a transient dependency outage must not trigger a pod kill). |
| GET | `/health/ready` | `readiness` | Probes both the `main` and `data` DataSources (`SELECT 1`, each bounded by `READINESS_PROBE_TIMEOUT_MS`). Returns `503 ServiceUnavailableException` if the process is draining (`ShutdownService.isShuttingDown()`) or either DB is down; otherwise 200 with per-dependency status. |

##### `src/modules/health/health.module.ts`
`HealthModule` — declares `HealthController` only.

---

### infra

The Infrastructure dashboard's backend: reads/writes `data/.env.generated` (the dashboard-managed config overlay), orchestrates the bundled Docker containers (Postgres/Redis/MinIO), reports live infra status, and implements the full-database export/import (backup/restore/migration) and the object-storage archive export/import. Every route in this module is deployment-global and class-level-fenced with `@RequireUnscopedKey()` (a session-scoped API key can never reach any of it).

##### `src/modules/infra/generated-env.ts`
Purpose: shared read access to `data/.env.generated` (the KEY=value overlay the dashboard writes, merged into `process.env` on next boot, `override:false`).
- `generatedEnvPath()` — resolves per call against `process.cwd()`.
- `readGeneratedEnv()` — parses the file via `dotenv.parse`, or `{}` if it's never been written. Shared by the status read, the config-form hydrate, and the save-path's merge base.

##### `src/modules/infra/config-sections.ts`
Purpose: per-section appliers for `PUT /infra/config`, extracted out of the controller so each section's mode-switch logic (built-in↔external, sqlite↔postgres, local↔s3) is independently reviewable.
- `ConfigSectionContext` — `{updates, staleKeys, profiles}` accumulator threaded through every applier.
- `applyDatabaseSection(database, existing, ctx)` — handles postgres built-in (container defaults, bundled credential **only** when not already overridden by an external password) vs. external (drops the bundled password as stale on a built-in→external flip unless a new one is supplied) vs. sqlite (drops every postgres key as stale).
- `applyRedisSection(redis, existing, ctx)` — similar built-in/external split; drops a stale password when switching to the (passwordless) built-in container.
- `applyStorageSection(storage, existing, ctx)` — local vs. s3 (built-in MinIO vs. external S3, with the same stale-credential-on-flip handling).
- `applyEngineSection(engine, existing, ctx, engineFactory)` — validates `engine.type` against `engineFactory.getAvailableEngines()` (throws `BadRequestException` on an unknown id).

##### `src/modules/infra/migration-tables.types.ts`
Purpose: TypeScript row shapes for every exportable data-DB table (as returned by raw `SELECT *`, i.e. real column names, not always camelCase entity properties), plus the aggregate `MigrationTables`/`TableCounts` types keyed by the 15 backup table keys (`sessions`, `webhooks`, `messages`, `messageBatches`, `templates`, `baileysStoredMessages`, `lidMappings`, `pluginInstances`, `conversationMappings`, `ingressEvents`, `webhookDeliveryFailures`, `webhookOutboxEvents`, `integrationDeliveryFailures`, `statusUpdates`, `automationRules`).

##### `src/modules/infra/export-tables.ts`
Purpose: the registry driving `GET /infra/export-data` — one `ExportTable` descriptor per backup table, each naming its backup key, physical table, whether it's optional (may legitimately not exist on an older DB), an `afterRead` row-mutation hook, and an `inlineMedia` budget-spending hook.
- Private row-mutation helpers: `isMediaPointer` (a URL, not a base64 payload — must never be stripped), `redactWebhookCredentials` (drops `secret`/`headers` from exported webhook rows), `stripBodyTs` (drops the Postgres-only generated tsvector column), `stripInlineMediaPayload`/`stripBatchInlineMedia` (replace an over-budget inline media payload with the engine's own `{omitted:true, sizeBytes}` marker, keeping a truncated backup self-describing).
- `EXPORT_TABLES: AnyExportTable[]` — the ordered (FK-safe: sessions first) registry.
- `EXPORT_TABLE_EXCLUSIONS` — explicit, reasoned exceptions (currently empty — every data-connection entity table is exported).
- `InfraDataService.assertExportRegistryMatchesMetadata()` validates this registry against the live entity metadata at every export call, failing loudly on drift rather than silently exporting stale/incomplete data.

##### `src/modules/infra/table-importers.ts`
Purpose: the registry driving the restore half of `POST /infra/import-data` — one `TableImporter` descriptor per table with its exact `INSERT ... VALUES ($1, ...)` SQL (Postgres placeholder form; rewritten to `?` for SQLite by the caller), a `map()` row→params function, an `id()` function for warning messages, and an optional per-row `skip()` veto (e.g. `sessions` skips/warns on an unsafe session name rather than failing the whole restore).
- `TABLE_IMPORTERS: AnyTableImporter[]` — restore order mirrors `EXPORT_TABLES`' FK-safe order.
- Module-load-time self-check: asserts every expected table key has a registered importer (`EXPECTED_TABLE_KEYS`), throwing at import time if one is missing — a dropped/mis-keyed descriptor would otherwise silently never restore and vanish from the restored-row-count guard.

##### `src/modules/infra/infra-data.service.ts`
Purpose: the full data-DB backup machinery — export and the all-or-nothing, transactional replace-all import, including runtime (live-engine) reconciliation.
- `SessionOwnershipRow` — the cluster-runtime ownership quartet (`nodeId`, `claimedAt`, `leaseExpiresAt`, `nodeUrl`) a multi-node deployment tracks per session.
- `readSessionOwnership(queryRunner)` — reads live ownership claims through the **same** query runner as the import transaction (probes columns rather than catching a missing-column error, since a failed statement would abort the whole Postgres transaction).
- `carryLease(raw, readAt, now)` — carries a lease's **remaining** time forward across the import's own duration, rather than committing an already-stale absolute deadline; leaves an already-lapsed or unparseable value untouched.
- `restoreSessionOwnership(preserved, insert, readAt, now?)` — re-applies preserved ownership claims for ids present in both the pre-import and restored sets; errors are **not** swallowed (must take the same all-or-nothing rollback the rest of the import does).
- `SHARED_CONNECTION_DIALECTS` — dialects (`better-sqlite3`, `sqlite`) where every query runner shares one physical connection, which matters for both the single-flight nested-transaction detection and the ownership heartbeat suspension below.
- Inline-media export budget: `exportInlineMediaBudgetBytes()` (env `EXPORT_INLINE_MEDIA_BUDGET_BYTES`, default 8 MiB), `newestFirst(rows, at)` (sorts a copy newest-first so the budget favors recent media), `createInlineMediaBudget()` (spend tracker + dropped-payload counter).
Class `InfraDataService`:
  - `importInFlight` (private flag) — single-flight guard; on `better-sqlite3` every query runner is a driver singleton, so two overlapping imports would nest as a SAVEPOINT and corrupt each other's commit/rollback semantics.
  - `assertExportRegistryMatchesMetadata()` (private) — fails loudly on registry/metadata drift (see export-tables.ts doc).
  - `exportData(): Promise<InfraExportDataResult>` — iterates `EXPORT_TABLES`, tolerating only a *genuine* missing-table error (`isMissingTableError`) for `optional` tables (reported in `skippedTables`); spends one shared inline-media budget across `messages` then `messageBatches`; audits the export (`INFRA_DATA_EXPORTED`, counts only, never payload).
  - `importData(data)` — the single-flight entry point (throws `409 IMPORT_ALREADY_RUNNING` if another import is in flight); delegates to `runImport`.
  - `runImport(data)` (private) — the actual replace-all restore:
    1. Validates every present `tables.*` value is an array of plain-object rows (400 otherwise — prevents a 500 from dereferencing malformed input).
    2. **Orphan-engine pre-flight**: computes which locally-running engines have no matching row in the imported `sessions` set. Three operator-chosen outcomes — default refuse (`409 IMPORT_WOULD_ORPHAN_ENGINES`), `stopOrphans: true` (stops them in-request via `SessionService.stopOrphanEngines`, bounded per-engine), `force: true` (proceeds, `restartRequired: true`). Also reports (via `notices`, non-fatal) any sessions held by **another** node (`SessionOwnershipService.heldByOtherNodes`) that this request has no channel to stop.
    3. Optionally suspends the ownership-heartbeat loss detection for the transaction's duration, but **only** on shared-connection dialects (Postgres gets a dedicated pooled client per runner, so the heartbeat can't see inside the transaction there).
    4. Opens a transaction; refuses with `409 IMPORT_NESTED_TRANSACTION` if the query runner already has one active (the only-safe answer on a shared-connection dialect, since the outcome of nesting would be genuinely indeterminate).
    5. Clears every restorable table (tolerating missing tables), preserving session-ownership rows across the `sessions` DELETE via the read-then-carry-then-reinsert dance above.
    6. Restores table-by-table via `TABLE_IMPORTERS`, collecting per-row `warnings` on failure (never aborting the loop).
    7. Normalizes any restored session row carrying an **active** status (ready/initializing/etc., meaning the source host's engine state) back to `DISCONNECTED` for rows this node could claim — mirrors boot's own reset.
    8. **All-or-nothing gate**: any `warnings` → rollback, `imported:false`. Zero rows restored at all → rollback (refuses to silently wipe the DB on a garbage/empty backup).
    9. On success: commits, reloads the in-memory lid-mapping cache, audits (`INFRA_DATA_IMPORTED`, counts only), and returns `restartRequired`/`orphanedEngines`/`stoppedOrphanEngines`/`failedOrphanEngines`.

##### `src/modules/infra/infra-config.controller.ts`
Controller prefix: `infra`, class-level `@RequireUnscopedKey()`.

| Method | Path | Handler | Guards | Description |
|---|---|---|---|---|
| GET | `/infra/config` | `getConfig` | `@RequireRole(ApiKeyRole.ADMIN)` | Effective infrastructure config for dashboard-form hydration (secrets omitted, `*Set` booleans instead). Reads host-env-pinned values ahead of `data/.env.generated` when the host env actually wins at boot (`isEnvPinned`). |
| PUT | `/infra/config` | `saveConfig` | `@RequireRole(ApiKeyRole.ADMIN)` | Merges a (possibly partial, per-section) payload into `data/.env.generated`. Rejects line-break-injected values (400). Refuses (400) a save that would crash-loop the **next** production boot (`assertProductionBootable`, evaluated against what that boot would actually see, host-env precedence included). Returns `{saved:false}` with HTTP 200 for a non-validation I/O failure (status-code contract: only a real validation rejection is a throw). Audited (`INFRA_CONFIG_SAVED`, section names + Docker profiles only). |
| POST | `/infra/restart` | `requestRestart` | `@RequireRole(ApiKeyRole.ADMIN)` | Orchestrates Docker containers per `profiles`/`profilesToRemove` (both filtered to `MANAGED_DOCKER_PROFILES` — never lets a caller-supplied profile name reach `stopManagedService`/`orchestrateProfiles` for an unrelated container), falling back to a signal-file write when Docker isn't available. Audits (`INFRA_RESTART_REQUESTED`), then schedules a graceful `ShutdownService.shutdown()`. |

##### `src/modules/infra/infra-status.controller.ts`
Controller prefix: `infra`, class-level `@RequireUnscopedKey()`.

| Method | Path | Handler | Guards | Description |
|---|---|---|---|---|
| GET | `/infra/status` | `getStatus` | `@RequireRole(ApiKeyRole.ADMIN)` | Live infrastructure status: active `SELECT 1` probes on both DataSources (not just `isInitialized`, which stays true after Postgres dies mid-process), Redis connectivity via `CacheService`, storage type/path/bucket + S3 reachability probe, engine type/headless/WhatsApp-Web build version, and **live-detected** built-in flags (prefers the actually-running labeled container over the saved intent, falling back to the saved flag when Docker is unreachable). Also returns `envPinned` — which of the 4 dashboard-editable keys are overridden by a layer above `data/.env.generated`. |
| GET | `/infra/engines` | `getEngines` | `@RequireRole(ApiKeyRole.ADMIN)` | List available WhatsApp engines (`EngineFactory.getAvailableEngines()`). |
| GET | `/infra/engines/current` | `getCurrentEngine` | (role unset — inherits default auth) | Current active engine type. |
| GET | `/infra/health` | `healthCheck` | `@Public()` | Liveness-only (no dependency probes — see `/infra/status` for those). |

##### `src/modules/infra/infra-storage.controller.ts`
Controller prefix: `infra`, class-level `@RequireUnscopedKey()`, implements `OnApplicationBootstrap` for a stale-archive sweep.
`EXPORT_ARCHIVE_PATTERN` — matches exactly the filenames `exportStorage` writes (`storage-export-<epochMs>-<uuid>.tar.gz`) so the sweep only ever touches files it created.
- `onApplicationBootstrap()` → `sweepStaleExportArchives()` — deletes export archives older than `STORAGE_EXPORT_SWEEP_MAX_AGE_MS` (default 24h) at boot, recovering from a process restart/crash that killed the per-export TTL timer before it fired.

| Method | Path | Handler | Guards | Description |
|---|---|---|---|---|
| GET | `/infra/storage/files/count` | `getStorageFileCount` | `@RequireRole(ApiKeyRole.ADMIN)` | File count + total size in the active storage backend. |
| GET | `/infra/storage/export` | `exportStorage` | `@RequireRole(ApiKeyRole.ADMIN)` | Streams all stored files into a `tar.gz` under `data/exports/` (persistent volume, not OS temp — the migration flow restarts the process before importing). Returns a JSON pointer to the archive (**not** the stream itself). Self-deletes after `STORAGE_EXPORT_TTL_MS` (default 1h, unref'd timer) and is additionally boot-swept. Audited (`INFRA_STORAGE_EXPORTED`). |
| POST | `/infra/storage/import` | `importStorage` | `@RequireRole(ApiKeyRole.ADMIN)` | Imports files from a `tar.gz` at `filePath`, which **must** resolve inside `data/` (`isPathWithin` guard — 400 otherwise; prevents arbitrary host file reads). 400 on a malformed archive. Audited (`INFRA_STORAGE_IMPORTED`). |

##### `src/modules/infra/infra-data.controller.ts`
Controller prefix: `infra`, class-level `@RequireUnscopedKey()`. Thin HTTP adapter over `InfraDataService` (routing/guards/DTO only — the actual export/import logic lives in the service).

| Method | Path | Handler | Guards | Description |
|---|---|---|---|---|
| GET | `/infra/export-data` | `exportData` | `@RequireRole(ApiKeyRole.ADMIN)` | Full data-DB export for migration/backup. |
| POST | `/infra/import-data` | `importData` | `@RequireRole(ApiKeyRole.ADMIN)` | Replace-all restore from an export payload. 400 on malformed body; 409 with a `code` (`IMPORT_ALREADY_RUNNING`, `IMPORT_NESTED_TRANSACTION`, `IMPORT_WOULD_ORPHAN_ENGINES`) on a structured refusal. |

##### `src/modules/infra/dto/save-config.dto.ts`
Shape: `DatabaseConfigDto`, `RedisConfigDto`, `QueueConfigDto`, `StorageConfigDto`, `EngineConfigDto` (all section DTOs for `PUT /infra/config`, every field optional except `database.type`/`storage.type`), composed into `SaveConfigDto`. Boolean/numeric fields use `@ToStrictBoolean`/`@ToStrictNumber` (guards against the global `ValidationPipe`'s implicit-conversion coercing a form-encoded `'false'` string to `true`).

##### `src/modules/infra/dto/import-data.dto.ts`
`ImportDataDto` — `tables` (required object, validated shallowly — **not** `@ValidateNested`, deliberately, since every omitted table key is restored *empty*); `force?`/`stopOrphans?` (strict booleans); plus five `@Allow()`-only export-envelope metadata fields (`exportedAt`, `dataDbType`, `counts`, `skippedTables`, `omittedInlineMedia`) accepted-but-ignored so the raw export file posts back verbatim without `forbidNonWhitelisted` rejecting it.

##### `src/modules/infra/dto/import-storage.dto.ts`
`ImportStorageDto` — `{filePath: string}` (required, non-empty).

##### `src/modules/infra/dto/infra-response.dto.ts`
Shape: response DTOs for every infra route — `InfraStatusResponseDto` (nested `InfraDatabaseStatusDto`/`InfraRedisStatusDto`/`InfraQueueStatusDto`[+`InfraQueueDepthDto`]/`InfraStorageStatusDto`/`InfraEngineStatusDto`, plus `envPinned: string[]`), `InfraHealthResponseDto`, `AvailableEngineDto` (+`EngineLibraryDto`), `InfraCurrentEngineResponseDto`, `InfraConfigResponseDto` (+ nested Database/Redis/Queue/Storage/Engine config DTOs, secrets represented only as `*Set` booleans), `InfraConfigSaveResponseDto`, `InfraRestartResponseDto`, `MigrationTablesDto`/`TableCountsDto`/`OmittedInlineMediaDto`/`InfraExportDataResponseDto`/`InfraImportDataResponseDto`, `StorageFileCountResponseDto`/`StorageExportResponseDto`/`StorageImportResponseDto`.

##### `src/modules/infra/infra.module.ts`
`InfraModule` — imports `EngineModule`, `DockerModule`, `SessionModule` (for the import orphan-engine pre-flight check), and `QueueModule` only when `QUEUE_ENABLED=true` (so `InfraStatusController` can `@Optional() @InjectQueue` the webhook queue for live job counts). Declares `InfraStatusController`, `InfraConfigController`, `InfraDataController`, `InfraStorageController`. Provides `InfraDataService`.

---

### docker

Thin wrapper around `dockerode` for managing OpenWA's three bundled/managed service containers (Postgres, Redis, MinIO) — used by the `infra` module's restart/orchestration flow.

##### `src/modules/docker/docker.service.ts`
Purpose: Docker API client + container lifecycle for the managed built-in services.
`MANAGED_DOCKER_PROFILES: readonly string[] = ['postgres', 'redis', 'minio']` — exported allowlist; every caller that accepts a profile name from an HTTP request filters against this before it reaches Docker operations.
Class `DockerService implements OnModuleInit`:
- `onModuleInit()` — `initializeDocker()` then `bootstrapOrchestration()`.
- `bootstrapOrchestration()` (private) — on boot, starts whichever of `REDIS_BUILTIN`/`POSTGRES_BUILTIN`/`MINIO_BUILTIN` env flags are `'true'`, so containers match saved config after a restart.
- `initializeDocker()` (private) — connects via `dockerOptions` (TCP `DOCKER_HOST=tcp://host:port` parsed, else the local Unix socket); sets `isAvailable` based on a successful `docker.ping()`.
- `buildDockerOptions()` — exposed for testing.
- `isDockerAvailable()` — returns the cached `isAvailable`; if false and `DOCKER_HOST` is a TCP target, kicks off a background re-init retry (recovers from a socket-proxy container not yet accepting connections when `onModuleInit` first ran, without needing a process restart).
- `listContainers()` — all containers carrying the `com.openwa.service` label or an `/openwa-*` name prefix.
- `getRunningBuiltinServices()` — `{database, cache, storage}` booleans, true only for a **running** container also labeled `com.openwa.builtin=true`.
- `getContainerByService(service)` — resolves by label first, then falls back to an **exact** name match (`openwa-<service>`) — never a substring match, which could otherwise resolve an arbitrary container.
- `getContainerSpec(profile)` (private) — the three hardcoded container specs (image, env, volumes, healthcheck, labels, security-opt) for `redis`/`postgres`/`minio`, kept in parity with `docker-compose.yml` (enforced by `compose-parity.spec.ts`). Built-in credentials are fixed defaults (`openwa`/`openwa`, `minioadmin`/`minioadmin`) — deliberately different from the compose services, which ship no default secret.
- `createService(profile)` — creates-or-starts a managed container: checks for an existing container first, else pulls the image, creates named volumes, and creates the container with the spec (network `openwa-network`, `RestartPolicy: unless-stopped`, `no-new-privileges` security-opt, DNS aliases).
- `startService(service)` — starts an existing container or creates one via the service→profile name map.
- `stopManagedService(profile)` — **stop-only**, never `remove()` — the bundled `docker-socket-proxy` doesn't honor its `DELETE` env flag reliably, and retention is also what the disable→re-enable flow wants (named volume + container config survive).
- `stopService(service)` — the actual stop (idempotent — returns true if already stopped/missing).
- `orchestrateProfiles(profiles)` — starts each requested profile's service, returning `{success, message, containersStarted, containersStopped, errors, estimatedTime}`.
- `getSystemInfo()` — raw Docker `info()` summary.

##### `src/modules/docker/docker.module.ts`
`DockerModule` — provides/exports `DockerService` only.

##### `src/modules/docker/index.ts`
Re-exports `./docker.module` and `./docker.service`.

---

### stats

Aggregate and per-session statistics for the dashboard (session counts by status, message counts/time-series, top chats, hourly activity) — reused by the `metrics` module for Prometheus export.

##### `src/modules/stats/stats.service.ts`
Purpose: dialect-portable (SQLite/Postgres) aggregate queries over `sessions`/`messages`, with an in-process TTL memo.
Module-level SQL helpers (dialect-branching): `timeSeriesTimestampSql(dbType, interval)` (SQLite `strftime`/Postgres `to_char`, hour or day buckets), `hourBucketSql(dbType)` (0–23 integer bucket), `maxCreatedAtSql(dbType)` (MAX(createdAt) in an identical text format on both engines).
Class `StatsService`:
- In-memory `memo: Map<key, {expiresAt, value}>` — keyed by query shape (`overview:<scope>`, `messages:<period>:<scope>`, `session:<id>`); TTL from `stats.cacheTtlMs` (default 30000ms, 0 disables); no write-path invalidation hook (pure TTL expiry); `getSessionStats` additionally re-checks the session still exists on every call and evicts the memo entry if not (so a deleted session's stats don't keep serving stale).
- `scopeKey(allowedSessions?)` (private) — stable memo-key fragment (`'all'` or a sorted id list) so a scoped and unscoped caller never share a cached aggregate.
- `scopeMessages(qb, allowedSessions?)` (private) — applies `m.sessionId IN (...)` when scoped.
- `getOverview(allowedSessions?)` → `loadOverview` (private) — session counts by status + active count; message sent/received/failed totals + today's sent/received. Only the **unscoped** view is cached into `CacheService.setSessionsStats` (a per-company slice must never overwrite the global truth).
- `getMessageStats(period, allowedSessions?)` → `loadMessageStats` (private) — time series (hour buckets for `24h`, day buckets for `7d`/`30d`), by-type breakdown (excludes content-less system/event rows), by-session breakdown, top-10 chats by message count.
- `getSessionStats(sessionId)` → `loadSessionStats` (private) — per-session sent/received/today/failed, top-10 chats with `lastActive`, and 24h hourly activity (zero-filled for hours with no data).
- `getPeriodStart(period)` / `getTimeSeries(since, interval, allowedSessions?)` / `getHourlyActivity(sessionId)` (private helpers).

##### `src/modules/stats/stats.controller.ts`
Controller prefix: `stats`.
- `assertMayReadAggregate(apiKey?)` (private) — the aggregate routes carry no `:sessionId`, so the standard guard's route-param fence can't scope them; a **session-scoped** key implicitly gets the aggregate over its own sessions, while an **unscoped** key must be `ADMIN` (otherwise throws `403 ForbiddenException`) so a plain VIEWER can't read platform-wide activity.

| Method | Path | Handler | Description |
|---|---|---|---|
| GET | `/stats/overview` | `getOverview` | Aggregate stats over the key's allowed sessions, or all sessions for an admin key. |
| GET | `/stats/messages` | `getMessageStats` | Message stats + time series for `?period=24h\|7d\|30d` (default `24h`). |
| GET | `/stats/sessions/:sessionId` | `getSessionStats` | Per-session stats (no aggregate-scope check needed — standard guard fences by the route param). |

##### `src/modules/stats/dto/stats-query.dto.ts`
`StatsQueryDto` — `period?: '24h'|'7d'|'30d'` (default `'24h'`).

##### `src/modules/stats/dto/stats-response.dto.ts`
Shape: `OverviewStatsResponseDto` (`sessions: OverviewSessionsDto {active, total, byStatus}`, `messages: OverviewMessagesDto {sent, received, failed, today: OverviewTodayDto}`), `MessageStatsResponseDto` (`timeSeries: TimeSeriesPointDto[]`, `byType: {[type]: number}`, `bySession: StatsBySessionDto[]`, `topChats: StatsTopChatDto[]`), `SessionStatsResponseDto` (`session: SessionStatsSessionDto`, `messages: SessionStatsMessagesDto`, `topChats: SessionStatsTopChatDto[]`, `hourlyActivity: SessionHourlyActivityDto[]`).

##### `src/modules/stats/stats.module.ts`
`StatsModule` — imports `TypeOrmModule.forFeature([Session, Message], 'data')`; declares `StatsController`; provides/exports `StatsService` (consumed by `MetricsModule`).

---

## 9. Finding Your Way Around

A few conventions and shortcuts that make the codebase faster to navigate once you know them:

- **"Where's the route for X?"** Every HTTP route lives in a `*.controller.ts` file under `src/modules/<name>/`, grep for `@Controller(` to find the module prefix, then `@Get(`/`@Post(`/`@Patch(`/`@Delete(` for individual paths. Sections 6–8 above list every route for every module as tables.
- **"Where's the business logic for X?"** In the matching `*.service.ts` next to the controller. Controllers are thin — they validate/transform input and delegate to a service.
- **"Which routes need an API key, and what role?"** `src/modules/auth/` owns the global `ApiKeyGuard` (applied as `APP_GUARD`, so it runs on every route by default). A route opts out with `@Public()`; a route that needs more than "any valid key" uses `@RequireRole('ADMIN' | 'OPERATOR' | 'VIEWER')`. Per-key session scoping is enforced by the same guard reading the route's `:sessionId` param against the key's allowed sessions.
- **"How do I add support for a new WhatsApp capability?"** Add the method to `IWhatsAppEngine` (`src/engine/interfaces/`), implement it in both `src/engine/adapters/baileys/` and `src/engine/adapters/whatsapp-web-js/` (or throw `EngineNotSupportedError` in one if it can't support it), then call it from the relevant module's service via `EngineRegistry`. See Section 5.
- **"How do I add a new database table?"** Add a TypeORM entity under the owning module's `entities/`, register it in that module's `TypeOrmModule.forFeature([...], 'data')` (or `'main'` for API keys/audit logs), then generate a migration (`npm run migration:generate -- --name=...`) rather than relying on `synchronize` in production. See Section 4 → `src/database/**`.
- **"How do outbound webhooks/events get fired?"** Feature services call into `src/modules/webhook/` (HTTP callbacks to user-configured URLs) and/or `src/modules/events/` (Socket.IO push to connected dashboard/API clients) after a state change; `src/core/hooks/` additionally lets sandboxed plugins (`src/core/plugins/`) subscribe to the same lifecycle points.
- **"Something only happens when an env var is set"** — check `src/app.module.ts` first for the four conditional-mount flags (`QUEUE_ENABLED`, `MCP_ENABLED`, `SEARCH_ENABLED`, `SERVE_DASHBOARD`), then `src/config/configuration.ts` / `.env.example` for everything else.
- **Tests:** unit/integration specs sit next to their source file as `*.spec.ts` (run via `npm test`); full-stack e2e specs live in `test/*.e2e-spec.ts` (run via `npm run test:e2e`) and spin up a real Nest app against SQLite.
- **Further reading:** `docs/01-project-overview.md` through `docs/08-development-guidelines.md` cover product vision, requirements, architecture diagrams, security design, database design, and the full OpenAPI specification — read those for the "why," and this document for the "where."

