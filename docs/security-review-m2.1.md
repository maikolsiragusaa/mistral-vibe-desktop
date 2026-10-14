# Security review — M2.1: stabilization, worktree architecture, preview isolation

Date: 2026-10-14. Scope: full M2 surface after the red CI on `a1a2fbd`.

## P0-A — worktree location (confirmed bug, fixed)

Creating checkouts under `<repo>/.worktrees/` polluted Changes with untracked
noise and agent file watches. Creation now targets the app-managed space
`userData/worktrees/<slug>-<sha1(root)[:12]>/<name>`: outside every checkout,
per-repository (hash), readable (slug), bounded depth. The shared `.gitignore`
is untouched; pre-existing worktrees anywhere keep working for list/remove;
nothing is migrated or deleted automatically. Verified: main HEAD unchanged,
no `.worktrees` debris, branch correct, path canonical (unit + Electron).

## P0-B — removal vs sessions (confirmed gap, fixed)

Git-clean no longer implies free. `VibeBackendPool.describeWorktreeUsage()`
returns a frozen read-only snapshot (session ids, cwd placement, attached,
active turn, pending callbacks, lease, subagent parent) without exposing
internal maps. `removeWorktree` blocks on occupied sessions, unverifiable
ownership (missing provider, failures, unplaceable active turns/callbacks),
then the Git guards. UI shows Occupied/Idle/Available/Unknown with reasons,
session chips and direct session opening. Boundary: processes outside the
app (terminals, other Git clients) are undetectable and documented.

## P0-C — preview navigation (confirmed gap, fixed)

A sandboxed iframe cannot enforce redirect policy, so the iframe was replaced
by a dedicated `BrowserWindow` (`persist:vibe-local-preview`, sandbox, no
preload, no Node, hardened `webSecurity`), loopback-only initial URLs,
same-origin navigation guards (`will-navigate`/`will-redirect` → explanatory
block page), `window.open` denied, permissions denied, dead servers → error
page with manual reload. Nothing launches automatically. Adversarial unit
tests: public/LAN/IPv6-mapped/file:/data:/javascript:/credential/encoded
hosts, cross-port and cross-host redirects. Electron test: isolated window
has no `window.vibe`/`window.require`; `/go` → `example.com` ends on the
block page.

## Git service adversarial audit (this round)

- Confirmed & fixed: concurrent mutations interleave on `index.lock` → per-
  repository serialization (`#serializeMutation`; reads unaffected). Hunk
  staging on renames/deletions → refused whole-file (patch lacks rename
  headers; partial deletion staging is surprising). Identical-header twin
  hunks → single deterministic apply at header coordinates, second request
  goes stale (safe). `loadURL` hang on blocked redirects → fire-and-forget
  with guard pages.
- Reviewed, no change: index-lock crashes surface as errors (no lock
  deletion); bare repos resolve to non-repository (safe); submodules stage/
  diff as Git reports them without special-casing; stash is out of scope
  (no stash UI, never touched); UNC/drives/ADS/trailing-dots/case covered
  by existing guards+tests; `gh` output capped at 1 MiB and schema-checked.
- Limits: TOCTOU narrowed (resolve → lock → re-verify → spawn), not
  eliminated against hostile local actors; `git worktree list` output is
  trusted then re-canonicalized per item; CRLF round-trips through Git's own
  diff; oversized diffs refuse hunk staging (whole-file only).

## Renderer architecture

`GitWorkspace.tsx` (2118 lines) split into `git-types.ts`, `git-api.ts` and
`panels/{Changes,Files,History,Worktrees,PullRequests}Panel.tsx`; the
orchestrator keeps state/effects/operations. No logic duplicated, no new
state framework. Regression: tsc, 120 unit tests, both Playwright specs.

## Verification

- 120/120 unit tests, production build, `npm audit` clean.
- `expansion.spec` (Electron, real harness 2.26.1): worktree manager,
  creation hygiene, dirty-removal refusal, Files + read-only preview,
  isolated preview + redirect block, mid-turn Git navigation, selection
  preservation, five-tab render. `desktop.spec` green.
- Screenshots in `docs/screenshots/` (worktrees, worktree-blocked,
  file-preview, web-preview, git-diff, dark/light, narrow).
- CI (push + PR) must confirm packaging NSIS, packaged-app tests and
  SHA-256; installer artifacts were not produced locally in this round.
