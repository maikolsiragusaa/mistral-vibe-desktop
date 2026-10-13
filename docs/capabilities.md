# Desktop capabilities

Vibe Desktop 0.3.0-M1 uses Mistral Vibe 2.26.1. A visible control either calls
the official runtime or performs an explicit, bounded operation in the selected
Git repository. This page describes the shipped boundary.

| Area           | Desktop behavior                                                                                                                                                                  | Remaining boundary                                                                                                                                                                                                                      |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows        | Hidden titlebar with native controls overlay, Code/Work + Local/Cloud selectors, themed chrome, resizing and minimum width                                                       | Mica is enabled on supported Windows builds; solid surfaces remain elsewhere. A clean Windows 11 install/uninstall still needs validation.                                                                                               |
| Identity       | Original stepped mark and Ember companion, six activity states, optional motion                                                                                                   | Mistral's cat and proprietary font are not distributed.                                                                                                                                                                                 |
| Models         | Runtime inventory, search, provider/API identity, image capability, context and reasoning levels                                                                                  | Configured/selectable/observed-successful use are separate. Hosted entitlement requires a real account response.                                                                                                                        |
| Sessions       | Four owned app-server connections, tabs, switch/resume, search, pin/archive, rename, fork, rewind, markAsSeen, probed compact, relocate, delete, lease notifications and opt-in drafts | Tab close detaches without stopping (empty tabs stop to free the slot); stop/delete are explicit with confirmations. Attached forks allocate; detached forks persist without workers. Drafts persist across restart only when explicitly enabled (off by default); history stays in Vibe. |
| Composer       | Text, PNG/JPEG/WebP, UTF-8 files, previews, paste/drop, remove, prompt recall and IME handling                                                                                    | Six attachments, 8 MiB combined; text files are limited to 256 KiB. Images require an accepting model.                                                                                                                                  |
| Prompt queue   | Native enqueue/remove/resume, steering and interruption                                                                                                                           | Queue replacement and editing are not exposed in the desktop.                                                                                                                                                                           |
| Subagents      | Live navigable child conversation (session/read + error backoff, hidden-suspend, stale guards, event nudges, history paging), breadcrumb parent/child, sync state + retry; snapshot inspect kept | Child sessions remain read-only and controlled by their parent. No direct child commands, no ownership transfer, no inferred progress percentages. Proven with three concurrent fixture children. |
| Code Cloud     | projectLinks/* list, vibeCode/projects/* picker, one-way Teleport preflight (verified Git repo via git/status, provider-record model check, credentials; tier/GitHub-App unknown by design) | Teleport end-to-end needs an authorized Pro/Team account and GitHub App; no bidirectional sync is promised. Picker opening and transfer completion are reported distinctly. Cloud uses Mistral sandboxes only. |
| Work           | Explicit official-surface panel (Vibe web, scheduled-tasks docs); no local replica                                                                                               | No public Work-task API is available to the desktop; remote lists are never faked. Scheduled tasks run hosted in Work mode only.                                                                                                        |
| Automations    | loops/create\|list\|delete\|clear GUI with two-step Clear All, canonical-id deletes, pending states and backend-liveness honesty                                                    | Loops fire only while the session backend runs. No unattended service is claimed. Windows Task Scheduler integration is future work with explicit authorization design.                                                                   |
| Git            | Branch, status, file diff, stage/unstage, commit, log, worktrees and PR discovery                                                                                                 | Whole-file staging; hunk staging and destructive discard are not shipped. Worktree remove/reap allow subpaths of the selected project; dirty/unpushed navigation with user decisions is next.                                          |
| Attribution    | Initial dirty-file baseline and paths present in actual Vibe write effects                                                                                                        | A path touched by the agent may also contain user edits; the client cannot prove exclusive authorship.                                                                                                                                  |
| Pull requests  | Existing GitHub links and explicit creation via an installed, authenticated `gh`                                                                                                  | Creation requires an already published, synchronized branch. No automatic push, merge or GitHub credential system.                                                                                                                      |
| MCP            | Catalog, tools, toggles, HTTPS OAuth server add/remove and upstream sign-in; mcp/* passthrough validated                                                                         | Local stdio editor remains future desktop work. Plugin-owned sources are managed by their plugin.                                                                                                                                       |
| Skills         | Installed instructions, search, official enable/disable, registry browse/detail; skills/* lifecycle validated in backend                                                          | Registry import/alias/version/remove UI remains M4 work; backend already validates the official shapes.                                                                                                                                 |
| Plugins        | Discovery, components, issues and reload                                                                                                                                          | Upstream exposes no general plugin installation/removal RPC.                                                                                                                                                                            |
| Providers      | Target-layer-aware API base edits, provider/model additions and official credential storage                                                                                       | Existing secret-bearing provider records are never reconstructed from a redacted effective config.                                                                                                                                      |
| Authentication | Existing Vibe credentials, official key storage and delegated browser controller                                                                                                  | Live browser completion requires the user's account; local tests cover controller transport and safe output.                                                                                                                            |
| Observability  | Measured context input/output/headroom, cumulative tokens, tool counters and configured-rate API estimate                                                                         | Unmeasured cache and duration values are labeled. Token throughput is not displayed.                                                                                                                                                    |
| Quotas         | Account plan/key scope plus isolated official dashboard windows                                                                                                                   | `account/read` exposes no numeric remaining quotas. API usage and subscription allowance remain distinct.                                                                                                                               |
| ACP            | Editor integration guidance                                                                                                                                                       | Desktop uses app-server. Editors can use upstream `vibe-acp`; no second ACP server runs inside the app.                                                                                                                                 |

## Context and reasoning

The ring uses the latest `session.contextUsage` measurement and the runtime's
context window. Input and latest output form the exposed partition. Session
input/output totals are cumulative and do not replace the context measurement.
System prompts, tool schemas and individual messages are not separately counted
by this public interface.

The composer exposes the current model's public `thinkingLevels` through a
direct picker. Changes use `config/model/write`, preserve history and are
disabled during active turns. The desktop displays public reasoning entries
when Vibe supplies them, with an open streaming state and a collapsible result.
It does not reconstruct reasoning that the provider does not expose.

## Account usage

Quota windows are rendered by Mistral in a separate sandboxed browser window.
It has no desktop preload or privileged IPC, a separate cookie partition and
fixed official entry points. Sign-in stays on Mistral HTTPS origins. Enterprise
SSO that redirects elsewhere can use the normal browser from Mistral's account
page. The client does not scrape billing pages or collect an Admin API key.

Mistral documents organization usage/limits in [Usage and limits](https://docs.mistral.ai/admin/billing-usage/usage-limits)
and [Admin API usage metrics](https://docs.mistral.ai/admin/admin-api/usage-metrics).
Admin API availability and credentials differ from ordinary inference keys.

## Upstream integration gaps

The real 2.26.1 Unified adapter still returns `method_not_found` for `review/*`,
`stats/read`, `diagnostics/list` and `tools/list` (live M1 probe, 13 Oct 2026).
Git review is a client repository view; statistics and issues come from
`runtime/read`. `session/compact` reports not implemented upstream.
`session/history/get` exists but can report session-not-found for fresh
sessions; `session/turns/list` works. `skills/versions|updates`,
`mcp/refresh`, `session/settings/update` and `loops/*` work.
`vibeCode/projects/open` requires a Git repository; Teleport is one-way to
Medium 3.5.

MCP catalog toggles edit the default persistence layer. A project declaration
can shadow that layer. The desktop checks readback and, when needed, uses a
leaf `config/write` in the exposed source layer followed by catalog refresh.
Existing environment values, headers and authentication references stay with
Vibe. A failed readback is shown as an error rather than a successful toggle.

Unified subagents in 2.26.1 use `run_typescript` and the public
`tools.subagent.spawn`/`wait` namespace. The generic child inherits the parent's
prompt/tools; the legacy `task`/Explore route is not the Unified fixture path.
