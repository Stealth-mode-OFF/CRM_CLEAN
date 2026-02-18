# ARCHITECTURE

Status: MVP implemented by Codex (awaiting Claude edge-case additions).

## Runtime architecture
- `apps/api` receives Pipedrive webhooks and enqueues BullMQ jobs.
- `apps/worker` processes queued jobs and executes autopilot logic.
- Shared dependencies:
- Postgres via Prisma for persistence (`WebhookEvent`, `IdempotencyKey`, `AuditLog`, `FieldMap`, `ReviewQueue`, `JobRun`).
- Redis for BullMQ queue.

## Event flow (implemented)
1. `POST /webhooks/pipedrive`
- Validate `X-Autopilot-Token`.
- Stable-hash payload and persist idempotently in `WebhookEvent` (`status=queued`).
- Enqueue `processWebhookEvent` (`jobId=eventHash`).

2. Worker `processWebhookEvent`
- Load payload by `eventHash`.
- Parse entity (`deal` / `lead`) defensively from v2/v1-style payload variants.
- Echo loop protection: skip if recent `[AUTOPILOT]` note exists for entity.
- Dispatch:
- deal -> `slaDealEnforce`
- lead -> `leadTriageEnforce`
- Mark `WebhookEvent` `processed` / `failed`.

3. `slaDealEnforce`
- Idempotency key: `scope=job:slaDealEnforce`, `key=<dealId>:<YYYY-MM-DD>`.
- Load deal; require open status and allowed stage.
- Check future activities (missing due time interpreted as `23:59 UTC`).
- If none: schedule `[AUTOPILOT] Follow-up` (+2 business days), add note, audit.
- `DRY_RUN=true`: no remote writes, audit planned action only.

4. `leadTriageEnforce`
- Idempotency key per lead/day.
- Assess signals (person/email/org-domain).
- Ensure qualification activity in SLA window (`SLA_FUTURE_ACTIVITY_DAYS`) else create one (+2 business days) + note.
- `DRY_RUN=true` behavior mirrors deal flow.

5. `slaSweep`
- Manual/nightly sweep over open deals with optional pipeline filter.
- Tracks run stats in `JobRun`.

## API version strategy
- Prefer v2 endpoints where available:
- Leads (`/api/v2/leads*`)
- Deals (`/api/v2/deals*`)
- Cursor pagination helpers
- Fields v2 attempts first (`/api/v2/<entity>Fields`)
- Fallback to legacy v1 where needed:
- Activities, Notes, Persons, Organizations, Webhook CRUD, legacy fields endpoints

## Safety controls
- Dry-run default.
- No destructive operations implemented.
- Audit log on all planned/mutating autopilot actions.
- Retry/backoff for 429/502/503/504.
- Limiter defaults: concurrency 5 and ~5 req/sec.
- In-process daily mutation budget guard for non-GET requests.

## Known gaps / pending clarification
- Exact webhook v2 actor/source metadata parsing for more explicit loop suppression.
- Merge execution is intentionally deferred (approval endpoint exists; merge job currently audit-only).
