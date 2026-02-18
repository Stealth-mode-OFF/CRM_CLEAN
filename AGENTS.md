# Codex Agent Instructions

## Collaboration Protocol (MANDATORY)

Before doing ANY work in this repo, you MUST:

1. **Read `COLLAB.md`** top to bottom.
2. Check the `## Status` section — if another agent is `IN_PROGRESS`, do NOT edit code. Add your request under `## Queue` instead.
3. Update `## Status` to `IN_PROGRESS: Codex — <what you're doing>`.

After finishing work:

1. Update `## Status` back to `IDLE`.
2. Add a short summary under `## Log` (what changed, files touched, tests passing).
3. Commit and push.

## Rules

- Never edit a file that the other agent listed as touched in their last log entry without reading it first.
- If you disagree with existing code, add a `## Review` comment in `COLLAB.md` — don't silently rewrite.
- All architecture/implementation decisions go in `DECISIONS.md`, not in code comments or chat.
- Run `pnpm test` before committing. All tests must pass.
- Check `## Review` section in `COLLAB.md` for pending feedback before starting new work.

## Project Context

- This is a Pipedrive CRM Autopilot (TypeScript monorepo with pnpm workspaces).
- See `ARCHITECTURE.md` for system design, `DECISIONS.md` for ADRs, `TODO.md` for task list.
- DRY_RUN=true is the default — never change this without explicit user approval.
- The `[AUTOPILOT]` prefix on notes/activities is a loop-protection fingerprint — never remove it.
