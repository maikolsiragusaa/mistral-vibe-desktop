# Next increments

The first checkpoint proves the Windows delivery surface and the upstream
protocol. The next work should deepen the coding workflow while preserving one
engine and one persistence owner.

| Priority | Increment                                                            | Acceptance                                                                                                                   |
| -------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1        | Windows 11 clean-machine installation and uninstall                  | Install the NSIS artifact without Python/uv, open a project, connect and remove the app through normal Windows controls.     |
| 1        | Hosted Mistral conformance with an explicitly authorized test budget | Verify actual credentials, streaming, tool execution and usage reporting with a Mistral-hosted model.                        |
| 1        | Unified Harness review and managed-worktree navigation               | Adopt upstream review when the default engine dispatches it; validate dirty, held and unpushed worktree states through Vibe. |
| 2        | Concurrent sessions                                                  | One owned app-server connection per attached root, clear active-turn status and backend lease conflicts.                     |
| 2        | Browser sign-in                                                      | Reuse an upstream public auth bridge when available, or justify a small tested adapter to the existing PKCE flow.            |
| 2        | Subagent transcript navigation                                       | Read public child-session histories and retain upstream control rules.                                                       |
| 2        | MCP, skills and plugin configuration views                           | Use the official catalog/configuration methods rather than a second extension system.                                        |
| 3        | Windows notifications and editor handoff                             | Explicit user preferences, no new telemetry sink.                                                                            |
| 3        | Signed distribution and footprint measurements                       | Configure an authorized signing identity; measure startup, memory and package size before reconsidering the shell.           |

The client currently supports one attached conversation at a time. It reads
worktrees and displays subagent activity, while the fuller management interfaces
above remain open work. Account browser sign-in, cloud teleport, automatic
updates and a released signed installer are not shipped in this checkpoint.
