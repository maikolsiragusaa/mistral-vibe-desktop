# M4 adversarial security review — extensions, skills, MCP & ecosystem

Scope: remote MCP, local stdio MCP, skills lifecycle, plugins/connectors, Electron IPC, secrets handling. Runtime frozen at 2.26.1. Findings are classified as **confirmed bug** (fixed), **risk** (mitigated bounded), **limit** (declared), or **improvement** (done or deferred).

## Remote MCP

- Third-party servers / malicious metadata — **risk, mitigated**. Descriptions/prompts render as text; skill/MCP bodies render in `<pre>`, never executed; no auto-execution of commands from descriptions. Import requires explicit trust consent.
- HTTP vs HTTPS / redirects — **mitigated**. `mcp/add` + `mcp_catalog/add` enforce HTTPS-only, reject username/password/search/hash; `allowInsecureHttp:true` rejected in backend validation. OAuth redirects stay in the upstream controller; desktop only opens `authLink` ids via `openAuthLink` with expiry.
- Authenticated vs not — **mitigated**. `needs_auth` / `needs_setup` show "Awaiting auth" + Sign in; `connected` vs `disabled` vs `error` are distinct badges with text (not color-only). No "available" claim without connected + announced tools.
- URL creds — **confirmed handling**. Validators reject embedded credentials; error redaction strips `Bearer` + token patterns + URLs before display/logs.
- Huge responses — **mitigated**. RPC cap 16 MiB; config ops ≤100, items ≤128, depth ≤8; UI truncates descriptions (220 chars in tools list) and errors (280 chars).
- Timeouts/connection errors — **mitigated**. Pending states per mutation; failures surface as visible errors with readback mismatch, never false confirmations.

## Local stdio MCP

- Malicious executable / PATH hijacking — **risk, mitigated bounded**. Command is an executable + separate argv (never a shell string); `[;&|`$]` rejected; bare names allowed but flagged by consent copy ("will execute local software") and summary line. No PATH resolution or auto-install is performed; npx/uvx-style launchers are treated like any other command (explicit string, user responsibility) — documented limit.
- `.cmd/.bat` wrappers — **improvement, done**. Previously allowed but unlaunchable with `shell:false`. Now routed via `cmd.exe /d /s /c` with individually quoted args, no `shell:true`. Quoting rejects `"` / CR / LF / NUL in every element.
- Argument injection — **mitigated**. Args are one-per-line, passed as array elements; validated length/count; never interpolated into a command string. Env is `KEY=value` per line with `ENV_NAME` keys, bounded counts/lengths.
- Environment leakage — **mitigated**. Env values never logged, never stored in drafts/localStorage; error redactor covers token-like keys; config/write validation rejects credential-bearing keys outside the official credential store.
- Process cleanup — **verified**. stdio proof (isolated home, `test-mcp.py` fixture): configure → counts 1/1 → disable → 1/0 → remove → 0/0, backend exits cleanly, no `test-mcp` python process lingers. Vibe owns the child lifecycle; desktop never spawns MCP servers itself.
- Working directory — **mitigated**. Must be absolute, non-UNC; existence/startup failures surface as `unavailable`/error status with readback, never as success. Junction/symlink resolution stays with Vibe; concurrent config edits are last-writer-wins with readback mismatch errors (no silent merge).
- Wrong scope / redacted secrets — **mitigated**. Writes use the authoritative `config/fields` layer value for `mcp_servers` (per-layer, not the redacted effective merge); unmodified entries are preserved byte-for-byte; leaf writes carry the exposed `targetLayer`. No vault is invented.
- Restart semantics — **declared limit**. `config/write` sends `reloadRuntime:true`; if Vibe reports pending/deferred application, the UI surfaces it instead of claiming immediate effect.
- Plugin-owned MCP — **mitigated**. `pluginName`/`plugin_name` entries show "Managed by plugin …" and disable mutation controls; toggles route connectors to `connector_catalog/toggle`, never `mcp/toggle` (verified `not_implemented` upstream).

## Skills

- Unauthorized import — **mitigated**. Import requires session + valid skillId + trust checkbox + optional version/alias/scope validation; readback requires the skill to appear in `skills/installed`.
- Malformed ids / version / alias conflicts — **mitigated**. Strict patterns + positive-integer versions + scope allowlist in renderer and backend (`validateSkillMutation`); upstream errors surface verbatim (redacted).
- Wrong-scope removal — **mitigated**. Scope selector is explicit (default = session default); removal requires a second acknowledgement checkbox; readback requires absence; canonical `name` is the only identity (never list index).
- Third-party instructions — **mitigated**. Prompts render as text in `<pre>`; import copy states "never executes skill commands automatically"; update/remove are explicit buttons, not auto-applied.
- Direct harness directory edits — **not done, by design**. No file writes to internal harness/plugin dirs; all mutations go through official RPC.

## Plugins / connectors

- Untrusted origin / malformed catalog — **mitigated**. Adapters tolerate missing/extra fields, drop nameless entries, show `dropped` descriptors with messages; no Install/Uninstall buttons exist (honest copy references the missing upstream RPC).
- Loaded ≠ configured — **mitigated**. Catalog + `plugin/info` components + `dropped` + drift badge shown together; reload is explicit with readback + active-session caution implied by manual action.
- Reload during sessions — **risk, bounded**. Reload is user-initiated only, never automatic; post-reload catalog+info+runtime are re-read and failures surface.
- Plugin-owned resources — **mitigated** (see MCP). Connector vs server toggles are routed correctly (`connector_catalog/toggle` vs `mcp_catalog/toggle`).
- Capability overclaim — **mitigated**. Tools Inspector reads `runtime/read` only; states are observed/configured/not-verifiable; no execution from the list; `tools/list` is never the source.

## Electron / bridge

- IPC sender verification — **kept**. `assertTrustedSender` (main frame + trusted URL) on every handler; no new channels added (all resource calls reuse validated `vibe:request` + existing editor/auth/git channels).
- CSP / isolation / sandbox — **unchanged**. Renderer stays sandboxed, context-isolated, no Node integration; quota/preview windows keep their partitions; no local file exposure outside authorized roots.
- Redacted output/logs — **kept + extended**. `safeError`/`getErrorMessage` redact Bearer/tokens/URLs; MCP env values never enter logs/drafts; OAuth callbacks stay in controller events.
- Arbitrary navigation — **kept**. `openExternal` allowlist unchanged (Mistral HTTPS + repo + validated gh PR links); quota dashboards use fixed entry points.
- Backend protections — **strengthened, not weakened**. `SAFE_MCP_FIELDS` extended only with stdio fields under strict per-field validation; credential keys still rejected; `mcp/add` contract unchanged (HTTP-only); frontend hardening (terminal fallback, `.cmd` routing) adds checks without loosening any existing gate.

## Residual limits (declared, not fixed here)

- Slow-starting stdio servers may report `unavailable` with zero tools right after refresh; the UI reports this honestly and asks for re-refresh rather than claiming failure/success.
- Live registry import/version/remove writes need an authorized account + network registry; contract-tested + readback-wired, but no live registry mutation was performed in this milestone.
- Connector OAuth completion needs an account + browser; covered as delegated-controller transport + mocked shapes, not a live OAuth exchange.
- Hostile-local TOCTOU outside verified windows, external processes outside pool control, and volume/disk privileged APIs remain as in M3.
