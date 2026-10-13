/** M3 editor handoff — pure helpers (no side effects).
 *
 * Filesystem handoff only: opening the same worktree in an editor does NOT
 * attach the editor to the same agent session. Session continuity is never
 * claimed. All launches use resolved executables + structured argv (no shell
 * interpolation); secrets and prompt internals are never passed.
 */

export type KnownEditorId =
  | "vscode"
  | "vscode-insiders"
  | "vscodium"
  | "cursor"
  | "custom";

export interface EditorCandidate {
  id: KnownEditorId;
  label: string;
  /** Resolved absolute executable path, or null when not detected. */
  exePath: string | null;
  /** Whether detection is verified (exists + executable) vs guessed. */
  verified: boolean;
}

export interface HandoffTarget {
  /** Absolute workspace folder that is already an authorized project root. */
  folder: string;
  /** Optional repository-relative file to open. */
  file?: string | null;
  /** 1-based line, when the editor supports --goto. */
  line?: number | null;
}

/** Validate a user-configured custom editor path (renderer-side pre-check).
 * Main process re-validates existence/executability before any launch. */
export function validateCustomEditorPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 4096 || trimmed.includes("\0")) return null;
  // Must be absolute; no URLs, no shell fragments, no argument smuggling.
  if (/^[a-zA-Z]+:\/\//.test(trimmed)) return null;
  if (/[;&|`$]/.test(trimmed)) return null;
  const isWindowsAbs = /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith("\\\\");
  const isPosixAbs = trimmed.startsWith("/");
  if (!isWindowsAbs && !isPosixAbs) return null;
  return trimmed;
}

/** Validate a handoff target: folder must be absolute; file must be
 * repository-relative (no absolute/UNC/drive/traversal/.git/ADS). */
export function validateHandoffTarget(target: HandoffTarget): string | null {
  if (!target || typeof target.folder !== "string") return "A workspace folder is required";
  const folder = target.folder.trim();
  if (!folder || folder.length > 4096 || folder.includes("\0"))
    return "A workspace folder is required";
  const abs =
    /^[A-Za-z]:[\\/]/.test(folder) || folder.startsWith("\\\\") || folder.startsWith("/");
  if (!abs) return "Workspace folder must be absolute";
  if (target.file == null) return null;
  if (typeof target.file !== "string" || !target.file) return null;
  const portable = target.file.replaceAll("\\", "/");
  if (
    portable.startsWith("/") ||
    /^[A-Za-z]:/.test(portable) ||
    portable.startsWith("//") ||
    portable.split("/").some((p) => p === "..")
  )
    return "File must stay inside the workspace";
  for (const piece of portable.split("/").filter(Boolean)) {
    if (piece.includes(":")) return "File must stay inside the workspace";
    const stripped = piece.replace(/[. ]+$/, "");
    if (!stripped || stripped.toLowerCase() === ".git")
      return "File must stay inside the workspace";
  }
  if (target.line != null) {
    if (!Number.isInteger(target.line) || target.line < 1 || target.line > 1_000_000)
      return "Line number is invalid";
  }
  return null;
}

/** Build structured argv for `exe --goto file:line` style editors.
 * Returns null when the target is invalid. Never interpolates a shell. */
export function buildEditorArgv(
  editorId: KnownEditorId,
  target: HandoffTarget,
): string[] | null {
  if (validateHandoffTarget(target)) return null;
  const folder = target.folder;
  if (target.file) {
    const sep = folder.includes("/") && !folder.includes("\\") ? "/" : "\\";
    const rel = target.file.replaceAll("/", sep);
    const full = `${folder.replace(/[\\/]+$/, "")}${sep}${rel}`;
    // VS Code family + Cursor support `code --goto file:line` / folder + file.
    if (target.line != null) return [folder, "--goto", `${full}:${target.line}`];
    return [folder, full];
  }
  return [folder];
}

/** Short label for the editor picker; never promises unverified editors. */
export function editorDisplayLabel(candidate: EditorCandidate): string {
  if (candidate.verified && candidate.exePath) return candidate.label;
  return `${candidate.label} (not found)`;
}

/** ACP guidance: filesystem handoff vs conversation continuity. */
export const ACP_HANDOFF_NOTE =
  "Opening this folder in your editor reuses the files on disk. " +
  "It does not attach the editor to this agent session. " +
  "To drive the same session from an editor, configure the official " +
  "`vibe-acp` agent in that editor; the desktop never runs a second ACP server.";
