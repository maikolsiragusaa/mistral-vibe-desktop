/** Single Git IPC adapter: structured calls, uniform errors, shared format. */

import type { GitFile } from "./git-types";

export function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").toLowerCase();
}

export function projectRelativePath(
  value: string,
  projectPath: string,
): string | null {
  const candidate = normalizePath(value).replace(/\/$/, "");
  const root = normalizePath(projectPath).replace(/\/$/, "");
  if (candidate === root) return null;
  if (candidate.startsWith(`${root}/`)) return candidate.slice(root.length + 1);
  if (/^[a-z]:\//.test(candidate) || candidate.startsWith("/")) return null;
  return candidate;
}

export function shortHash(hash: string | null | undefined): string {
  return hash ? hash.slice(0, 8) : "—";
}

export function fileStateLabel(
  file: GitFile,
  baseline: Set<string>,
  agentPaths: Set<string>,
) {
  const key = normalizePath(file.path);
  if (baseline.has(key)) return "Pre-existing";
  if (agentPaths.has(key)) return "Agent touched";
  return "New change · source unknown";
}

export function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function gitRequest<T>(
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  if (!window.vibe?.git)
    throw new Error("The local Git workspace bridge is unavailable.");
  return window.vibe.git<T>(method, params);
}
