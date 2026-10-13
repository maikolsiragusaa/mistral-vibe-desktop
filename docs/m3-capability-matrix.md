# M3 capability matrix — Mistral Vibe Unified 2.26.1 (frozen)

Date: 2026-10-13 · Runtime: Mistral Vibe Unified 2.26.1 (`4ae5c5955da8e761318916bdb1a7f46f0b50c7d0`) · No runtime upgrade performed.
Method: registry inspection of `src/main/backend.js` PARAM_KEYS (mirrors upstream protocol), live conformance notes from `docs/upstream-gaps.md` (13 Oct 2026, no model calls), and client allowlist review. No private endpoints probed, no authenticated page scraping.

Legend — **Supported**: implemented and verified live or via real-engine test. **Declared**: in protocol/allowlist but not verified working. **Unavailable**: verified `method_not_found` / `not implemented` on Unified. **Official external**: only via official web/CLI/editor surface. **Unknown**: not verifiable with current permissions/resources.

## session/*

| Method | Verdict | Evidence |
| --- | --- | --- |
| session/list, start, resume, continue, read, stop, delete | Supported | Pool + lifecycle tests, real-engine streaming/interrupt/resume |
| session/turns/list, history/list, history/get, rewind/read, ready/read, ready/wait, log/read, backgroundProcess/output | Supported (read path) | Pool SESSION_READ_METHODS routes to owner/parent/primary; subagent history paging verified |
| session/fork (attach:true/false), rewind, relocate, rename, title/update, pin, archive, markAsSeen, delete | Supported | Pool fork/replace/ownership tests; detached forks persist without worker |
| session/lease/subscribe + lease_holder projection | Supported | Read-only external-lease presentation; removal blocked when leaseHeld |
| session/turn/enqueue, queue/read, queue/remove, queue/replace, queue/resume, queue/steer, turn/start, turn/interrupt, turn/steer | Supported | Native queue GUI + interruption with expectedTurnId |
| session/compact | Unavailable | Upstream `not implemented`; UI never auto-probes (explicit-only) |
| session/history/clear, history/get on fresh sessions | Declared/Unknown | Present in registry; fresh-session `session-not-found` observed; destructive — never auto-probed |
| session/settings/update | Supported | Live conformance OK |
| session/shellCommand, shell/run, shell/interrupt | Supported | Backend worker execution path |
| session/agent/update, agents/list | Declared (agents/list `Method not found` on Unified; inventory via runtime/read) | See upstream-gaps |
| session/context/inject | Declared | In registry; not exercised by desktop automation |

## loops/*

| Method | Verdict | Evidence |
| --- | --- | --- |
| loops/create, loops/list, loops/delete, loops/clear | Supported | Live: `list→{loops:[]}`, `create→{intervalSeconds,nextFireAt}`, `clear→OK`; GUI with canonical-id deletes + two-step Clear All |
| loops/update, loops/pause, loops/resume | Unavailable | Absent from registry and Unified dispatch; desktop offers explicit replace (create-then-delete) only, never presented as atomic update |
| Loop firing semantics | Supported (bounded) | Session-scoped; pauses when backend stops. No unattended-service claim |

## projectLinks/*

| Method | Verdict | Evidence |
| --- | --- | --- |
| projectLinks/list | Supported | Session-less OK; Cloud panel lists linked projects |
| projectLinks/create, link, unlink, save, inspectRoot, resolveRoot, picker/load, picker/loadMore | Declared | In allowlist; desktop uses list + official picker, does not invent remote state |

## vibeCode/* (Code Web / Teleport)

| Method | Verdict | Evidence |
| --- | --- | --- |
| vibeCode/projects/open (+loadMore/create/select/unlink/cancel/recover) | Supported (picker only) | Official picker opened via session flow; opening ≠ transfer completion |
| vibeCode/teleport/start, cancel, push/respond | Declared | In allowlist; desktop never auto-drives them — transfer completes in Vibe Code Web under Mistral/GitHub custody |
| Cloud session list, remote streaming/control, sandbox mutation, cost/quota APIs, bidirectional Teleport | Unavailable | No public app-server API; UI never fakes remote sessions |
| Teleport preflight (Git repo via git/status, provider-record model check, credentials) | Supported | Local verification only; tier/GitHub-App always unknown by design, delegated to Mistral |
| Vibe Code Web navigation, GitHub App setup, auth requirement messaging | Official external | Secure `openExternal` to docs + `https://mistral.ai/*` Work/Code surfaces |

## workspace/git/* (local Git service + upstream worktrees)

| Method | Verdict | Evidence |
| --- | --- | --- |
| Local git-service: status/diff/log/stage/unstage/hunk/commit/listDirectory/readFile/PR via `gh` | Supported | Path-hardened, serialized, bounded; 120 backend tests |
| workspace/git/worktrees/list, limit/update, prune, reap, reap/cancel, remove, checkouts | Supported (list/remove/reap/prune) | Upstream-owned lifecycle; desktop delegates removal guard to `describeWorktreeUsage()` |
| Worktree creation RPC | Unavailable | Harness 2.26.1 exposes list/remove/reap/prune/checkouts only — creation is a circumscribed local `git worktree add` (M2.1 managed space; M3 adds user-chosen dirs) |
| review/*, stats/read, diagnostics/list, tools/list | Unavailable on Unified | Live `method_not_found`; legacy handler implements review/* but default adapter does not dispatch |

## Subagents / backend workers

| Capability | Verdict | Evidence |
| --- | --- | --- |
| tools.subagent.spawn/wait + run_typescript Unified fixture path | Supported | Three concurrent fixture children with independent readable transcripts |
| Child session read via parent owner (session/read + backoff, hidden-suspend, stale guards) | Supported | Read-only; no direct child commands, no ownership transfer |
| agents/list | Unavailable (use runtime/read) | `Method not found` on Unified |

## ACP / editors

| Capability | Verdict | Evidence |
| --- | --- | --- |
| App-server desktop resources | Supported | Richer Vibe-specific surface; desktop uses it |
| Upstream `vibe-acp` in editors | Official external | Detected/launched by editors, not by desktop; no second ACP server runs in app |
| Editor handoff (open folder/file/line in VS Code family) | Supported (M3, local) | Filesystem handoff only — same worktree ≠ same agent session; no session-sharing claim |

## Work / automations (hosted)

| Capability | Verdict | Evidence |
| --- | --- | --- |
| Work scheduled tasks list/manage via local app-server | Unavailable | No public RPC; desktop links to Tasks → Scheduled + docs, never mirrors remote tasks |
| Code Loops vs Work Tasks distinction | Supported (UX) | Loops = local recurrences bound to backend; Tasks = Mistral-hosted Workflows; never falsely synced |
| Windows Task Scheduler unattended execution | Unknown/ADR only | No concurrent scheduler shipped in M3; see `docs/adr-task-scheduler.md` |

## Runtime upgrade policy

Frozen at 2.26.1. An upgrade requires: (1) motivation, (2) exact pin, (3) compatibility diff, (4) regression run (120 + M3 tests, tsc, build, Playwright real-engine, packaged-app), (5) rollback (previous pin + backend hash). No upgrade performed in M3.
