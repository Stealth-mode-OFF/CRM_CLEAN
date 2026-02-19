# DECISIONS

Architecture Decision Records (ADR-lite) for the Pipedrive CRM Autopilot project.

## 2026-02-18

### ADR-001: Package manager — pnpm workspaces
- **Context**: Need monorepo support for `apps/*` and `packages/*` with hoisted deps and workspace protocol.
- **Decision**: `pnpm` workspaces with `workspace:*` protocol for internal deps (`corepack pnpm` for environments without global pnpm).
- **Rationale**: Fast installation, strict dependency resolution, first-class workspace support.

### ADR-002: Runtime — tsx for development
- **Context**: Need to run TypeScript directly without a build step during development.
- **Decision**: Use `tsx` (esbuild-based) for `dev` scripts; `tsc --noEmit` for type checking only.
- **Rationale**: Near-instant startup, watch mode, no compiled output to manage.

### ADR-003: Queueing — single BullMQ queue with named jobs
- **Context**: Multiple job types need reliable async processing.
- **Decision**: Single BullMQ queue (`autopilot`) with named jobs and shared constants.
- **Rationale**: Simpler topology; job routing via `dispatchJob` keeps all logic in one place.

### ADR-004: DRY_RUN defaults to true
- **Context**: The service creates activities and notes in a production CRM. Accidental mutations are hard to undo.
- **Decision**: `DRY_RUN=true` by default in `.env.example`. All planned actions are written to `AuditLog` with `dryRun: true` in `afterJson`.
- **Rationale**: Safe-by-default deployment. Operators must explicitly opt in to live mutations.

### ADR-005: Idempotency via scope+key+day
- **Context**: Webhooks can fire multiple times; nightly sweeps re-scan the same deals.
- **Decision**: `IdempotencyKey` table with `@@unique([scope, key])` where key includes entity ID and YYYY-MM-DD.
- **Rationale**: Each entity is processed at most once per day per job type. Stale keys naturally age out.

### ADR-006: Loop protection — autopilot echo detection
- **Context**: Creating notes/activities via API triggers new webhooks that could cause infinite processing loops.
- **Decision**: All autopilot-created content is prefixed with `[AUTOPILOT]`. Before processing a webhook, the worker checks whether recent notes (within 10 minutes) carry this prefix and short-circuits if so.
- **Rationale**: Deterministic and simple to verify; no external flag or coordination needed.

### ADR-007: Pipedrive API — v2-first with v1 fallback
- **Context**: Pipedrive is migrating to v2 API; not all entities have v2 endpoints yet.
- **Decision**: Client tries v2 endpoints first, catches 404, and falls back to v1 for unsupported entities. Prefer v2 for leads, deals, fields, cursor pagination. Use v1 for activities, notes, persons/orgs, and webhook CRUD.
- **Rationale**: Automatic migration path as Pipedrive adds v2 support; no code changes needed when v2 lands for remaining entities.

### ADR-008: Rate limiting and fair-usage controls
- **Context**: Pipedrive enforces API rate limits; bursts can cause 429s and degraded performance.
- **Decision**: Client limiter via Bottleneck (`maxConcurrent=5`, `minTime=200ms` ≈ 5 req/sec). Retry policy for transient errors (`429`, `502`, `503`, `504`) with exponential backoff up to 5 attempts.
- **Rationale**: Stays well within Pipedrive's rate limits; automatic recovery from transient failures.

### ADR-009: Review queue — merge deferred in MVP
- **Context**: Merge operations (duplicate resolution) are high-risk and require careful validation.
- **Decision**: Review queue approval endpoint updates status and enqueues merge job, but merge execution itself is explicitly deferred and audit-logged only.
- **Rationale**: Preserves the full event/queue flow for future implementation while avoiding risky automated merges in the first release.

### ADR-010: Webhook deduplication via stable hash
- **Context**: Pipedrive may deliver the same webhook event more than once.
- **Decision**: Compute a SHA-256 hash over the sorted payload (`stableHash`), store it in `WebhookEvent.eventHash` (unique), and reject duplicates at the API layer.
- **Rationale**: Content-addressed dedup is robust regardless of delivery timing or ordering.

