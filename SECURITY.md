# Security

Vibe Desktop runs a local coding agent with the access of the signed-in Windows
user. Vibe's agent mode, workspace trust and tool permissions determine what
the engine may do. The desktop displays those decisions and does not introduce
an approval bypass.

The renderer is sandboxed, has no Node integration and uses an explicit IPC
allowlist. Prompts and credentials do not enter desktop logs. API keys are
stored by upstream Vibe, which prefers the operating system keyring and has a
documented `.env` fallback. MCP servers, project skills and hooks are executable
configuration; Vibe's trust workflow applies to them.

Browser sign-in delegates to Vibe's existing PKCE controller. The helper owns
the exchange and persistence; desktop status contains only whitelisted metadata.
MCP authorization links remain in the main process behind short-lived opaque
IDs. Project-controlled endpoint configuration is changed only through explicit
management actions and Vibe's config methods.

Official quota pages open in an isolated sandboxed browser with no preload or
desktop IPC. Their cookies use a separate persistent partition. The app does
not scrape account pages or ask for an organization admin key.

Git operations are restricted to selected canonical roots. The client exposes
explicit staging, unstaging and commit actions; PR creation uses installed `gh`
authentication and requires an already published synchronized branch. It does
not run automatic push, reset, clean or worktree removal operations.

Please report a vulnerability privately to the repository owner through
[GitHub private vulnerability reporting](https://github.com/maikolsiragusaa/mistral-vibe-desktop/security/advisories/new)
when available. Include the affected version, reproduction steps and the
observable impact. Use a disposable project and redact credentials. Upstream
engine vulnerabilities should also reach
[Mistral Vibe's security process](https://github.com/mistralai/mistral-vibe/blob/main/SECURITY.md).
