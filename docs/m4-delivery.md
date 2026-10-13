# M4 delivery report — extensions, skills, MCP & ecosystem integration

Branch: `codex/windows-client` · PR #1 · **no merge to `main`, no release, no upstream modification.**
Runtime: official Mistral Vibe Unified **2.26.1 frozen** (no upgrade, no paid model calls, no live registry mutation, no live OAuth completion).

## Final commit & branch state

- Checkpoint `487552f` (M3 delivery) → `be17a10` (M4 implementation: skills lifecycle, stdio MCP, tools/layers/ACP, terminal hardening) → `fa339cb` (M4 delivery record) → `8726141` (M4 UX styles) → **`ac3a16b` (M4 CI fix: canonical paths for short-TEMP runners)**. All pushed normally to `origin` (no `--force`, no new branch).
- Branch `codex/windows-client` head: `ac3a16b25c36198d24b8311065fbcc658d681878`. PR #1 stays **draft** (`state: open`, `draft: true`, `merged: false`, `mergeable: true`, verified via API). **No merge to `main`, no release, no upstream modification.**
- `ac3a16b` differs from red `8726141` by `tests/backend-stdio-m4.test.js` only (4-line canonical-path hardening, same production code). Its own push + PR runs are fully green (below).
- Working tree clean at delivery; `git status` verified before each push and commit.

## Architecture & decisions

- **No new plugin system / second MCP host / alternative harness.** The runtime stays the only execution authority. Stdio servers are declared through the official `config/write → /mcp_servers` path (verified live), executed by Vibe — the desktop never spawns MCP servers itself and never validates forms by executing commands.
- **ResourcesWorkspace becomes a coordinator.** New typed modules under `src/renderer/resources/`: `types.ts` (explicit MCP/skill/plugin/config/tool models, no `Record<string,any>` universe), `adapters.ts` (tolerant unwraps, identity-by-name, additive-field tolerance), `validation.ts` (URLs, skill ids/aliases/versions/scopes, stdio command/args/env/cwd, status labels), plus feature components `SkillLifecycle.tsx` (import/alias/version/latest/convertLocal/remove with consent + readback), `StdioMcpDialog.tsx` (structured stdio editor with summary + explicit consent + list-level write from the authoritative layer value), `ToolsInspector.tsx` (runtime/read-only tool + agent capability view, no execution), `LayerInspector.tsx` (applied-layer view), `AcpPanel.tsx` (official `vibe-acp` detection + guidance, no second server). The existing 3k-line workspace keeps its selectors/labels and now hosts these panels; provider/auth/session/Git/Cloud/Loops behavior is untouched.
- **MCP model.** `mcp/read` + `mcp_catalog/*` for HTTP servers/connectors display; `connector_catalog/toggle` for `kind:connector` (verified: `mcp/toggle` on connectors returns `not_implemented`); `config/fields/read` layerValues (`targets:["user-toml","overrides"]`) as the only write source for stdio + shadow overrides; `mcp_catalog/refresh` + `runtime/read` + `config/read` counts as readback. States Configured/Enabled/Connected/Usable are computed and labeled distinctly (`capabilityOf`), never conflated.
- **Secrets.** No full-config reconstruction from redacted views; `config/write` validation still rejects credential-bearing keys; MCP `env` values never enter logs/drafts/localStorage; error strings redact Bearer/tokens/URLs. No proprietary vault.
- **Editor/terminal.** `EditorService.openTerminal` fallback replaced: direct `cmd.exe /d` with `cwd` set (folder never parsed as command text) instead of `cmd /c start "" /d <folder>`; `.cmd/.bat` editors route via `cmd.exe /d /s /c` with individually quoted args and `shell:false`; spawn failures throw instead of false-confirming; folder/exe validation rejects quotes/controls/shell operators.

## Really implemented (this branch)

