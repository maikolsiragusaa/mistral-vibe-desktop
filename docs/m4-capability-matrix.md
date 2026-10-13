# M4 capability matrix — Mistral Vibe Unified 2.26.1 (frozen)

Date: 2026-10-13 · Runtime: Mistral Vibe Unified 2.26.1 (`4ae5c5955da8e761318916bdb1a7f46f0b50c7d0`) · No runtime upgrade performed.
Method: live stdio probes against the frozen `vibe-app-server.exe` in an isolated `VIBE_HOME` (no model calls, no paid APIs) on 2026-10-13, plus `src/main/backend.js` PARAM_KEYS/validation review and `config/fields/read` + `runtime/read` shape inspection. Probes: `C:\Users\sirag\AppData\Local\Temp\opencode\m4-probe*.py` (summarised below; scripts are ephemeral audit tools, not shipped).

Legend — **Supported**: implemented and verified live or via real-engine test. **Declared**: in protocol/allowlist but not verified working here. **Unavailable**: verified `method_not_found` / `not implemented` on Unified. **Official external**: only via official web/CLI/editor surface. **Unknown**: not verifiable with current permissions/resources.

## skills/*

| Method | Verdict | Evidence |
| --- | --- | --- |
| skills/catalog | Supported (bounded) | Live OK: `{skills:[], updates:{}, loaded:true, projectAvailable:false, authenticated:true}` in isolated home with `experimental_enable_registry_skills=false`. Empty catalog is the honest no-registry state; registry entries require account + opt-in flag — Declared content, not verified here. |
| skills/installed | Supported | Live OK: returns user/plugin skills (e.g. `hf-cli` with full description+prompt). Desktop lists, searches, toggles. |
| skills/list | Supported | Live OK: returns plugin/builtin skills (`vibe:create-plugin`, `vibe:skill-creator`, `vibe:vibe`, `vibe:worktree` with full prompt text). Source of "available to session" list. |
| skills/detail | Declared | Live: returns `{detail:null, body:null}` for local/plugin ids (`hf-cli`, `vibe:create-plugin`, …) with a `Failed to load skill details: unexpected status 400` warning in `diagnostics/logs/read`. No error envelope, but no content. Registry-backed detail (with `skillId`+`version`) is account-gated — not verified. Desktop treats null-detail as "no further detail exposed", never fakes it. |
| skills/setEnabled | Supported | Backend validates `name`+`enabled`; desktop toggles with readback via `skills/installed`. |
| skills/import | Declared | In allowlist + backend validation (`skillId` required, optional `version`/`alias`/`scope`). Live import needs a real registry entry + auth — not exercised (would mutate real account state / network). Desktop exposes it behind explicit confirm + readback, surfaces upstream errors honestly. |
| skills/setAlias, skills/setVersion, skills/setLatest | Declared | Same status as import: validated shapes, readback wired, live mutation needs registry/local fixtures — covered by contract tests, not by live registry writes. |
| skills/remove, skills/convertLocal | Declared | Validated (`name`+`scope`); destructive so UI requires explicit confirm + readback. No live delete of real user skills in audit. |
| skills/versions, skills/updates | Declared (empty verified) | Live OK with `{versions:[]}` / `{updates:[]}` for unknown/local ids. Non-empty versions need registry — not verified. |
| Skill identity | Supported (UX rule) | Desktop uses canonical `name` (never list index) for all mutations; alias/version/scope validated before send; pending state + readback + visible error on mismatch. |

Registry gating: `config/fields/read` exposes `experimental_enable_registry_skills` (bool, default false) and `skill_paths` / `enabled_skills` / `disabled_skills`. `skills/catalog.authenticated/projectAvailable/loaded` are surfaced in UI instead of invented ratings/downloads.

## mcp/* + mcp_catalog/*

| Method | Verdict | Evidence |
| --- | --- | --- |
| mcp/read, mcp_catalog/read | Supported | Live OK: `{mcp:{sources:[…16 connectors…]}}`. Each source: `name/displayName/kind/transport/status/tools[]/error/pluginName`. `github_app` connected with 46 tools; others `needs_auth` with `tools:[]`. Desktop renders Configured/Enabled/Connected/Usable distinctly. |
| mcp/refresh, mcp_catalog/refresh | Supported | Live OK: returns `{runtime:{…}}`. Desktop refreshes catalog + `runtime/read` snapshot after writes. |
| mcp/add | Supported (HTTP only) | Live OK with `{sessionId, url:https://example.com/mcp, name}` → `{name, url, created:true, runtime}`. Session-less call → `conflict: sessionless mutation cannot target active session implicitly`. Desktop requires session + HTTPS, rejects creds/query/fragment, delegates OAuth to controller. |
| mcp_catalog/add | Supported (HTTP only) | Live OK: `{sessionId, url}` → `{name:"example", url, created:true, runtime}`. Same HTTPS-only contract. |
| mcp/toggle | Supported (server sources only) | Live: connector-owned name with `source:connector` → `not_implemented: Connector-owned MCP sources are not part of the MCP catalog` (correct separation). Server toggles go through `mcp_catalog/toggle` + layer-shadow fallback via `config/write` leaf + `mcp_catalog/refresh` + readback. |
| mcp_catalog/toggle | Supported (server sources only) | Live: unknown name → `internal_error: MCP server is not configured`. Desktop verifies readback; project-layer shadowing handled via `config/fields/read` → leaf `config/write` in exposed source layer → refresh → re-read (never claims success on response alone). |
| mcp_catalog/remove | Supported | Allowlisted + validated; desktop confirms explicitly, reads back catalog. |
| mcp/login, mcp/logout, mcp_catalog/login, mcp_catalog/logout | Supported (delegated) | Validated shapes; OAuth PKCE/state stays in upstream controller + `mcp_catalog/authUrl` / `connector_catalog/authUrl` events. Desktop never logs tokens/headers/callbacks, never embeds creds in URLs. |
| mcp/add with stdio | Unavailable (by design) | Upstream contract is streamable-HTTP-only; desktop validation rejects non-`streamable-http` transport and `allowInsecureHttp:true`. Stdio goes through `config/*` (below), never by bending this contract. |

