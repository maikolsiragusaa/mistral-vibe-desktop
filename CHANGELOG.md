# Changelog

## 0.3.0-M1.1 — Stabilization & reliability (unreleased baseline 0.3.0)

P0/P1 hardening on top of M1, no new large features, no harness changes.

- Session ownership: detached `session/fork` (`attach:false`) no longer
  consumes a worker slot or appears as owned (verified against upstream
  2.26.1: detached forks shut down server-side with `session_attached=false`).
  Unlisted fork sources fail before allocation; duplicate-id races stop the
  stray worker; rewind/continue ownership remapping covered by tests.
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
  `tools/list` as Unified `method_not_found`.
- Security review recorded in `docs/security-review-m1.1.md`; no new IPC,
  sandbox/CSP/approvals unchanged. Residual: subpath canonicalization uses
  `resolve` (same as pre-existing shell handling; Git keeps escape rejection).
- Suite: 84 tests passing (was 61). Real Electron baseline + expansion pass;
  sidebar-drag flake observed once in 6 runs (existing pointer-timing flake,
  covered by the documented single-retry policy; no timeout inflation).

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