- M4-A: `docs/m4-capability-matrix.md` — Supported/Declared/Unavailable/Official-external/Unknown for skills/mcp/connectors/plugins/agents/config/tools/ACP, grounded in live isolated-home probes (no model calls). Pin stays 2.26.1.
- M4-B: resources refactor — 5 new typed modules + 5 feature components; workspace imports them, adds update/layer/stdio/tools/ACP surfaces, preserves every Playwright selector.
- M4-C: skills lifecycle — installed list (search, source/scope/version, enabled switch, update badge, instructions disclosure, per-skill Manage dialog), registry (browse/reload, search, detail with null-detail honesty, per-entry Import with version/alias/scope + trust consent + installed-list readback), updates via `skills/updates`.
- M4-D: MCP — HTTP add/toggle/refresh/remove/login/logout unchanged + readback; connectors routed to `connector_catalog/*`; stdio Add/Edit/Remove via `config/write /mcp_servers` from the `user-toml` layer value with consent + summary + field validation + refresh + layer readback; layer inspector; per-server diagnostics (status/error/tools/auth/plugin-owner); secrets preserved.
- M4-E: plugins/connectors/tools — catalog + loaded + dropped + drift + components + reload with readback (no fake install); connector readiness/authAction/tools/diagnostic surfaced; Tools Inspector + agent capabilities from `runtime/read` only (`tools/list` stays `method_not_found`); no tool execution from the list.
- M4-F: ACP + handoff — `AcpPanel` (detect/re-detect, guidance snippet copy, no session-sharing claim) in Diagnostics; terminal fallback + `.cmd/.bat` hardening in `editor-service.js` with contract tests.
- M4-G/H: UX + security — text status badges (not color-only), inline problems, keyboard/focus-preserving dialogs, existing dark/light/1080p/narrow/reduced-motion posture kept; `docs/security-review-m4.md` (remote/local/skills/plugin/Electron findings as bug/risk/limit/improvement).

## Linked-only (official surfaces, no replica)

- Registry skill content, connector OAuth completion, hosted Work tasks, cloud sessions/transfer/sandbox/quota numbers, `vibe-acp` sessions — linked/guided, never mirrored or faked.

## Verified APIs (frozen 2.26.1, M4 live probes 13 Oct 2026, isolated home, zero model calls)

- Supported live: `skills/catalog|installed|list|updates` (empty shapes verified), `skills/setEnabled`, `mcp/read`, `mcp_catalog/read|refresh|add|toggle|remove|login|logout`, `mcp/add` (HTTP), `connector_catalog/read|refresh|toggle`, `connectors/read`, `plugin_catalog/read`, `plugins/read`, `plugin/info`, `plugin/reload`, `config/read|cwd-variant|fields/effective/write|reload`, `runtime/read` (tools/agents/skills/mcp/issues), `diagnostics/logs/read`, `account/identity/providerAuth/read`.
- Declared (validated shapes, readback-wired, account/network-gated — not live-mutated here): `skills/detail|versions|import|setAlias|setVersion|setLatest|remove|convertLocal`, `connector_catalog/auth/request`, `connectors/auth/read`, `connectors/refresh` (requires `name` — upstream param-doc gap noted), `agents/install|uninstall`.
- Unavailable on Unified: `tools/list`, `agents/list`, `diagnostics/list`, `stats/read`, `session/compact` (as in M3).
- Stdio proof: `config/write /mcp_servers [{name,transport:stdio,command,args,cwd,env,disabled}]` → counts 1/1, `user-toml` layerValue normalized, TOML `[[mcp_servers]]` written; `runtime/read` source `{kind:server,transport:stdio,status:unavailable,tools:[]}` (reported honestly as not-verifiable, not available); leaf disable → 1/0; list remove → 0/0; backend exits cleanly; no fixture process lingers; **no model was invoked and no tool was executed by a model**.

## Local tests (161/161 green)

- Kept all **146 M3** tests green (incl. updated `editor-service` shell assertion and `backend` stdio contract test).
- Added **15**: `resources-m4` (7: HTTPS policy, skill id/alias/version/scope, stdio validation, adapters, capabilities, status labels, redaction), `editor-terminal-m4` (5: direct-cmd fallback + cwd transport, wt preference, `.cmd` routing without shell:true, spawn-failure honesty, quote rejection), `backend-stdio-m4` (3: well-formed stdio accepted without execution, shell/bad-name/UNC/mixed/missing-command/bad-env rejected, credential fields still rejected).
- `npx tsc --noEmit` green · `npm run build` green (renderer `index` 471.96 kB JS / 142.85 kB gzip — same order as M3; resources chunk carries the new panels) · `npm audit` 0 vulns (full + prod).

## Real-engine / fixture tests

- Fixture: new pure + service tests above use local/loopback data only; never presented as hosted-model results.
- Real-engine (frozen exe, isolated `VIBE_HOME`, zero model calls): M4-A audit probes (skills/mcp/connector/plugin/config/runtime shapes + `mcp/add` + `connectors/refresh(name)` + `config/write` stdio/HTTP acceptance + toggle separation proofs) and the M4 stdio lifecycle proof above. No hosted calls, no registry writes, no OAuth completion (account gates declared).

