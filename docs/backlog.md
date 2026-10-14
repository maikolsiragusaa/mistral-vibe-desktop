# Next increments

The 0.3.0-M1 increment adds Code/Work + Local/Cloud foundation, live subagent
navigation, tab-close vs stop separation, official session fork/rewind/rename/
markAsSeen/compact/delete, durable opt-in drafts, loops GUI and Cloud panels
through projectLinks/vibeCode/teleport with preflight. The backend allowlist
now covers ~60 official methods with pool isolation.
M1.1 hardens it: fork ownership (detached forks worker-free), subagent sync
states with three-child live proof, drafts off-by-default with migration,
real preflight, loop safety, capability detection and a recorded security
review. The [capability matrix](capabilities.md) records their exact boundaries.

| Priority | Next increment                             | Acceptance                                                                                                                                              |
| -------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1        | Windows 11 clean-machine install/uninstall | Use the NSIS artifact without Python/uv, connect, open a project and uninstall through normal Windows controls.                                         |
| 1        | Hosted account conformance                 | With an explicitly authorized account and model budget, complete browser sign-in and verify Mistral-hosted reasoning, image input and real quota pages. |
| 1        | Upstream Unified protocol parity           | Dispatch review and diagnostic methods consistently, expose generation-only timing/cached attribution, and settle MCP source-layer mutation behavior.   |
| 2        | Git hunk staging and stronger attribution  | Stage selected hunks, keep dirty baselines across app restarts and distinguish observed agent touches from exclusive authorship.                        |
| 2        | Managed worktree navigation                | Navigate held/dirty/unpushed worktrees through upstream APIs with appropriate user decisions.                                                           |
| 2        | Skill registry lifecycle (M4 shipped)      | Import, alias, version/latest, convertLocal and remove UI with readback; live registry writes remain account-gated and are surfaced honestly. Remaining: authenticated registry E2E with an authorized account. |
| 2        | Local MCP setup (M4 shipped)               | Structured stdio editor via official config/mcp_servers (command+argv split, cwd, env, consent, readback) with Windows validation. Remaining: live tool discovery timing for slow starters. |
| 2        | Durable unsent drafts (M1 done)            | Opt-in renderer localStorage, Settings toggle, no session journal. Verify across full restart.                                                          |
| 2        | Session fork/rewind UI polish              | Fork-rewind vs in-place confirmation is shipped; add entry picker and restore-files preview.                                                             |
| 2        | Cloud Teleport end-to-end                  | Git-repo preflight is shipped; verify with an authorized Pro/Team account without claiming bidirectional sync.                                           |
| 3        | Signed distribution and updates            | Use an authorized signing identity and a reviewed update channel.                                                                                       |
| 3        | Editor handoff and notifications           | Reuse ACP/editor integrations and explicit notification preferences.                                                                                    |

Hosted Work scheduled tasks remain an explicit official-surface link, not a
local replica. No private endpoints are used. Work continues on the existing
branch and PR; no release or main-branch merge is performed by these build
checks. The exact upstream candidates and acceptance cases are recorded in
[upstream integration follow-ups](upstream-gaps.md).
