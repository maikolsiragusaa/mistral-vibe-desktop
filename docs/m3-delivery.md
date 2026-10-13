# M3 delivery report — multi-session workspace, cloud honesty, automations, editor handoff

Branch: `codex/windows-client` · PR #1 · **no merge to `main`, no release, no upstream modification.**
Runtime: official Mistral Vibe Unified **2.26.1 frozen** (no upgrade, no paid cloud sessions created, no end-to-end Teleport completed).

## Final commit & branch state

- Checkpoint `af136ed7c08a147502471dd04faeb5829af38d25` (M2.1) → `a834bf5` (M3 implementation) → `c7084c9` (validation: race guard, replace honesty, test gate, evidence) → **`c2afa5c` (CI fix: canonical test keys for short-TEMP runners)**. All pushed normally to `origin` (no `--force`, no new branch).
- Branch `codex/windows-client` head: `c2afa5c24075e40d0f1397e4a1f0490322e3cd31`. PR #1 stays **draft**. **No merge to `main`, no release, no upstream modification.**
- Working tree clean at delivery; `git status` verified before each push and commit.

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

## Electron validation (real app + frozen Unified 2.26.1, no paid APIs)

- `desktop.spec` (dev): **PASS** 25.9 s — connect, local project, streaming + resume, both themes.
- `expansion.spec` (dev): **PASS** 1.7 m and 3.7 m — Git/attribution/stage/commit/history/worktrees (creation hygiene + dirty-removal refusal), Files/preview, models, approvals, sessions, subagents.
- `desktop.spec` (packaged `out/win-unpacked/Vibe Desktop.exe`): **PASS** 23.5 s.
- `expansion.spec` (packaged): **PASS** 1.9 m, incl. the owned-processes-exit check.
- Screenshots: **35 PNGs** regenerated in `docs/screenshots/` by the passing runs (worktrees, worktree-blocked, file/web preview, git-diff, subagents, dark/light, narrow, session, validation-error, attachments, context-tokens, MCP, models, providers, reasoning, skills, appearance-settings, approval-pending, home states).
- Process cleanup: packaged expansion asserts all owned processes exit; no `Vibe Desktop.exe`/`vibe-app-server` processes linger after the runs (lingering `electron.exe` instances belong to an unrelated project and were left untouched).

## Problems found & fixed (no lucky reruns)

1. **Worktree-creation test gate broken by the new path preview (deterministic, 3/3 runs).** The M3 preview line (`Final path preview: …ui-created-branch`) satisfied the spec's `toContainText("ui-created-branch")` gate *before* the checkout existed, so the synchronous `git worktree list` assertion ran ~500 ms before `createWorktree` completed (main-process timing log proved completion at ~600 ms: overlap 44 ms, mutation incl. `worktree add` ~500 ms). Cause, not flake. Fix: gate the test on the explicit success notice (`Worktree created at`) + row — the true UX completion signal. File: `tests/ui/expansion.spec.ts`. Service/renderer code needed no change (direct-service and in-app IPC repros both passed).
2. **Rapid tab-switch race in `openSession` (code defect, fixed).** Two overlapping `openSession` calls could let the slower one `adopt()` its stale session over the newer one (`pendingOpen` was write-only). Fix: per-call token, stale calls return before `adopt` (`src/renderer/App.tsx`).
3. **Loop replace partial failure hid duplication (code defect, fixed).** If `loops/create` succeeded but `loops/delete` failed, the UI showed a bare error on a stale list — the duplicate was invisible. Fix: refresh the list and report explicitly that two loops now exist with an instruction to delete one (`src/renderer/LoopsPanel.tsx`).
4. **Loaded-runner variance (not a bug, documented).** One dev-app run failed at `expect(overlay.visible).toBe(true)` (line 494, Windows shell/compositor state) and the pre-fix run executed a stale transform per the M2.1-noted cache hazard. Neither touches M3 code paths (titlebar code unchanged). Two subsequent full dev runs + both packaged runs are green; CI on a clean runner is the arbiter (see below).
5. **CI step-9 red on short-TEMP runners (deterministic, test-only bug, fixed in `c2afa5c`).** Both `a834bf5` and `c7084c9` failed `Build renderer and run backend tests` (exit 1, full ~66 s run) while 146/146 pass locally in four contexts (normal, `--test-concurrency=2`, clean-clone + `npm ci` + `CI=true` + real backend, new-tests loop ×2). Cause: windows-latest exposes TEMP through short 8.3 names (`RUNNER~1`); the service correctly keys `worktreeRoots` by canonical path, but `backend-prefs-m3` indexed the result with the raw `mkdtemp` path → `undefined` on CI, green locally. Proved by replaying with a short TEMP alias (old assertion fails with `actual: undefined`, fixed one passes). Fix is test-only (index by `realpath`, hermetic `mkdtemp` custom root); production already canonicalizes everywhere (dialog paths, realpath identity). `worktree-custom-root` path comparison hardened to `realpath` on both sides. Step-9 durations match a full pass (M2.1 green step 9: 70 s), confirming the suite ran to completion rather than crashing early.

## GitHub Actions & installer