## Electron validation (real app + frozen Unified 2.26.1, no paid APIs)

- `desktop.spec` (dev): **PASS** 22.1 s — connect, local project, streaming + resume, both themes.
- `expansion.spec` (dev): **PASS** 1.8 m — Git/attribution/stage/commit/history/worktrees, Files/preview, models, approvals, sessions, subagents, MCP HTTP discovery/toggle/add/remove, installed-skill toggles, plugin reload, providers; perf line `[vibe-perf] packagedOrInstalledColdStartupMs=3173, ownedProcesses=8 workingSetMb=501.1 idleCpuPct=0.00 intervalSeconds=5.42`.
- Screenshots: **35 PNGs** regenerated in `docs/screenshots/` by the passing runs (now including Add-stdio entry point, per-skill Manage, layer note, tools inspector and ACP panel in their tabs).
- Packaged + installer validation: via CI workflow (build → 161 tests → frozen-backend probe → dev-app UI → NSIS packaging → packaged-app UI → SHA-256 + artifact upload); local packaged run is superseded by the CI artifact on the closing SHA (see below).

## Problems found & fixed (no lucky reruns)

1. **Stdio contract blocked by desktop validation (audit finding, fixed).** M3 rejected all stdio `config/write` as "HTTP-only". Live probes proved upstream officially accepts `/mcp_servers` stdio entries (normalized + persisted + counted). Fix: `SAFE_MCP_FIELDS` + `validateSafeMcpServer` now accept `command/args/env/cwd/transport:stdio` under strict validation (shell-string/UNC/mixed-shape/credential rejection), `mcp/add` stays HTTP-only. Tests updated + 3 new stdio contract tests.
2. **Terminal fallback parsed the folder as command text (code defect, fixed).** `cmd /c start "" /d <folder>` passes the workspace path through cmd's parser. Fix: direct `cmd.exe /d` spawn with `cwd` set; `.cmd/.bat` editors route via `cmd /d /s /c` with per-arg quoting and `shell:false`; spawn failures throw. Old + 5 new terminal tests.
3. **Connector toggles risked the wrong RPC (audit finding, kept correct).** Live: `mcp/toggle{source:connector}` → `not_implemented`. Desktop already routes connectors to `connector_catalog/toggle` — verified and documented; no code change needed beyond the matrix + Tools/Layer honesty.
4. **`connectors/refresh` param-doc gap (upstream gap, handled).** Registry lists only `sessionId`, live requires `name`. Desktop always sends `name`; recorded in the matrix, no probing beyond the verified shape.
5. **New-test failures during development (test bugs, fixed).** Shell-metachar expectation used a space-only string (correctly accepted); MCP adapter test passed a `{mcp:{sources}}` wrapper the new helper initially didn't unwrap; stdio harness test bypassed session authorization. All fixed in test code — production behavior unchanged.
6. **CI step-9 red on short-TEMP runners (deterministic, test-only bug, fixed in `ac3a16b`).** Both `fa339cb` and `8726141` failed `Build renderer and run backend tests` (exit 1, ~74 s step) while 161/161 pass locally. Cause: windows-latest exposes TEMP through short 8.3 names (`RUNNER~1`); the service keys authorized projects by realpath, but `backend-stdio-m4` passed the raw `mkdtemp` path to `session/start` → "existing selected folder" error on CI, green locally. Same signature as the M3 short-TEMP reds. Fix is test-only (realpath the project dir before dialog/start, mirroring `backend-prefs-m3`); production already canonicalizes everywhere. Step-9 on `ac3a16b` is green (68 s), confirming the suite ran to completion.

## GitHub Actions & installer

