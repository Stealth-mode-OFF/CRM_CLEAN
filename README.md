# Pipedrive CRM Autopilot (Single-Tenant MVP)

Internal automation service for Pipedrive hygiene and actionability:
- Lead triage autopilot (Leads)
- Deal SLA autopilot (Deals)
- Field map refresh + review queue endpoints
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
- `packages/shared` env, logger, hash/idempotency/time/queue utilities
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
- `PIPELINE_ID` (optional)
- `ACTIVE_STAGE_IDS` (optional comma-separated)

## API endpoints
- `POST /webhooks/pipedrive`
- `POST /admin/fieldmap/refresh`
- `GET /admin/review-queue`
- `POST /admin/review-queue/:id/approve`
- `POST /admin/jobs/run/:name` (`slaSweep` supported; `leadSweep` helper mode)
- `GET /health`

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
- Job idempotency via `IdempotencyKey` scoped per entity/day.
- SLA enforcement for open deals: if no future activity, create follow-up (+2 business days) and explanatory note.
- Lead triage enforcement: create qualification action when key signals are missing or near-term qualification activity is absent.
- Loop protection via `[AUTOPILOT]` fingerprint + recent-touch echo short-circuit.
- `DRY_RUN=true` prevents remote mutation and logs planned actions to `AuditLog`.

## Tests
```bash
corepack pnpm -r lint
corepack pnpm -r test
```

Included:
- Unit tests for business-day math, hashing determinism, and future-activity checks.
- Integration test: webhook -> queue dispatch -> SLA enforcement in dry-run.