HTTP policy: HTTPS-only; `http:` refused except loopback where explicitly allowed by shared validators; URL username/password/search/hash rejected; token/header redaction in errors/logs.

## config/* (MCP stdio path)

| Capability | Verdict | Evidence |
| --- | --- | --- |
| config/read (sessionId or cwd) | Supported | Live OK both forms. Returns `{config, skillsCount, hooksCount, mcpServersTotal, mcpServersEnabled, …}`. `config` shape is the effective runtime view (no raw `mcp_servers` list — counts only). |
| config/fields/read | Supported | Live OK: `{fields:[…~80…], targets:["user-toml","overrides"]}`. `mcp_servers` field: `{value:[], layerValues:[{layer:"default",value:[]}]}` when empty; after stdio write: `layerValues:[{layer:"user-toml",value:[{name,command,args,transport:"stdio",…normalized}]},{layer:"default",value:[]}]`. Authoritative per-layer source for read-modify-write. |
| config/effective/read | Supported | Live OK: `{config:{…full effective map…}}`. Used for providers/models display; never reconstructed into writes when secrets may be redacted. |
| config/write /mcp_servers with stdio | Supported (verified) | Live: `[{op:set, path:/mcp_servers, value:[{name:"s-stdio",command:"python",args:["-V"],transport:"stdio"}]}]` → success, `mcpServersTotal:1`, TOML gains `[[mcp_servers]] name/command/args/transport`. Minimal entry without `transport` is silently rejected (`rejected`/`failures` set, counts stay 0, TOML unchanged) — desktop always sends explicit `transport:"stdio"`. Full entry with `cwd`/`env` also accepted and normalized (`prompt/startup_timeout_sec/tool_timeout_sec/sampling_enabled/disabled/disabled_tools/env/cwd`). |
| config/write /mcp_servers with HTTP | Supported | Same op path with `{name,url,transport:"http"}` accepted. Desktop allows both, but HTTP adds/removes prefer `mcp_catalog/*` (official lifecycle); `config/*` is the leaf-edit/shadow-override path. |
| config/reload | Supported | Live OK with `reloadRuntime:false`. Desktop reloads runtime after config writes when requested. |
| Layer model | Supported (as exposed) | Upstream exposes `targets:["user-toml","overrides"]` + per-field `layerValues`. There is no separate `global/project/local` triple in 2.26.1 fields — `user-toml` is the writable user layer; project scoping arrives via `config/read {cwd}`, plugin ownership via `pluginName`, and catalog shadowing via readback. Desktop shows applied layer + effective state, never claims a write target it did not read from `config/fields`. |
| Secrets | Supported (preserve-only) | `config/write` validation rejects credential-bearing keys (`secret|password|token|authorization|headers|api_key` except `api_key_env_var`) and the desktop never rebuilds a full config from a redacted effective view. MCP stdio `env` values are treated as sensitive: never logged, never stored in drafts/localStorage, shown as "configured" only. No proprietary vault. |

Desktop stdio contract (new in M4): `command` + `args[]` separated (no shell string), optional `cwd` (absolute, non-UNC, exists-checked at runtime by Vibe — form validates shape only, never executes), optional `env` map (bounded, `NAME` pattern), `transport:"stdio"` always explicit, consent checkbox required, summary-before-save, edit/remove via list-level `config/write` from the authoritative `user-toml` layer value, readback via `config/fields/read` + `config/read` counts + `mcp_catalog/refresh`.

## connectors/* + connector_catalog/*