- Workflow: `Windows build` (`.github/workflows/windows.yml`) on push + PR — build, `npm test` (161), frozen-backend probe, dev-app UI, NSIS packaging, packaged-app UI, SHA-256 + artifact upload.
- Closing SHA `ac3a16b`: push run `https://github.com/maikolsiragusaa/mistral-vibe-desktop/actions/runs/38464524646` (**success**, 20:39–20:51 UTC, all 16 steps incl. build+161 tests, frozen-backend probe, dev-app UI, NSIS, packaged-app UI, SHA-256, artifact upload) and PR #1 run `https://github.com/maikolsiragusaa/mistral-vibe-desktop/actions/runs/38464533761` (**success**, same steps).
- CI artifact (14-day retention): `Vibe-Desktop-Windows-ac3a16b25c36198d24b8311065fbcc658d681878-af73c6417d78ac32c1ce2f1ab481677c1e865aa804b0b9c0669ba9a4d63a7da1` (167 463 353 bytes zip: Setup exe + SHA256SUMS + screenshots + perf JSON + playwright traces + backend manifests).
- CI installer SHA-256: `af73c6417d78ac32c1ce2f1ab481677c1e865aa804b0b9c0669ba9a4d63a7da1` (authoritative for `ac3a16b`; unsigned, same posture as M3).
- Prior SHAs for the record: `8726141` push `38463419351` + PR `38463426902` (red at step 9, short-TEMP cause below); `fa339cb` push `38463248102` + PR `38463255453` (red at step 9, same cause).
- Local installer: superseded by the CI artifact (same posture as M3: unsigned NSIS, `NotSigned`).

## Cloud: verified vs official-surface-only

- Verified locally: skills/mcp/plugin/config/connector reads above + stdio lifecycle proof + HTTP add/remove + toggles with readback + account/identity/providerAuth reads.
- Official-surface-only: registry skill payloads/versions, connector OAuth completion, cloud inventory/transfer/sandbox, Work tasks, `vibe-acp` sessions, numeric quotas — linked/guided, never replicated.

## Security analysis

- See `docs/security-review-m4.md` (full matrix). Headline: no shell interpolation anywhere (spawn argv + stdin patch + quoted `.cmd` routing); stdio consent + summary + syntactic-only validation; secrets preserved via layer-value writes + credential-store delegation + redaction; connector/plugin ownership respected; no fake install/availability/tool-execution; IPC/CSP/isolation/sandbox unchanged; backend validation strengthened, never weakened.
- Limits: slow starters report `unavailable` honestly; registry writes + OAuth completion need accounts; hostile-local TOCTOU / external processes / privileged disk APIs as in M3; `npm audit` covers the JS tree only.

## Performance (measured, same method as M3)

- Dev-app expansion run: cold start **3173 ms**, working set **501.1 MiB** across 8 owned processes, idle CPU **0.00%** over 5.42 s.
- M3 reference: packaged cold start 3103 ms, 524.9 MiB, 0.29%; renderer 471.96 kB / 142.85 kB gzip. M4 renderer `index` bundle is byte-identical in size order (471.96 kB / 142.85 kB); resources chunk carries the new panels without new polling (loads on open/refresh only; catalog search is memoized).
- Verdict: same order as M3; no improvement claimed beyond comparability. No new timers; no full-catalog preload at startup.

## Residual limits (account/upstream-dependent, declared as such)

- Registry skill payloads/versions/imports, connector OAuth completion, Teleport E2E, cloud inventory/control/quotas, Work tasks, `agents/install` packages — account/network-gated, covered by contract + readback, not live-mutated here.
- `tools/list`, `agents/list`, `diagnostics/list`, `stats/read`, `session/compact`, worktree-creation RPC — unavailable on Unified, unchanged.
- `skills/detail` for local/plugin ids returns null bodies (typed, not an error) — shown as "no further detail exposed".
- Slow stdio starters show `unavailable` until Vibe connects; re-refresh is the honest path.
- Clean Windows 11 install/uninstall, DPI/snap/Mica on Win11, hosted entitlement/model quality, live browser sign-in remain external checks.
- `npm audit` covers the JS tree only.

## Upstream proposals (no issue filed automatically)

- Document `connectors/refresh{name}` (registry says session-only; live requires `name`).
- Typed availability for `skills/detail|versions` on local/plugin ids (null-body today + 400 warning in logs) or a documented registry-only contract.
- `skills/catalog` filtering/paging + `updates` push/event story so clients avoid polling.
- `mcp` source-layer reporting (applied layer + effective state) and OAuth-support advertisement per source.
- `tools/list`/`agents/list` on Unified or a documented `runtime/read`-only contract (the desktop already implements the latter).
- Rejected-`config/write` itemized errors (upstream already returns `rejected`/`failures` — keep and document).

## M5 recommendation (M4 gates executed; do not start M5 here)

- Keep: authenticated registry E2E (import/update/remove against a disposable registry entry with an authorized account), slow-starter MCP tool-discovery timing study, transcript virtualization measurement, unattended story only per ADR with explicit demand + security design.
- First: confirm both CI runs green on the closing SHA; keep PR #1 draft with no merge/release.
