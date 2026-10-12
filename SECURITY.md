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

Please report a vulnerability privately to the repository owner through
[GitHub private vulnerability reporting](https://github.com/maikolsiragusaa/mistral-vibe-desktop/security/advisories/new)
when available. Include the affected version, reproduction steps and the
observable impact. Use a disposable project and redact credentials. Upstream
engine vulnerabilities should also reach
[Mistral Vibe's security process](https://github.com/mistralai/mistral-vibe/blob/main/SECURITY.md).
