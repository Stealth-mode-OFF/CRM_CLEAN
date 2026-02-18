# ARCHITECTURE

## System Overview

Single-tenant internal service that enforces SLA and lead-triage rules on a Pipedrive CRM instance. Receives webhooks, deduplicates events, enqueues jobs, and executes business logic with full audit trails and dry-run safety.

**Status:** MVP implemented by Codex. Architecture doc populated by Claude Copilot.

## Component Diagram

```
                          ┌─────────────────────────────────┐
                          │         Pipedrive CRM            │
                          │  (deals, leads, activities, …)   │
                          └──────┬──────────────┬────────────┘
                                 │ webhooks     ▲ API calls
                                 ▼              │
┌────────────────────────────────────────────────┼────────────┐
│  apps/api  (Fastify)                           │            │
│                                                │            │
│  POST /webhooks/pipedrive                      │            │
│    ├─ validate x-autopilot-token               │            │
│    ├─ stableHash(payload) → eventHash          │            │
│    ├─ persist WebhookEvent (dedup on hash)     │            │
│    └─ enqueue processWebhookEvent              │            │
│                                                │            │
│  Admin endpoints:                              │            │
│    POST /admin/fieldmap/refresh                │            │
│    GET  /admin/review-queue                    │            │
│    POST /admin/review-queue/:id/approve        │            │
│    POST /admin/jobs/run/:name                  │            │
│    GET  /health                                │            │
└────────────────┬───────────────────────────────┘            │
                 │ BullMQ                                     │
                 ▼                                            │
┌────────────────────────────────────────────────┐            │
│  apps/worker  (BullMQ)                         │            │
│                                                │            │
│  dispatchJob() routes by job.name:             │            │
│    processWebhookEvent                         │            │
│      ├─ parse payload → deal | lead | unknown  │            │
│      ├─ loop protection (echo detection)       │            │
│      └─ delegate to slaDealEnforce / leadTriage│            │
│    slaDealEnforce                              │            │
│      ├─ idempotency check (scope+key+day)      │            │
│      ├─ fetch deal + activities                ├────────────┘
│      ├─ skip if future activity exists         │
│      └─ create activity + note (or dry-run)    │
│    leadTriageEnforce                           │
│      ├─ idempotency check                      │
│      ├─ fetch lead + person + org + activities │
│      ├─ check missing signals + SLA window     │
│      └─ create qualification activity          │
│    slaSweep                                    │
│      ├─ list all open deals                    │
│      └─ run slaDealEnforce for each            │
│    mergeReview (stub — deferred in MVP)        │
└────────────────┬───────────────────────────────┘
                 │
    ┌────────────┼────────────┐
    ▼            ▼            ▼
┌────────┐  ┌────────┐  ┌─────────┐
│Postgres│  │ Redis  │  │Pipedrive│
│(Prisma)│  │(BullMQ)│  │  API    │
└────────┘  └────────┘  └─────────┘
```

## Event Flow (detailed)

### 1. Webhook ingestion (`POST /webhooks/pipedrive`)
- Validate `X-Autopilot-Token` header.
- Stable-hash payload → `eventHash`. Persist in `WebhookEvent` (`status=queued`).
- Deduplicate: if hash already exists, return `{ deduped: true }`.
- Enqueue `processWebhookEvent` job (`jobId=eventHash`).

### 2. Webhook processing (`processWebhookEvent`)
- Load payload by `eventHash`.
- Parse entity type (`deal` / `lead`) defensively from v2/v1-style payload variants.
- **Loop protection:** Skip if recent `[AUTOPILOT]` note exists for entity (10-min window). Post-MVP: skip if `meta.user_id === BOT_USER_ID`.
- Dispatch to `slaDealEnforce` or `leadTriageEnforce`.
- Mark `WebhookEvent` as `processed` / `failed`.

### 3. SLA deal enforcement (`slaDealEnforce`)
- Idempotency key: `scope=job:slaDealEnforce`, `key=<dealId>:<YYYY-MM-DD>`.
- Load deal; require open status and allowed stage.
- Check future activities (missing `due_time` interpreted as `23:59 UTC`).
- If none: schedule `[AUTOPILOT] Follow-up` (+2 business days), add note, audit.
- `DRY_RUN=true`: no remote writes, planned action logged to `AuditLog`.

### 4. Lead triage enforcement (`leadTriageEnforce`)
- Idempotency key per lead/day.
- Assess signals: person email, org domain, person existence.
- Ensure qualification activity exists within SLA window (`SLA_FUTURE_ACTIVITY_DAYS` business days).
- If missing signals or no activity in window: create qualification activity (+2 business days) + note.
- `DRY_RUN=true` behavior mirrors deal flow.

### 5. Nightly sweep (`slaSweep`)
- Manual or nightly trigger over all open deals with optional `PIPELINE_ID` filter.
- Runs `slaDealEnforce` for each deal (idempotency prevents duplicates).
- Tracks run stats in `JobRun`.

## Data Safety Layers

| Layer | Mechanism | Purpose |
|-------|-----------|---------|
| Webhook dedup | `WebhookEvent.eventHash` (unique) | Reject duplicate deliveries |
| Loop protection (primary, post-MVP) | `BOT_USER_ID` check on `meta.user_id` | Skip self-triggered webhooks |
| Loop protection (current) | `[AUTOPILOT]` prefix + 10-min echo window | Skip webhooks caused by own writes |
| Idempotency | `IdempotencyKey` per scope+entity+day | One action per entity per day |
| Dry-run | `DRY_RUN=true` default | Audit without mutation |
| Audit trail | `AuditLog` with before/after JSON | Full observability |
| Rate limiting | Bottleneck `maxConcurrent=5`, `minTime=200ms` | Stay within Pipedrive limits |
| Retry | Exponential backoff on 429/502/503/504 | Recover from transient failures |

## Database Models

| Model | Purpose |
|-------|---------|
| `FieldMap` | Cached Pipedrive field definitions (synced via admin endpoint) |
| `IdempotencyKey` | Job dedup locks scoped by job type + entity + day |
| `AuditLog` | Immutable record of all actions (planned or executed) |
| `WebhookEvent` | Incoming webhook payloads with processing status |
| `ReviewQueue` | Items requiring human approval (e.g., merge candidates) |
| `JobRun` | Sweep/batch job execution records with stats |

## Pipedrive API Strategy

- **v2-first**: Deals, leads, fields, and cursor pagination use `/api/v2/*`
- **v1 fallback**: Activities, notes, persons, orgs, and webhook CRUD use `/v1/*`
- **Lead convert**: Canonical endpoint is `POST /api/v2/leads/{id}/convert` with body `{ "deal": { ... } }`

## Technology Choices

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| Runtime | Node.js + TypeScript via tsx | Type safety + fast dev iteration |
| API | Fastify | High performance, schema validation |
| Queue | BullMQ + Redis | Reliable jobs, retries, backoff |
| Database | PostgreSQL + Prisma | Typed queries, migrations |
| Monorepo | pnpm workspaces | Strict deps, fast installs |
| Testing | Vitest | Fast, ESM-native, workspace-compatible |

## Known Gaps / Post-MVP

- `BOT_USER_ID` env var for primary loop protection (see ADR-014)
- Merge execution with acceptance rules (see ADR-013)
- Lead convert endpoint consolidation
- `meta.is_bulk_update` skip logic in webhook processing
