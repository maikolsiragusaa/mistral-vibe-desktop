# Changelog

## 0.3.0-M3 — Multi-session workspace, cloud honesty, automations & editor handoff (unreleased baseline 0.3.0)

M3 on frozen Unified 2.26.1, no merge/release. Capability matrix in
`docs/m3-capability-matrix.md`; Task-Scheduler ADR; delivery in `docs/m3-delivery.md`.

- Sessions: enriched tabs (state/worktree/model/agents/approval/detached/external),
  4-slot viewable-vs-attached explanation, per-tab scroll/inspector/draft
  preservation, canonical-cwd worktree binding, lease-aware read-only subagents.
- Worktrees: dialog-authorized custom parents (UNC/symlink/junction/perms/
  collision/repo-identity/branch/non-empty/nesting checked), final-path preview,
  per-repo preference, measured disk view, no migration/cleanup; editor/terminal
  handoff per checkout.
- Cloud: 5-step Teleport lifecycle honesty, linked projects, official picker only,
  Vibe Code Web + docs links, GitHub-App/plan delegation, no fake remote sessions.
- Loops: explicit create-then-delete replace, last-run when exposed, owner labels,
  deduped app-open-only toasts with click-to-session; Work Tasks stay hosted-only.
- Editors: VS Code/Insiders/VSCodium/Cursor detection + custom exe, structured
  launches on authorized roots, `vibe-acp` presence check, filesystem-only honesty.
- Suite: 146 tests (120 kept), tsc/build/audit green. Electron/packaging/CI +
  fresh screenshots remain the pending acceptance gate (declared, not claimed).

## 0.3.0-M2.1 — Stabilization, worktree architecture & Windows validation (unreleased baseline 0.3.0)

Red-CI-driven hardening of M2 (`a1a2fbd` broke both Windows Actions on the
obsolete read-only-worktrees assertion). No new harness, no stack change.

- CI: diagnosed the deterministic failure, replaced the stale assertion with
  real manager coverage (open, state, actions) plus creation-hygiene,
  removal-gate, Files/preview, mid-turn navigation, selection-preservation
  and five-tab render checks. Both Playwright specs pass on the real
  Electron app against harness 2.26.1.
- Worktree location (P0-A): creation moved out of the checkout into the
  app-managed space `userData/worktrees/<slug>-<sha1>[:12]/<name>`. The main
  repository never becomes dirty from a new checkout; `.gitignore` untouched;
  existing worktrees keep working; no auto-migration.
- Ownership (P0-B): `VibeBackendPool.describeWorktreeUsage()` exposes a
  frozen read-only snapshot (session, worker, active turn, subagents, lease,
  callbacks). Removal blocks on occupied or unverifiable checkouts with
  reasons; UI shows Occupied/Idle/Available/Unknown, session chips and direct
  session opening. External processes remain undetectable by design.
- Preview (P0-C): the iframe is replaced by a dedicated isolated window
  (separate partition, sandbox, no preload/Node) with loopback-only initial
  URLs and same-origin redirect/navigation guards. Adversarial tests plus
  live Electron proof (no bridge/Node inside, public redirect ends blocked).
- Git audit: per-repository mutation serialization; hunk staging refuses
  renames/deletions whole-file; identical-header twins apply deterministically
  then go stale; blocked-preview `loadURL` no longer hangs IPC.
- Architecture: `GitWorkspace.tsx` split into `git-types.ts`, `git-api.ts`
  and five panel modules; orchestrator keeps state/effects. No duplicated
  logic, no new framework.
- Suite: 120 tests passing (was 112). Build and `npm audit` clean.
  Screenshots refreshed in `docs/screenshots/`. Residual: CI must confirm
  NSIS packaging, packaged-app tests and SHA-256 on the final commit.

## 0.3.0-M2 — Git, worktrees & development workspace (unreleased baseline 0.3.0)

M2 turns Vibe Desktop into a working development workspace on the official
Unified harness (2.26.1): review agent changes, stage hunks, commit, navigate
worktrees, inspect files and prepare PRs — no second harness, no IDE fork.

- Hardening gate (M2.0): `session/compact` is never auto-probed — mounting the
  menu or opening it performs no RPC; mutative methods verify only via explicit
  user actions; capability cache is bound to the runtime version/instance with
  invalidation; official discovery only ever marks verified, never unsupported
  from the registry; unknown is the safe default. Subagent history pages
  persist across live `session/read` polling (deterministic id-deduped merge,
  per-child cursors, stale guards, 1000-entry cap, render windowing past 400
  rows). Windows paths: realpath identity everywhere, ADS/trailing-dot `.git`
  guards, symlink-to-directory rejection, repo-identity re-verification before
  every mutation (TOCTOU), sibling worktrees allowed only as explicitly
  selected independent workspaces.
