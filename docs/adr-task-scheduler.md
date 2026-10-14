# ADR: Windows Task Scheduler for unattended local execution (M3 decision)

Status: **Decided — not shipped in M3.** Revisit only with explicit user consent and a full lifecycle design.

## Context

Code Loops (`loops/*`) are session-scoped recurrences that fire only while their session backend runs. Work scheduled tasks are Mistral-hosted Workflows, managed in Vibe Work (Tasks → Scheduled). A Windows-native unattended runner (Task Scheduler launching a headless loop while the desktop is closed) was evaluated as a possible M3 automation gap.

## Decision

Do **not** introduce Windows Task Scheduler as a concurrent execution system in M3.

- No background launcher, scheduled-task registration, or headless credential use is shipped.
- Loops honesty is preserved in UI copy: "Loops fire only while this session's backend runs."
- Work tasks are never mirrored locally; the Work panel links to the official surface + docs.

## Consequences

- Notifications never promise delivery with the app fully closed.
- No unattended budget, logging, recovery, or machine-off semantics are owed in M3.
- If a future unattended-local mode is ever proposed, it requires all of: explicit opt-in consent, credential boundary (Vibe keyring custody, no exported secrets), defined start/stop lifecycle, budget/limits, logging, machine-off behavior, crash recovery, and repository authorization review — plus a security audit and adversarial tests before shipment.

## Alternatives considered

- **Ship a Task Scheduler bridge now:** rejected — creates a second scheduler beside Vibe loops/Work tasks, widens credential and filesystem exposure, and contradicts the "no second harness/scheduler without demonstrated need" mandate.
- **Silent cleanup/quota for worktrees:** rejected for the same reason — disk policy must be explicit, never a silent background deleter (M3 ships measured disk view + explicit removal only).
