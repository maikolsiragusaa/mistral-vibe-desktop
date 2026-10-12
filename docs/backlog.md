# Next increments

The 0.2 increment adds the Windows titlebar, model picker, management window,
Git workflow, browser-auth adapter, concurrent sessions and local observability.
The [capability matrix](capabilities.md) records their exact boundaries.

| Priority | Next increment                             | Acceptance                                                                                                                                              |
| -------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1        | Windows 11 clean-machine install/uninstall | Use the NSIS artifact without Python/uv, connect, open a project and uninstall through normal Windows controls.                                         |
| 1        | Hosted account conformance                 | With an explicitly authorized account and model budget, complete browser sign-in and verify Mistral-hosted reasoning, image input and real quota pages. |
| 1        | Upstream Unified protocol parity           | Dispatch review and diagnostic methods consistently, expose generation-only timing/cached attribution, and settle MCP source-layer mutation behavior.   |
| 2        | Git hunk staging and stronger attribution  | Stage selected hunks, keep dirty baselines across app restarts and distinguish observed agent touches from exclusive authorship.                        |
| 2        | Managed worktree navigation                | Navigate held/dirty/unpushed worktrees through upstream APIs with appropriate user decisions.                                                           |
| 2        | Skill registry lifecycle                   | Import, alias, update and remove skills through existing upstream methods with authenticated end-to-end coverage.                                       |
| 2        | Local MCP setup                            | Add a structured stdio editor that preserves credential-bearing configuration and validates Windows command forms.                                      |
| 2        | Durable unsent drafts                      | Define opt-in local retention and recovery without creating a second session journal.                                                                   |
| 3        | Signed distribution and updates            | Use an authorized signing identity and a reviewed update channel.                                                                                       |
| 3        | Editor handoff and notifications           | Reuse ACP/editor integrations and explicit notification preferences.                                                                                    |

Cloud teleport, hosted Work/Chat and automatic releases remain outside the
current local desktop increment. Work continues on the existing branch and PR;
no release or main-branch merge is performed by these build checks.
The exact upstream candidates and acceptance cases are recorded in
[upstream integration follow-ups](upstream-gaps.md).
