# M3 delivery report — multi-session workspace, cloud honesty, automations, editor handoff

Branch: `codex/windows-client` · PR #1 · **no merge to `main`, no release, no upstream modification.**
Runtime: official Mistral Vibe Unified **2.26.1 frozen** (no upgrade, no paid cloud sessions created, no end-to-end Teleport completed).

## Final commit

- Recorded by the closing commit on `codex/windows-client` (see `git log --oneline -5` at delivery time). Tree builds on checkpoint `af136ed7c08a147502471dd04faeb5829af38d25` (M2.1 concluding green CI).

## Architecture & decisions

- **No new harness / cloud provider / ACP server / independent scheduler.** All agent execution, session persistence, trust and credentials stay with the official `vibe-app-server` + Unified harness. The pool cap (4 owned connections) and session ownership remain the backend's responsibility.
- **Project → Repository → Worktree → Session → Agent/Subagents** is a conceptual hierarchy bound by canonical `cwd` (never branch-name guesses). The sidebar stays compact: enriched session tabs carry worktree/model/agent/approval/detached/external badges; the Worktrees view carries session chips, diff/chat navigation and removal gates.
- **Worktree creation** stays a circumscribed local `git worktree add` (upstream 2.26.1 has no creation RPC): default = app-managed space `userData/worktrees/<slug>-<sha1>/`; optional = dialog-authorized custom parent validated in `git-service.js` (`#validateCustomRoot` + per-target `#refuseOverlappingCheckout`). No `.gitignore` touches, no migration, no silent cleanup, no `--force`.
- **Editor handoff** is filesystem-only (`src/main/editor-service.js` + `src/renderer/editor-handoff.ts`): resolved executables + structured argv, authorized roots only, no shell interpolation, no secrets. Same worktree ≠ same agent session; `vibe-acp` is detected/linked, never reimplemented.
- **Cloud** uses only official surfaces: `projectLinks/list`, `vibeCode/projects/open` picker, secure `openExternal` to Vibe Code Web + docs. The 5-step lifecycle (preflight → picker → requested → confirmed → beyond-visibility) is shown honestly; steps 3–5 are Mistral-owned and unverifiable locally.
- **Loops** respect the real lifecycle: `create|list|delete|clear` only (no `loops/update` upstream — explicit create-then-delete replace, old deleted only after the new validates). Toasts fire only while the app runs, deduped, without sensitive content, click-to-session; nothing promises app-closed delivery. Work Tasks stay hosted-only (no mirror). Task Scheduler is ADR-only (`docs/adr-task-scheduler.md`).
- **Preferences** extended additively (`worktreeRoots`, `customEditorPath`, `notificationsEnabled`) with bounded validation; old installs load unchanged.

## Really implemented (this branch)

- M3-A: `docs/m3-capability-matrix.md` (Supported/Declared/Unavailable/Official external/Unknown for session/loops/projectLinks/vibeCode/worktrees/ACP/Work).
- M3-B: enriched session tabs (`session-tabs.ts`), 4-slot viewable-vs-attached explanation, per-tab scroll/inspector/draft preservation, lease/external + approval badges, read-only subagent navigation preserved, crash/rename/lease/out-of-order handling via existing pool + canonical reads.
- M3-C: custom worktree parents with full refusal matrix, final-path preview (`previewWorktreePath`), per-repo preference, measured disk view (`worktreeDiskUsage`, bounded walk), open-in-editor/terminal/copy-path per checkout.
- M3-D: Cloud 5-stage UI, linked-project list, picker honesty, GitHub-App/plan delegation copy, Vibe Code Web + Teleport-docs links, session-id copy, provider-record model check.
- M3-E: loop replace flow (`planLoopReplace`, `describeLoopLastRun`), session-owner labels, backend-liveness honesty, `notifications.ts` + main `vibe:notify` (Electron Notification, click focuses owning session), Work distinction preserved, Task-Scheduler ADR.
- M3-F: `EditorService` (VS Code/Insiders/VSCodium/Cursor detection via known paths + PATH stat, custom exe validation, `open`/`openTerminal` with structured spawn), Files/Changes/Diff/Worktrees handoff buttons, ACP guidance + `detectAcp`, settings custom-editor picker.
- M3-G: compact tab badges, location row, lifecycle list, replace/disclosure copy, empty/loading/error states kept; light/dark via existing theme; keyboard/focus/scaling covered by native controls + existing CSS (no decorative bloat).

## Linked-only (official surfaces, no replica)

- Vibe Code Web projects/sessions, Teleport transfer, sandbox lifetime, GitHub-App/plan verification, Work + scheduled tasks, `vibe-acp` sessions, quota/billing pages.

## Verified APIs (frozen 2.26.1)

- Supported live: `session/*` lifecycle + reads + queue + lease/subscribe, `loops/create|list|delete|clear`, `projectLinks/list`, `vibeCode/projects/open` (picker), `workspace/git/worktrees/list|remove|reap|prune|checkouts`, `runtime/read`, `config/*`, `mcp/*`, `skills/*`, local git-service ops.
- Declared (not driven): `projectLinks/create|link|...`, `vibeCode/teleport/start|cancel|push/respond`, `session/context/inject`, `agents/install|uninstall`.
- Unavailable on Unified: `session/compact`, `review/*`, `stats/read`, `diagnostics/list`, `tools/list`, `agents/list` (use `runtime/read`), `loops/update|pause|resume`, worktree-creation RPC, Work-task RPC, cloud session list/control/sandbox-mutation/quota.
- No private endpoints invented; no authenticated scraping.

