const SKILL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/;
const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MCP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

export function validMcpEndpoint(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export function validApiBase(value: string): boolean {
  try {
    const url = new URL(value.trim());
    if (url.username || url.password || url.search || url.hash) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && LOOPBACK.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function sanitizeUrlForDisplay(value: unknown): string {
  if (typeof value !== "string") return "Not reported";
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "Invalid URL";
  }
}

export function validSkillId(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= 512 && SKILL_ID_PATTERN.test(trimmed);
}

export function validSkillName(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= 256 && SKILL_NAME_PATTERN.test(trimmed);
}

export function validSkillAlias(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= 256 && SKILL_NAME_PATTERN.test(trimmed);
}

export function validSkillVersion(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

export function validScope(value: string): boolean {
  return value === "" || value === "global" || value === "project" || value === "local";
}

export function validMcpName(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= 128 && MCP_NAME_PATTERN.test(trimmed);
}

export function validStdioCommand(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 1024) return "Enter the executable path or name.";
  if (trimmed.includes("\0") || /[\r\n]/.test(trimmed)) return "Command contains invalid characters.";
  if (/[;&|`$]/.test(trimmed)) return "Use separate arguments instead of shell operators.";
  return null;
}

export function parseArgsText(value: string): { args: string[]; error: string | null } {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length > 64) return { args: [], error: "Use at most 64 arguments." };
  for (const line of lines) {
    if (line.length > 4096) return { args: [], error: "One argument is too long." };
    if (line.includes("\0")) return { args: [], error: "Arguments cannot contain null bytes." };
  }
  return { args: lines, error: null };
}

export function parseEnvText(value: string): {
  entries: Array<{ key: string; value: string }>;
  error: string | null;
} {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (lines.length > 64) return { entries: [], error: "Use at most 64 variables." };
  const entries: Array<{ key: string; value: string }> = [];
  for (const line of lines) {
    const separator = line.indexOf("=");
    if (separator <= 0) return { entries: [], error: `Invalid line (expected KEY=value): ${line.slice(0, 40)}` };
    const key = line.slice(0, separator).trim();
    const entryValue = line.slice(separator + 1);
    if (!ENV_NAME_PATTERN.test(key)) return { entries: [], error: `Invalid variable name: ${key.slice(0, 40)}` };
    if (entryValue.length > 8192) return { entries: [], error: `Value too long for ${key}` };
    entries.push({ key, value: entryValue });
  }
  return { entries, error: null };
}

export function validStdioCwd(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 4096) return "Working directory path is too long.";
  if (trimmed.includes("\0")) return "Working directory path is invalid.";
  if (trimmed.startsWith("\\\\")) return "UNC working directories are not supported.";
  const windowsAbs = /^[A-Za-z]:[\\/]/.test(trimmed);
  const posixAbs = trimmed.startsWith("/");
  if (!windowsAbs && !posixAbs) return "Working directory must be absolute.";
  return null;
}

export function statusLabel(status: string | undefined): string {
  switch ((status ?? "").toLowerCase()) {
    case "connected":
    case "ready":
      return "Connected";
    case "needs_auth":
    case "needs-auth":
      return "Awaiting auth";
    case "disabled":
      return "Disabled";
    case "error":
      return "Error";
    default:
      return "Unknown";
  }
}
