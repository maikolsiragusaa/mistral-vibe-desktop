/** M3 user-chosen worktree directories — pure client-side helpers.
 *
 * The main process re-validates everything (realpath, junction/symlink, UNC,
 * permissions, collisions, repo identity, branch existence, non-empty target,
 * inside-repo / inside-another-worktree, volume). These helpers only shape
 * the preview + local pre-checks so the UI can explain refusals early.
 */

export type WorktreeRootKind = "managed" | "custom";

export function previewWorktreePath(
  rootDir: string,
  namespace: string,
  name: string,
): string {
  const clean = rootDir.replace(/[\\/]+$/, "");
  const sep = clean.includes("/") && !clean.includes("\\") ? "/" : "\\";
  return `${clean}${sep}${namespace}${sep}${name}`;
}

export function sanitizeWorktreeDirName(branchOrName: string): string | null {
  if (branchOrName.includes("..")) return null;
  const name = branchOrName.replaceAll("/", "-").trim();
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name)) return null;
  if (name === "." || name === "..") return null;
  return name;
}

/** Local pre-check for a custom root string (main process decides). */
export function precheckCustomRoot(raw: unknown): string | null {
  if (typeof raw !== "string") return "Choose a folder for worktrees";
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 4096 || trimmed.includes("\0"))
    return "Choose a folder for worktrees";
  const abs =
    /^[A-Za-z]:[\\/]/.test(trimmed) ||
    trimmed.startsWith("\\\\") ||
    trimmed.startsWith("/");
  if (!abs) return "Custom worktree folder must be absolute";
  if (trimmed.startsWith("\\\\")) return "UNC paths are not used for worktrees here";
  return null;
}

/** Disk-usage row for the managed-space view (measured only, never guessed). */
export interface WorktreeDiskRow {
  path: string;
  branch?: string | null;
  bytes: number | null;
  files: number | null;
}

export function formatBytes(bytes: number | null): string {
  if (bytes == null || !Number.isFinite(bytes)) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}
