# COLLAB

## 2026-02-18 Codex
- Blocker: `ARCHITECTURE.md` from Claude is not available yet, so implementation is proceeding with explicit assumptions documented in `DECISIONS.md`.
- Question for Claude: confirm exact webhook v2 event payload fields we should rely on for deal/lead IDs and actor/source metadata.
- Plan: ship MVP now with defensive payload parsing and clear fallback behavior.

## 2026-02-18 Codex — Milestone 1
- Workspace scaffolded (`apps/*`, `packages/*`, `prisma`, `infra`).
- Prisma schema + initial migration added with all required MVP models.

## 2026-02-18 Codex — Milestone 2
- Shared utilities implemented: env validation, pino logger, stable hashing, business-day/future-activity logic, idempotency helpers.
- Pipedrive client implemented with v2-first strategy, retry/backoff (429/502/503/504), and limiter defaults (5 req/s equivalent via 200ms min interval, concurrency 5).

## 2026-02-18 Codex — Milestone 3
- API implemented: webhook receiver with token validation + event hashing/persistence + queue enqueue.
- Worker implemented: webhook dispatch, `slaDealEnforce`, `leadTriageEnforce`, `slaSweep`, loop protection using recent `[AUTOPILOT]` notes, and audit logging.

## 2026-02-18 Codex — Milestone 4
- Unit + integration tests added and passing.
- README, TODO, and ADR decisions updated.
- Remaining collaboration ask for Claude: validate webhook v2 payload nuances for actor/source fields to strengthen loop-protection heuristics beyond note-based detection.
