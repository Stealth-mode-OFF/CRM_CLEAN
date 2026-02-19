# TODO

## Setup
- [x] Initialize pnpm workspace and TypeScript project structure
- [x] Add Docker Compose for Postgres + Redis
- [x] Add Prisma schema + initial migration

## Core Infra
- [x] Implement shared env validation, logger, hashing/idempotency, business-day utilities
- [x] Implement Pipedrive client with retry/backoff, limiter, v2-first helpers
- [x] Implement BullMQ queue setup and job names

## API (apps/api)
- [x] Implement Fastify server bootstrap
- [x] Implement `POST /webhooks/pipedrive` with token validation + event hash persistence + queue enqueue
- [x] Implement admin endpoints (`fieldmap/refresh`, review queue list/approve stub, run jobs)

## Worker (apps/worker)
- [x] Implement `processWebhookEvent` job dispatcher
- [x] Implement `slaDealEnforce` job
- [x] Implement `leadTriageEnforce` job
- [x] Implement nightly `slaSweep`

## Data Safety & Loop Protection
- [x] Add autopilot fingerprinting for created notes/activities
- [x] Add idempotency key writes for job/entity/day
- [x] Add audit log writes for all mutating/planned actions

## Testing
- [x] Unit tests: business-day scheduling
- [x] Unit tests: hashing/idempotency determinism
- [x] Unit tests: future-activity check
- [x] Unit tests: webhook parsing + helpers
- [x] Integration test: webhook -> queue -> slaDealEnforce in DRY_RUN

## Docs
- [x] Update README with setup/run/test instructions
- [x] Record ADR-lite entries in DECISIONS.md

## Post-MVP (from Claude Copilot review)
- [x] Add `BOT_USER_ID` env var and `meta.user_id` check in `processWebhookEventJob` (ADR-014)
- [x] Fix `convertToDeal` endpoint order — try `/api/v2/leads/{id}/convert` first, then fallback
- [x] Add `meta.is_bulk_update` skip logic in webhook processing
- [x] Implement merge execution in `mergeReviewJob` following ADR-013 acceptance rules
- [x] Add lead sweep to nightly cron
- [ ] Add Bull Board or similar dashboard for job queue inspection

## CODEX_PROMPT.md execution (2026-02-19)
- [x] Extend env surface (`BOT_USER_ID`, merge threshold, cadence thresholds, company domain, lead sweep cron)
- [x] Add shared utilities: `scoreLead` + `buildPipedriveUrl`
- [x] Add Prisma models + migration: `MergeCandidate`, `DealSnapshot`
- [x] Implement nightly lead sweep worker job (`leadSweep`) and deal snapshots in `slaSweep`
- [x] Implement stale-deal nudge flow with idempotency + audit + dry-run behavior
- [x] Implement merge review safety gates and manual execute endpoint (`POST /admin/merge/:id/execute`)
- [x] Add dashboard backend endpoints (`velocity`, `cadence`, `briefing`, `leads`, `analytics`)
- [x] Add dashboard quick-action endpoints (`add-activity`, `add-note`, `snooze`)
- [x] Add API 60s in-memory caching + `Cache-Control: max-age=60` on dashboard endpoints
- [x] Extend `/health` with subsystem checks + queue depth
- [ ] Frontend dashboard UX tasks (components, shortcuts, responsive polish, error boundaries) — blocked in this repo (frontend app not present)
