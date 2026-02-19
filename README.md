# Pipedrive CRM Autopilot (Single-Tenant)

Internal automation service for Pipedrive hygiene, follow-up control, and B2B outreach prioritization:
- Lead triage autopilot (Leads)
- Deal SLA + stale-deal nudge autopilot (Deals)
- Merge review pipeline with manual execute endpoint
- Dashboard backend endpoints (velocity, cadence, briefing, analytics, scored leads)
- Audit logging, idempotency, dry-run safety

## Stack
- Node.js + TypeScript
- Fastify (`apps/api`)
- BullMQ + Redis (`apps/worker`)
- Postgres + Prisma
- `pino`, `zod`
- `pnpm` workspaces

## Project layout
- `apps/api` Fastify webhook/admin API
- `apps/worker` BullMQ job processor
- `packages/pipedrive` API client + retry/limiter/pagination helpers
- `packages/shared` env, logger, hash/idempotency/time/queue/scoring/deep-link utilities
- `prisma` schema + migration
- `infra` docker-compose for Redis/Postgres

## Quick start
1. Copy env:
```bash
cp .env.example .env
```
2. Start infra:
```bash
docker compose -f infra/docker-compose.yml up -d
```
3. Install dependencies:
```bash
corepack pnpm install
```
4. Run migrations:
```bash
corepack pnpm prisma:deploy
```
5. Start API and worker in separate terminals:
```bash
corepack pnpm dev:api
corepack pnpm dev:worker
```

## Required env vars
- `PIPEDRIVE_API_TOKEN`
- `WEBHOOK_SECRET`
- `DATABASE_URL`
- `REDIS_URL`
- `DRY_RUN=true|false`
- `DEFAULT_TIMEZONE=UTC`
- `SLA_FUTURE_ACTIVITY_DAYS=3`
- `STALE_DAYS=7`
- `BOT_USER_ID` (optional)
- `MERGE_CONFIDENCE_THRESHOLD=0.85`
- `PIPEDRIVE_COMPANY_DOMAIN` (optional)
- `CADENCE_COLD_DAYS=7`
- `CADENCE_COOLING_DAYS=3`
- `LEAD_SWEEP_CRON="0 5 * * *"`
- `PIPELINE_ID` (optional)
- `ACTIVE_STAGE_IDS` (optional comma-separated)

## API endpoints

### Webhooks and admin
- `POST /webhooks/pipedrive`
- `POST /admin/fieldmap/refresh`
- `GET /admin/review-queue`
- `POST /admin/review-queue/:id/approve`
- `POST /admin/merge/:id/execute`
- `POST /admin/jobs/run/:name` (`slaSweep`, `leadSweep`, `staleDealNudge`)
- `GET /health`

### Dashboard backend
- `GET /admin/dashboard/velocity`
- `GET /admin/dashboard/cadence`
- `GET /admin/dashboard/briefing`
- `GET /admin/dashboard/leads`
- `GET /admin/dashboard/analytics`
- `POST /admin/dashboard/quick-action/add-activity`
- `POST /admin/dashboard/quick-action/add-note`
- `POST /admin/dashboard/quick-action/snooze`

### Webhook auth
Header must match:
- `X-Autopilot-Token: <WEBHOOK_SECRET>`

### Example webhook call
```bash
curl -X POST http://localhost:3000/webhooks/pipedrive \
  -H "Content-Type: application/json" \
  -H "X-Autopilot-Token: $WEBHOOK_SECRET" \
  -d '{"meta":{"object":"deal","action":"updated"},"current":{"id":123}}'
```

## Behavior highlights
- Idempotent webhook ingestion via payload hash (`WebhookEvent.eventHash`).
- Primary loop protection via `BOT_USER_ID` (`meta.user_id`), fallback via `[AUTOPILOT]` echo check.
- Bulk update skip via `meta.is_bulk_update`.
- Job idempotency via `IdempotencyKey` scoped per entity/day.
- Nightly SLA sweep + nightly lead sweep.
- Stale-deal nudges (7-day cooloff for repeated nudge notes).
- Merge review enforces ADR-013 safety gates and manual execution path.
- Dashboard endpoints are cached in-memory for 60 seconds (`Cache-Control: max-age=60`).
- `DRY_RUN=true` prevents remote mutation and logs planned actions to `AuditLog`.

## Tests
```bash
corepack pnpm -r lint
corepack pnpm -r test
```

Included:
- Unit tests for business-day math, hashing determinism, deep links, scoring, and webhook helpers.
- Worker tests for BOT_USER_ID and bulk-update loop protection paths.
- API integration tests for webhook dispatch and dashboard endpoint payloads.