| Method | Verdict | Evidence |
| --- | --- | --- |
| connector_catalog/read | Supported | Live OK: `{catalog:{disposition:"memory",catalogRevision,connectors:[{alias,displayName,readiness,authAction,tools[],diagnostic}]}, selections, session, manageUrl}`. 16 connectors; `github_app` ready, rest `needs_auth` with `authAction:"oauth"`. |
| connector_catalog/refresh | Supported | Live OK: returns new `catalogRevision/selectionRevision/runtime`. |
| connector_catalog/toggle | Supported | Correct path for connector enable/disable + per-tool `toolName`. Desktop routes `kind:connector` toggles here (not `mcp/*`). |
| connector_catalog/auth/request | Declared (conflict-typed) | Live with already-connected `github_app` → `conflict: not actionable` (typed, honest). Unauthenticated OAuth flow needs account + browser — not completed in audit; desktop surfaces the controller link/event. |
| connectors/read | Supported (counts) | Live OK: `{counts:{connected:2,total:16}}` (detail lives in `mcp/read` sources + `connector_catalog/read`). |
| connectors/refresh | Supported (per-name) | Registry PARAM_KEYS lists only `sessionId`, but live without `name` → `invalid_params: name: Field required`; with `{name:"github_app"}` → `{toolCount:46, runtime}`. Desktop always sends `name`. Upstream param doc gap noted. |
| connectors/auth/read | Declared (conflict-typed) | Live with connected `github_app` → `conflict: not actionable`; with unknown name → `not_found`. Actionable OAuth state needs unauthenticated fixture — not available offline. |

Model: connectors are memory-catalog OAuth integrations surfaced inside `mcp/read` as `kind:"connector", transport:"connector"`. They are **not** `mcp_servers` entries and are never toggled via `mcp/toggle` (verified `not_implemented`). Plugin-owned vs user-owned distinguished by `pluginName`.

## plugins/* + agents/* + runtime/read + tools

| Method | Verdict | Evidence |
| --- | --- | --- |
| plugin_catalog/read, plugins/read | Supported | Live OK: `{plugins:{plugins:[{name:"vibe",version:"1.0.0",sourceFormat:"agent_plugins_1_0",scope:"builtin",components:[{kind:"skill",name…}×4],drifted:0}],dropped:[]}}`. Desktop shows catalog + loaded + dropped + components + issues; reload only — no fake Install/Uninstall (no upstream RPC). |
| plugin/info | Supported | Live OK: `{info:{workdir, components:[{kind:"skill",name,sourcePath,config}×4], raw, routes}}`. Source of per-component paths. |
| plugin/reload | Supported | Live OK: `{}`. Desktop offers explicit Reload + readback; warns it runs during active sessions. |
| agents/install, agents/uninstall | Declared | Live with unknown agent → `invalid_params: Agent 'nope' not found` (reachable, typed). Real install needs a valid agent package — not exercised; no UI install button is faked. |
| agents/list, tools/list, diagnostics/list, stats/read | Unavailable | Live `method_not_found` on Unified (consistent with M3). |
| runtime/read (tools/skills/agents/mcp/connectors/issues) | Supported (authoritative alternative) | Live OK: `runtime:{config, activeAgent, agents[4], skills[…full prompt…], tools[12 builtin:{name,isCustom}], connectors:{connected,total}, mcp:{sources…}, issues[], …}`. Desktop Tools Inspector + Agent Capabilities read this — never `tools/list`. Tool availability = `enabled:true` in `mcp.sources[].tools[]` + presence in `runtime.tools`; otherwise "not verifiable", never "available" from config alone. |
| diagnostics/logs/read | Supported | Live OK: `{logs:{entries:[{id,timestamp,level,message,rawLine}], hasMore, cursor}}`. Source of skill-detail 400 warnings etc. |
| account/read, identity/read, providerAuth/read | Supported (non-numeric) | Live OK: `account:{status,plan:{kind,name,title},…}` (no numeric quotas — dashboards remain official-external), `identity:{id,email,workspace,organization}`, `providerAuth:{modelDisplayName,providerName,apiBase}`. |

## ACP / editors

| Capability | Verdict | Evidence |
| --- | --- | --- |
| App-server desktop resources | Supported | Desktop uses app-server; no second ACP server runs in app. |
| Upstream `vibe-acp` presence | Official external + Supported detection | `EditorService.detectAcp()` resolves `vibe-acp(.exe)` via PATH stat without shell/execution. Guidance + snippet copy only; session sharing never claimed (same worktree ≠ same session). |
| Editor handoff open | Supported | Resolved exe + structured argv, authorized roots only, no shell interpolation, no secrets. |
| Terminal handoff | Supported (hardened in M4) | `wt.exe -d <folder>` preferred; fallback is direct `cmd.exe` spawn with structured argv (no shell string). Spawn errors surface, never false-confirm. `.cmd/.bat` editors route via `cmd.exe /d /s /c` with explicit quoting (no `shell:true`). See M4-F. |

## Runtime upgrade policy

Frozen at 2.26.1. An upgrade requires: (1) motivation, (2) exact pin, (3) compatibility diff, (4) regression run (146 + M4 tests, tsc, build, Playwright real-engine, packaged-app), (5) rollback (previous pin + backend hash). No upgrade performed in M4.