## Local tests (146/146 green)

- Kept all **120 M2.1** tests green (transport, pool, lifecycle, git-service, subagents incl. 3-concurrent real-engine, preview, capabilities, drafts, models, projection, rpc, browser-auth).
- Added **26**: `editor-handoff` (4), `session-tabs` (4), `notifications` (2), `worktree-custom` (4), `loops-replace` (2), `editor-service` (4, injection/UNC/unauthorized/argv/terminal), `worktree-custom-root` (4, real-git custom creation + preview parity + UNC/inside/overlap + collisions/branch + disk), `backend-prefs-m3` (2, persist/refuse).
- `npx tsc --noEmit` green · `npm run build` green (renderer 471 kB JS / 142 kB gzip) · `npm audit` 0 vulns (full + prod).
- Adversarial coverage: UNC/junction/symlink/inside-repo/inside-worktree/collision/branch-exists/non-empty/occupied/unknown/dirty/unpushed, editor injection/unauthorized/external-file/line-bounds, loop id-less rows/double-clear/RPC-error/replace-no-dupe, notification dedupe/no-secrets, 4-slot limit message, picker-failure vs picker-opened distinction.

## Real-engine / fixture tests

- Real-engine: reused M2.1 evidence (loopback provider streaming/lifecycle, 3 concurrent subagents, approved file write, frozen `vibe-app-server.exe` probe). No hosted model calls, no cloud sessions, no Teleport E2E (account gate, declared).
- Fixture: new pure + service tests above use local/loopback data only; never presented as hosted-model results.

## Screenshots / CI / installer (honest residual)

- **Not executed in this turn:** Playwright dev-app/packaged-app UI runs, fresh screenshots, NSIS packaging + SHA-256, GitHub Actions (both workflows). The renderer builds and all unit/integration gates pass locally, but M3 must not be declared fully accepted until: `npm run test:ui` (dev + packaged), screenshots (multi-session, 3 agents, worktree+sessions, directory picker, cloud preflight, picker, loops, Code/Work, editor handoff, themes, narrow), `npm run package` + packaged-app tests, and both CI workflows are green on the closing commit.
- M2.1 evidence (`docs/screenshots/`, `docs/performance/`, `docs/m2.1-delivery.md`) remains the last full Electron/packaging record; no regression is claimed beyond comparability (same pool cap, bounded git/diff output, no duplicate polling added, listeners use explicit `off*` cleanup).

## Security analysis

- No shell interpolation (`execFile`/`spawn` argv + stdin patch delivery); editor/custom-root paths length/character/absolute/UNC checked; `.exe/.cmd/.bat` allowlist for custom editor; traversal/`.git`/ADS rejected; realpath + inside() identity on every mutation; serialization per repo; ownership-first removal (occupied/unknown blocks); no `--force`/`reset --hard`/`clean -fd`; no credential retention (Vibe keyring custody); no `file://` grants; isolated preview/quota windows unchanged; IPC sender/scheme validated; external URLs allowlisted (Mistral HTTPS + project repo + validated `gh` PR links).
- Limits: hostile-local TOCTOU outside the verified windows, external processes outside pool control, UNC refused (not transparently supported), volume/free-space reported as measured-or-unknown (no privileged disk API), `npm audit` covers JS tree only.

## Performance

- No new polling loops; worktree disk walk bounded (25 checkouts × 2000 files × depth 6); tab switch reuses canonical reads + cached drafts; loops/cloud panels fetch on open/refresh only; event forwarding unchanged. M2.1 numbers (≈3.3–3.8 s ready, ≈500 MiB combined working set, ≈0–0.6% idle core) remain the baseline; M3 adds no claimed improvement — re-measure with `docs/performance/` scripts during the Electron gate.

## Residual limits (account/upstream-dependent, declared as such)

- Teleport E2E needs Pro/Team + GitHub App + eligible repo + Mistral-model session; tier/App state unknowable locally.
- Cloud session inventory/remote control/sandbox mutation/cost APIs don't exist on the public app-server.
- `loops/update|pause|resume` don't exist — replace is explicit and non-atomic.
- Work tasks have no public local API.
- Clean Windows 11 install/uninstall, DPI/snap/Mica on Win11, hosted entitlement/model quality, live browser sign-in, connector OAuth, registry browsing, quota rendering remain external checks.
- UI e2e + packaging + CI + fresh screenshots pending (see above).

## Upstream proposals (no issue filed automatically)

- Typed availability for `review/*`, `stats/read`, `diagnostics/list`, `tools/list` on Unified (or dispatch to implementations) + capability handshake so clients avoid probing.
- `loops/update|pause` or documented non-goal; `mcp` source-layer reporting (applied layer + effective state); nullable measurement fields for stats/context.
- Worktask read API or documented non-goal (desktop will keep linking, not mirroring).

## M4 recommendation

- Run the pending Electron/packaging/CI gates first; then consider: skill-registry lifecycle GUI (backend already validates), stdio-MCP structured editor, multi-root project catalog polish, transcript virtualization measurement, and (only with explicit demand + security design) any unattended story per the ADR.