- Git (M2.1): Changes groups Staged vs Working tree with search and
  staged/unstaged/conflict filters plus rename display; diff viewer with line
  numbers, unified/side-by-side, hunk collapse, hunk navigation, diff search,
  progressive rendering, binary/CRLF handling; hunk stage/unstage via
  `git apply --cached [--reverse]` with exact-match stale-guard against a
  freshly regenerated diff and verified index state (multi-hunk, concurrent
  edit, CRLF and dirty-repo tests); explicit commit composer and history.
- Worktrees (M2.2): list enriched with dirty/untracked/ahead/behind state;
  circumscribed local creation under `.worktrees/` (new branches only, never
  overwrites, never moves the session); safe-only removal (dirty, untracked,
  unpushed, locked, main or uncertain worktrees refused with reasons — never
  `--force`, `reset --hard`, `clean -fd` or directory deletion); stale
  metadata pruning. Harness audit: 2.26.1 exposes list/remove/reap/prune/
  checkouts but no creation RPC, hence the bounded local adapter.
- Explorer & preview (M2.3): lazy read-only file tree with search, recent and
  modified shortcuts plus Git badges; previews for code/text, markdown,
  JSON, images (data URLs), with binary/too-large/encoding guards and no
  file privileges; optional loopback web preview restricted to explicitly
  submitted localhost URLs inside a same-origin-less sandboxed frame — no
  command is ever launched automatically.
- PR & review (M2.4/5): PR list plus read-only details (files, checks,
  commits, description) with explicit browser opening; creation stays
  explicit via authenticated `gh` on already-published branches; Git diff and
  engine review stay visually distinct; attribution keeps baseline vs
  observed-agent-write vs unknown-source labels with a review-flow hint
  (hunks → stage → commit → PR). No approval/merge from the client.
- Suite: 112 tests passing (was 87). Production build clean, `npm audit`
  clean. Residual: Playwright Electron screenshots and NSIS packaged-app
  tests were not re-run in this iteration; multi-session worktree ownership
  display and server-start vs preview distinction remain backlog.

## 0.3.0-M1.1 — Stabilization & reliability (unreleased baseline 0.3.0)

P0/P1 hardening on top of M1, no new large features, no harness changes.

- Session ownership: detached `session/fork` (`attach:false`) no longer
  consumes a worker slot or appears as owned (verified against upstream
  2.26.1: detached forks shut down server-side with `session_attached=false`).
  Unlisted fork sources fail before allocation; duplicate-id races stop the
  stray worker; rewind/continue ownership remapping covered by tests.
  Follow-up: forks of an owned source with a live turn are rejected
  (attached and detached), matching the single-backend guard the pool would
  otherwise bypass via an idle worker.
- Subagent inspection: sync state (loading/syncing/watching/synced/stale/
  error), last-update time, non-destructive errors with manual retry, backoff
  on real errors, suspension while hidden with immediate resume, stale-response
  guards, event-triggered refresh (debounced) over public `session/read`, and
  history paging for long child transcripts. Real-engine proof: three
  concurrent fixture children opened and read while the parent works.
- Drafts: persistence is now opt-in and OFF by default (M1 default-on fixed).
  Legacy M1 drafts are surfaced once without silent deletion or re-enabling;
  Settings documents scope (unsent text only, ≤50/100 KiB) and offers explicit
  clear. Real function tests replace source-text assertions.
- Cloud preflight: Git validity from `git/status`, provider from the runtime
  inventory record (never display-name regex; GLM/custom → incompatible),
  credentials presence, tier/GitHub-App always unknown and delegated to
  Mistral. Picker opening vs transfer completion are reported distinctly.
- Loops: two-step Clear All confirmation, canonical backend ids (unidentified
  rows cannot be deleted), per-mutation pending state, interval/next-fire
  display, backend-inactive notice, malformed-payload tolerance.
- Capability detection: per-session cache distinguishing verified/
  unsupported/unknown; `session/compact` disables with an explanation when the
  engine reports not-implemented (2.26.1); auth/transport failures never become
  verdicts. `agents/list` joins `review/*`, `stats/read`, `diagnostics/list`,
  `tools/list` as Unified `method_not_found`. Follow-up: `review/state`
  verdicts are cached so the whole `review/*` family stops firing doomed
  requests after the first not-implemented answer, and Compact persists its
  unsupported verdict to the shared cache; capability entries are forgotten on
  session stop/delete.
- Security review recorded in `docs/security-review-m1.1.md`; no new IPC,
  sandbox/CSP/approvals unchanged. Residual: subpath canonicalization uses
  `resolve` (same as pre-existing shell handling; Git keeps escape rejection).
- Suite: 87 tests passing (was 61). New: pool fork blocked during a live
  source turn (attached and detached), pool rewind remap (in-place keeps
  id/owner, fork-rewind remaps to the new id on the same worker),
  duplicate-id/RPC-failure forks leave no ownership and recover on retry.
  Real Electron baseline (21.5s) + expansion (1.6m) pass; sidebar-drag now
  waits for a visible, stable handle before sampling (no timeout inflation).