### ADR-011: Prisma for database access
- **Context**: Need typed database access with migration support.
- **Decision**: Prisma ORM with PostgreSQL.
- **Rationale**: Strong TypeScript integration, declarative schema, auto-generated migrations, and straightforward query API.

### ADR-012: Single-tenant design
- **Context**: This service serves one Pipedrive account.
- **Decision**: No multi-tenancy abstractions. One API token, one database, one worker.
- **Rationale**: Simplest correct implementation for the current use case. Multi-tenant can be layered later if needed.

### ADR-013: Merge safety policy (post-MVP)
- **Context**: Merge operations (duplicate person/org resolution) are the highest-risk CRM automation — data loss is irreversible.
- **Decision**: When implementing `mergeReviewJob`, enforce these acceptance rules before executing any merge:
  1. **Confidence score** — Duplicate match must exceed configurable threshold (email exact match + org name fuzzy ≥ 0.85).
  2. **No open deals on loser** — If the merge-target entity has open deals, route to human review instead of auto-merging.
  3. **Activity preservation** — Verify Pipedrive merge API preserves activities/notes from both records.
  4. **Cooldown window** — Don't merge entities created or modified in the last 24 hours (avoid merging mid-import).
  5. **Dry-run first** — Log planned merge to `AuditLog` with full before-state of both records, hold for 1 hour or require manual `/admin/merge/:id/execute` trigger.
- **Rationale**: Merge mistakes are unrecoverable. Multi-layer gates ensure confidence before destructive action.

### ADR-014: Bot user ID for primary loop protection (post-MVP)
- **Context**: Current loop protection relies on detecting recent `[AUTOPILOT]` notes within a 10-minute echo window. This works but involves extra API calls and has a timing assumption.
- **Decision**: Add optional `BOT_USER_ID` env var. When set, `processWebhookEventJob` checks `meta.user_id` from the webhook payload and short-circuits immediately if it matches the bot user. The note-based echo check becomes a fallback.
- **Rationale**: `meta.user_id` is authoritative and zero-cost to check. Eliminates the API call to list notes and removes the timing window assumption. Falls back gracefully when `BOT_USER_ID` is not configured.

## 2026-02-19

### ADR-015: Dashboard backend-first rollout
- **Context**: `CODEX_PROMPT.md` requires a large dashboard feature set, but this repository currently contains API/worker/shared packages only.
- **Decision**: Implement all requested dashboard backend capabilities (`velocity`, `cadence`, `briefing`, `leads`, `analytics`, quick actions) and expose data contracts for UI, while marking frontend rendering tasks as blocked in `TODO.md`.
- **Rationale**: Preserves delivery momentum without inventing an unsupported frontend package in this codebase.

### ADR-016: 60-second in-memory cache for dashboard endpoints
- **Context**: Dashboard routes aggregate multiple Pipedrive reads and are requested frequently.
- **Decision**: Add API-local in-memory cache (`Map`) with 60s TTL and `Cache-Control: max-age=60` headers for dashboard endpoints.
- **Rationale**: Reduces Pipedrive load and response latency with minimal operational complexity.

### ADR-017: Merge execution verification by artifact counts
- **Context**: ADR-013 requires activity/note preservation checks during merge execution.
- **Decision**: Before merge, capture source+target activity/note counts; after merge, verify target counts are not lower than the pre-merge sum. Reject execution if check fails.
- **Rationale**: Provides deterministic safety validation using currently available API surfaces without requiring event-history reconstruction.

### ADR-018: Nightly lead sweep as first-class job
- **Context**: Lead sweep existed only as manual helper mode and not as named scheduled work.
- **Decision**: Add `leadSweep` to shared job names, schedule it nightly via `LEAD_SWEEP_CRON`, and persist run stats in `JobRun`.
- **Rationale**: Improves observability, explicitness, and operational parity with SLA sweep.
