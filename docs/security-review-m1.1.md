# Security review — M1.1 (0.3.0 stabilization)

Scope: the ~60-method allowlist introduced in M1 (`src/main/backend.js`
`PARAM_KEYS`, `src/main/backend-pool.js` routing) plus the M1.1 fixes. No new
IPC channels: renderer calls still go through `vibe:request` / `vibe:git`.
Sandbox, context isolation and renderer CSP are untouched. No approvals or
sandbox behavior were changed to make tests pass.

## Method-by-method posture

| Surface | Policy | Verdict |
| ------- | ------ | ------- |
| `session/start|resume|continue` | `agentConfig` allowlisted to `{cwd, agent}`; cwd must be a chosen project; pool serializes allocation under a cap of 4 | Safe |
| `session/fork` | Source must be listed for a chosen project; read-only children rejected in backend and pool; active-turn guard on the source (pool and single backend agree, M1.1 follow-up); `attach:false` is host-routed with no worker/ownership (M1.1 fix) | Safe |
| `session/rewind` | Listed, non-child source; active-turn guard; fork-rewind remaps ownership on the same worker; in-place is destructive and UI-gated behind an explicit fork-vs-inplace choice | Safe, UI-confirmed |
| `session/delete` | Rejected while attached/owned (`Stop this session before deleting it`); otherwise host-deleted only for listed sessions | Safe |
| `session/history/clear` | Active-session only; **not exposed in the desktop UI** (no button), so no accidental trigger exists | Safe (backend-only) |
| `session/compact` | Probed per session; UI disables with an explanation when the engine reports not-implemented | Safe |
| `session/rename|title/update|pin|archive|markAsSeen` | Listed-session metadata only; children excluded | Safe |
| `session/relocate` | cwd must be a chosen project (exact) | Safe |
| `loops/*` | `interval`/`prompt` bounded; single delete uses canonical backend ids only (no index fallback); Clear All is two-step confirmed with pending state | Safe |
| `projectLinks/*` | `rootPath` must be a selected project; ids bounded strings | Safe |
| `vibeCode/*`, teleport | UI opens the official picker only and never claims completion; preflight states are verified/incompatible/unknown with delegation to Mistral | Safe (no fake sync) |
| `workspace/git/worktrees/remove|reap` | cwd constrained to the selected project subtree; destructive UI remains read-only in GitWorkspace (no remove button shipped) | Safe, UI not exposed |
| `skills/*` lifecycle | Name/scope allowlisted, version positive int; full import/remove UI deferred to M4 (backend-validated only) | Safe (backend-only) |
| `mcp/add|toggle|login|logout` | HTTPS-only Massenmedien, insecure HTTP rejected, scopes ≤ 32, toggle sources restricted | Safe |
| `shell/run|interrupt`, `session/shellCommand` | Command ≤ 32 KiB, cwd project-scoped, timeout ≤ 600 s, existing 4 MiB output cap unchanged | Safe |
| `config/write` | Existing target-layer gating (`config/fields/read` first) and credential-field rejection unchanged | Safe |
| `session/context/inject`, `workspace/prompt/prepare` | Active-session only, RPC size cap applies; renderer cannot set injected-skill flags (rejected) | Safe |
| Reads (`session/read|history/*|turns|ready|log|backgroundProcess/output`) | Listed-session scope incl. read-only children via parent owner; no mutation | Safe |

## Known residual (not new in M1.1)

- Subpath authorization (`allowSubdirectory`) canonicalizes with `path.resolve`,
  not `realpath`: a symlink inside the project pointing outside passes the
  prefix check. Same posture as the pre-existing shell-cwd handling; Git
  mutations keep their own symlink-escape rejection (`git-service.js`). A
  realpath-based hardening is backlog for M2.
- Lease races: operations on foreign-held sessions are identified, not taken
  over; destructive actions require attachment, so a lease loss mid-flow fails
  closed (typed error, no silent cross-session write).
- Drafts may contain user-pasted secrets by nature of unsent text; storage is
  local-only, opt-in, documented in Settings, with explicit clear.

## Invariants verified by tests

- `tests/session-lifecycle.test.js`: detached forks consume no worker/slot,
  failures change no ownership, concurrent forks stay under the cap with
  distinct owners, live deletes rejected, rewind/continue remap correctly.
  Follow-up: forks of a live-turn source rejected, fork-rewind remap checked
  explicitly, duplicate-id/RPC-failure forks verified ownership-free with
  retry recovery.
- `tests/subagents.test.js`: children readable only, resume/steer rejected.
- Full suite: 87 passing at M1.1 close.
