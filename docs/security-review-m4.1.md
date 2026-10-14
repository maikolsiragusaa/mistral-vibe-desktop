# M4.1 security review addendum — data integrity, secret safety, Windows reliability

Scope: the M4.1 consolidation only (MCP mutation path, env/secret handling, Windows launchers, model-switch race). The M4 review (`security-review-m4.md`) still applies unchanged elsewhere. Findings are classified as **confirmed bug** (fixed with proof), **risk** (mitigated bounded), **limit** (declared), or **improvement** (done).

## MCP field loss (Finding A1) — confirmed bug, fixed

- The M4 dialog rebuilt the whole `mcp_servers` list from a 9-field projection, silently dropping `startup_timeout_sec`, `tool_timeout_sec`, `sampling_enabled`, `disabled_tools` and any unknown upstream field. `removeStdioServer()` had the same projection. Reproduced by code inspection plus live probes showing upstream preserves unknown fields (`mystery_future_field` round-trips through `config/write` into TOML).
- Fix: a single main-process `McpConfigService` performs **leaf-only** operations (`/mcp_servers/-` append, `/mcp_servers/<i>/<field>` set, field `remove`, index `remove`). Whole-list writes occur only when the baseline is empty. Verified live: neighbors are byte-identical after add/edit/disable/remove (real-engine integrity test, 13 s).
- Whole-element replacement (`set` on `/mcp_servers/<i>`) was probed and found **silently rejected** (`rejected:true` with `status:"applied"`); it is never used.

## Partial/uncertain outcomes — confirmed gap, fixed

- Upstream can return `status:"applied"` together with `rejected:true`/`failures[]`. The service inspects all three and classifies every mutation as `applied-verified | rejected | conflict | pending-reload | readback-failed | unknown`. Timeouts after send never trigger blind retries; the client must re-read first.
- Readback verifies changed values **and** neighbor integrity (canonical JSON), not just name presence.

## Concurrency — risk, mitigated bounded

- Same-app mutations are serialized through a per-service mutex; every mutation re-reads the authoritative layer immediately before writing and refuses on revision mismatch (SHA-256 fingerprint of the canonical list), missing/duplicated identity, or env keep-list drift.
- No compare-and-swap exists upstream, so races against external editors/CLI remain possible; the neighbor check turns a silent overwrite into a reported `readback-failed`/`unknown` instead of a false success. Documented as the residual race.

## Env secrets — confirmed bug, fixed

- M4 initialized the env textarea with `KEY=value` plaintext in React state. The dialog now holds only key names plus explicitly typed new values; existing values never enter renderer state, logs, notices, errors or screenshots (proven by unit JSON-blob assertions and Playwright `input[value=secret]`/`getByText(secret)` zero-count checks in dev and packaged builds).
- Env edits are keep/replace/remove per variable; unrelated edits send no env op at all (verified live: secret byte-identical after command-only edit).
- Backend validation now permits token-named keys **only** inside `mcp_servers/*/env` (scoped `mcpEnvScope` flag); provider/model/headers paths keep the strict credential-field rejection. Rationale: `GITHUB_TOKEN`-style variables are the canonical MCP env use case; blocking them would push users toward riskier workarounds. All env values remain redacted downstream.

## Windows launchers — confirmed hazard, contained

- Real-process proof: `cmd.exe` expands `%VAR%` inside arguments **despite `shell:false`**, so a batch wrapper receives a different path than the authorized one. The M4 `cmd /d /s /c` quoting construction additionally proved non-functional with real processes (exit 1: double-quoting layers).
- Decision: custom `.cmd/.bat` editors are **refused** with an explicit message; only direct `.exe` launches are supported. Backend preference validation and stored-preference migration match (legacy batch paths are dropped on load, never launched). Known-editor detection was already `.exe`-only.
- Spawn confirmation now waits for the OS `spawn` event (bounded 1.5 s) and treats async `error` as launch failure; renderer copy distinguishes "process started" from "opened". A late async error can no longer crash the app as an unhandled event.
- Terminal fallback keeps the direct `cmd.exe /d` + `cwd` design (folder never parsed as command text), now with pid reporting and a real-process test that kills exactly the started process (no orphans).

## Model-switch race — confirmed race, fixed

- The picker trusted the `config/model/write` receipt; on slower hosts the receipt predates the applied model, leaving a stale label with no further refresh scheduled (packaged CI first-attempt failure on `Model: GLM 5.3`).
- Fix: `writeModelAndConfirm` polls `runtime/read` (400 ms, ≤10 s) for the requested alias/effort before adopting it; on timeout it adopts the latest read and shows an explicit pending notice. The Playwright gate now waits for the authoritative alias (exact match, no version fallback) before asserting the button.

## Residual limits (declared)

- External-editor/CLI races: detected when neighbors change, reported, never silently overwritten — but not prevented (no upstream CAS).
- Registry skill writes, connector OAuth completion, Teleport E2E: unchanged account gates.
- `pending-reload` (write accepted during an active turn) relies on a later refresh to confirm liveness.
- `npm audit` covers the JS tree only.
