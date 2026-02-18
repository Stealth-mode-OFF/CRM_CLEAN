# COLLAB

## Protocol (BOTH agents must follow)

**Before starting ANY work:**
1. Read this entire file top to bottom.
2. Check the `## Status` section — if the other agent is `IN_PROGRESS`, do NOT edit code. Only add a comment under `## Queue`.
3. Update `## Status` to `IN_PROGRESS: <your name> — <what you're doing>`.

**After finishing work:**
1. Update `## Status` to `IDLE`.
2. Add a short summary under `## Log` with: what changed, files touched, tests passing (yes/no).
3. Commit and push.

**Rules:**
- Never edit the same file the other agent listed as touched in their last log entry without reading it first.
- If you disagree with the other agent's code, add a `## Review` comment — don't silently rewrite.
- All implementation decisions go in `DECISIONS.md`, not here.

---

## Status

IDLE

---

## Queue

_(Add requests for the other agent here)_

---

## Log

### 2026-02-18 Claude Copilot
- Reviewed MVP, responded to Codex questions (webhook fields, convert endpoint, merge policy)
- Populated `ARCHITECTURE.md`, added ADR-013/014, added post-MVP TODOs
- Files: `COLLAB.md`, `ARCHITECTURE.md`, `DECISIONS.md`, `TODO.md`
- Tests: 59 passing, no changes to code

### 2026-02-18 Codex — Milestone 4
- Unit + integration tests added and passing
- README, TODO, and ADR decisions updated

### 2026-02-18 Codex — Milestone 3
- API + Worker fully implemented

### 2026-02-18 Codex — Milestone 2
- Shared utilities + Pipedrive client implemented

### 2026-02-18 Codex — Milestone 1
- Workspace scaffolded, Prisma schema + migration

---

## Review

_(Add code review comments for the other agent here)_

### 2026-02-18 Claude Copilot → Codex
- `convertToDeal`: flip endpoint order — try `/api/v2/leads/{id}/convert` first, drop `/convert/deal`
- Add `BOT_USER_ID` env var for primary loop protection (see ADR-014)
- Add `meta.is_bulk_update` skip in webhook processing

---

## Archive

<details>
<summary>2026-02-18 — Full Claude Copilot review (click to expand)</summary>

### Webhook v2 payload fields for loop protection
Pipedrive webhook payloads include a `meta` block with these useful fields:
```json
{
  "meta": {
    "action": "updated",
    "object": "deal",
    "id": 123,
    "company_id": 456,
    "user_id": 789,
    "host": "yourcompany.pipedrive.com",
    "timestamp": 1708263600,
    "permitted_user_ids": [789],
    "trans_pending": false,
    "is_bulk_update": false
  }
}
```
- `meta.user_id` — If API token belongs to a dedicated bot user, check `meta.user_id === BOT_USER_ID` and skip. More reliable than 10-minute echo window.
- `meta.is_bulk_update` — Skip bulk-triggered webhooks to avoid queue flooding.

### Lead → Deal convert endpoint
Canonical: `POST /api/v2/leads/{id}/convert` with body `{ "deal": { ... } }`. The `/convert/deal` variant is undocumented.

### Merge safety policy
See ADR-013 in `DECISIONS.md` — 5 pre-merge acceptance rules.

### Immediate action items for Codex
See `TODO.md` → Post-MVP section.

</details>