- Workflow: `Windows build` (`.github/workflows/windows.yml`) on push + PR — build, `npm test`, frozen-backend probe, dev-app UI, NSIS packaging, packaged-app UI, SHA-256 + artifact upload.
- Closing SHA `c2afa5c`: push run `https://github.com/maikolsiragusaa/mistral-vibe-desktop/actions/runs/38436541326` (**success**, 17:10–17:20 UTC, all 16 steps incl. build+146 tests, frozen-backend probe, dev-app UI, NSIS, packaged-app UI, SHA-256, artifact upload) and PR #1 run `https://github.com/maikolsiragusaa/mistral-vibe-desktop/actions/runs/38436548050` (**success**, same steps). **Both CIs green — gate satisfied.**
- CI artifact (14-day retention): `Vibe-Desktop-Windows-c2afa5c24075e40d0f1397e4a1f0490322e3cd31-9c1cb57ee9db25cc6c3556e99b9e46329cb05327425c60234bcb677769c05596` (167 411 128 bytes zip: Setup exe + SHA256SUMS + screenshots + perf JSON + playwright traces + backend manifests).
- CI installer SHA-256: `9c1cb57ee9db25cc6c3556e99b9e46329cb05327425c60234bcb677769c05596` (authoritative for `c2afa5c`; unsigned, same posture as M2.1).
- Prior SHAs for the record: `c7084c9` push `38433461045` + PR `38433468162` (red at step 9, short-TEMP cause above); `a834bf5` PR `38426820489` (red at step 9, same cause).
- Local installer (informational, superseded by the CI artifact): `out/Vibe-Desktop-0.3.0-x64-Setup.exe`, 157.2 MiB, SHA-256 `1b4c26de5cbea75681fe0cb7427a5aee5488ee30cca14e5de054ad38f5e3df02` (unsigned, `NotSigned`, same posture as M2.1; built pre-`c2afa5c`, hence differing from the CI hash).
- Note: `out/` also holds older local `0.1.0`/`0.2.0` setup exes from previous builds; CI builds on a clean runner where exactly one installer exists (enforced by the workflow step).

## Cloud: verified vs official-surface-only

- Verified locally: `projectLinks/list`, `vibeCode/projects/open` picker (incl. failure paths), Teleport preflight (Git repo, provider-record model, credentials), 5-stage lifecycle honesty (picker-open ≠ transfer-complete; no `confirmed` state without upstream evidence).
- Official-surface-only (linked, never replicated): cloud project/session inventory, transfer request/confirmation, sandbox lifetime, GitHub persistence, tier/App verification, Work surfaces + scheduled tasks, `vibe-acp` sessions, quotas.
- No cloud sessions created, no Teleport completed, no paid APIs used (account gate declared).

## Security analysis

- No shell interpolation (`execFile`/`spawn` argv + stdin patch delivery); editor/custom-root paths length/character/absolute/UNC checked; `.exe/.cmd/.bat` allowlist for custom editor; traversal/`.git`/ADS rejected; realpath + inside() identity on every mutation; serialization per repo; ownership-first removal (occupied/unknown blocks); no `--force`/`reset --hard`/`clean -fd`; no credential retention (Vibe keyring custody); no `file://` grants; isolated preview/quota windows unchanged; IPC sender/scheme validated; external URLs allowlisted (Mistral HTTPS + project repo + validated `gh` PR links).
- Limits: hostile-local TOCTOU outside the verified windows, external processes outside pool control, UNC refused (not transparently supported), volume/free-space reported as measured-or-unknown (no privileged disk API), `npm audit` covers JS tree only.

## Performance (measured, same method as M2.1)

- Dev-app runs: cold start 2712 / 3750 / 5078 ms (load variance), working set 494.8–509.4 MiB across 6 owned processes, idle CPU 0.00–5.41% of one core over ~5.5 s (`docs/performance/frozen.json`).
- Packaged app: cold start **3103 ms** (M2.1: 3385 ms), working set **524.9 MiB** across 6 processes incl. `vibe-app-server` 131.5 MiB (M2.1: 528.7 MiB), idle CPU **0.29%** (M2.1: 0.28%) over 5.45 s (`docs/performance/packaged.json`).
- Renderer bundle: 471.96 kB JS / 142.85 kB gzip (M2.1: ~430 kB / ~130 kB — small growth from tabs badges, lifecycle, replace, handoff UI).
- Verdict: comparable to M2.1 in the same order; no improvement claimed beyond comparability. No new polling loops; disk walk bounded; tab switch reuses canonical reads + cached drafts; loops/cloud fetch on open/refresh only.

## Residual limits (account/upstream-dependent, declared as such)

- Teleport E2E needs Pro/Team + GitHub App + eligible repo + Mistral-model session; tier/App state unknowable locally.
- Cloud session inventory/remote control/sandbox mutation/cost APIs don't exist on the public app-server.
- `loops/update|pause|resume` don't exist — replace is explicit and non-atomic.
- Work tasks have no public local API.
- Clean Windows 11 install/uninstall, DPI/snap/Mica on Win11, hosted entitlement/model quality, live browser sign-in, connector OAuth, registry browsing, quota rendering remain external checks.
- Local `out/` keeps older setup exes (see installer note); `npm audit` covers the JS tree only; free-space reporting stays measured-or-unknown (no privileged disk API).

## Upstream proposals (no issue filed automatically)

- Typed availability for `review/*`, `stats/read`, `diagnostics/list`, `tools/list` on Unified (or dispatch to implementations) + capability handshake so clients avoid probing.
- `loops/update|pause` or documented non-goal; `mcp` source-layer reporting (applied layer + effective state); nullable measurement fields for stats/context.
- Worktask read API or documented non-goal (desktop will keep linking, not mirroring).

## M4 recommendation (M3 gates executed; do not start M4 here)

- Keep: skill-registry lifecycle GUI (backend already validates), stdio-MCP structured editor, multi-root catalog polish, transcript virtualization measurement, unattended story only per ADR with explicit demand + security design.
- First: confirm both CI runs green on the closing SHA; keep PR #1 draft with no merge/release.