## 0.3.0 — Workspace evolution M1: navigation, subagents, sessions

Foundation UX and subagent supervision on the official engine (Vibe 2.26.1).
No second harness; no fake Work/Cloud replicas.

- Code/Work selector in the titlebar and Local/Cloud scope in Code. Work is an
  explicit official-surface panel (docs, Vibe web, scheduled-tasks guidance);
  the local app-server is never presented as a Work API.
- Subagent navigation: Open subagent shows the real child conversation via
  public session/read with bounded polling, breadcrumb parent/child, read-only
  notice and easy return. The parent keeps working. Inspect snapshot is kept
  for compatibility.
- Session tabs distinguish close (detach, keeps running) from stop/archive/
  delete. Tab close never interrupts silently; running turns block detach.
- Session operations through official RPC: fork, rewind (in-place vs
  fork-rewind with confirmation), rename, markAsSeen, compact, history/clear,
  relocate, delete, export. Backend and pool enforce listed-project scope,
  read-only children and active-turn guards.
- Durable unsent drafts across full restart via renderer localStorage with
  explicit opt-in (Settings). No second session journal; history stays in Vibe.
- Code scheduled loops GUI (loops/create|list|delete|clear) with honesty about
  backend-liveness. Cloud panel uses projectLinks/* and vibeCode/* with
  one-way Teleport preflight (Git repo, Mistral model, API key, Medium 3.5
  destination, 24h/3h/30s limits). No bidirectional sync is promised.
- Backend allowlist expanded to ~60 official methods (session lifecycle,
  loops, projectLinks, vibeCode/teleport, extended worktrees, skills
  lifecycle, mcp/tools/agents, diagnostics/logs, shell, prompt/prepare,
  review/revert). Live conformance: loops/*, markAsSeen, rename, turns/list,
  skills/versions|updates, mcp/refresh, settings/update OK; review/*,
  stats/read, diagnostics/list, tools/list return method_not_found on Unified;
  session/compact is not implemented upstream; vibeCode requires a Git repo.
- 61-test suite (56 existing + 5 new) passes; TS + production bundling pass.
  Real Electron baseline (22.2s) and expansion (1.6m) scenarios pass with the
  frozen backend and loopback fixtures. Packaging/installer remains an M5 gate.

Remaining for M2–M5: Git hunk staging, managed worktree navigation with
user decisions, file preview, skill registry UI, stdio MCP editor, Windows 11
clean-machine install/uninstall, hosted account conformance and signed
distribution. See backlog and capability matrix.

## 0.2.0 — Windows workspace expansion

The workspace now supports concurrent sessions and a complete local Git flow.
Management opens in a dedicated window while the conversation stays available.

- Integrated Windows titlebar with native controls, theme colors and a Windows
  11 Mica path with solid fallback.
- Warm light/dark surfaces, compact controls, finite transitions and the optional
  original Ember pixel companion. Reduced-motion preferences are respected.
- Searchable configured-model picker, provider/API metadata, allowed inventory,
  GLM recognition and supported reasoning levels.
- Four independently owned sessions, native pin/archive and leases, queue and
  steering, session drafts and backend-crash recovery.
- Images and text attachments, clipboard/drop handling, previews and removal;
  IME-aware composer, prompt recall and command palette.
- Scoped Git status/diffs, staging/unstaging, commits, history and read-only
  worktrees. GitHub PR inspection/creation reuse installed `gh` authentication.
- MCP catalogue, tools, refresh, toggles, HTTP OAuth-source configuration and
  removal; installed skills, instructions and toggles; plugin discovery.
- Provider/model configuration through official config methods, with credential
  persistence delegated to Vibe.
- Upstream delegated browser-auth controller bridge, including frozen packaging.
- Context donut, measured input/output partitions and token totals; runtime
  diagnostics and official quota pages.
- Direct reasoning-level picker, public thinking/activity feedback, draggable
  sidebars, compact titlebar MCP status and expanded tool-result cards.
- Shared compact popovers for model, agent mode and reasoning, with direct
  selection and keyboard controls. The context sidebar starts closed; Git
  toggles back to the conversation without a separate Chat header button.
- Context usage opens in a compact card anchored above its ring, preserving
  measured partitions and cumulative session counts without a modal backdrop.
- Subagent identity, task, duration, output and parent-authorized child history.
- On-demand secondary bundles, bounded Git output and process-tree measurements.

The [capability matrix](docs/capabilities.md) documents remaining desktop and
upstream limits. [Validation](docs/validation.md) records executed checks.

## 0.1.0 — Official-engine feasibility

Introduced the Windows Electron client, selected local projects, official Vibe
stdio transport, streaming, trust and callbacks, saved-session resume, shell
output, sandboxed renderer and pinned Python/native backend packaging.
