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
- [ ] Add `BOT_USER_ID` env var and `meta.user_id` check in `processWebhookEventJob` (ADR-014)
- [ ] Fix `convertToDeal` endpoint order — try `/api/v2/leads/{id}/convert` first, drop `/convert/deal`
- [ ] Add `meta.is_bulk_update` skip logic in webhook processing
- [ ] Implement merge execution in `mergeReviewJob` following ADR-013 acceptance rules
- [ ] Add lead sweep to nightly cron (currently manual-only via admin endpoint)
- [ ] Add Bull Board or similar dashboard for job queue inspection
