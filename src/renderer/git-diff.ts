/** Pure unified-diff parsing for the Git workspace review UI. */

export type DiffLineType =
  | "context"
  | "add"
  | "remove"
  | "hunk"
  | "meta"
  | "file"
  | "noeol";

export interface DiffLine {
  type: DiffLineType;
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface DiffHunk {
  id: string;
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

export function classifyLine(line: string): DiffLineType {
  if (line.startsWith("diff --git ") || line.startsWith("index ")) return "meta";
  if (line.startsWith("--- ") || line.startsWith("+++ ")) return "file";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("\\ No newline")) return "noeol";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "remove";
  return "context";
}

export function isBinaryDiff(diffText: string): boolean {
  return /^Binary files .* differ/m.test(diffText);
}

export function hasCrlf(diffText: string): boolean {
  return /\r\n/.test(diffText) || /^\+.*\r$/m.test(diffText);
}

export function parseDiffHunks(diffText: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  if (!diffText) return hunks;
  const raw = diffText.replace(/\r\n/g, "\n").split("\n");
  if (raw.length && raw[raw.length - 1] === "") raw.pop();
  let current: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const rawLine of raw) {
    const match = HUNK.exec(rawLine);
    if (match) {
      const oldStart = Number(match[1]);
      const oldCount = match[2] === undefined ? 1 : Number(match[2]);
      const newStart = Number(match[3]);
      const newCount = match[4] === undefined ? 1 : Number(match[4]);
      current = {
        id: `${oldStart},${oldCount}+${newStart},${newCount}@${hunks.length}`,
        header: rawLine,
        oldStart,
        oldCount,
        newStart,
        newCount,
        lines: [{ type: "hunk", text: rawLine, oldNo: null, newNo: null }],
      };
      hunks.push(current);
      oldNo = oldStart;
      newNo = newStart;
      continue;
    }
    if (!current) continue;
    if (rawLine.startsWith("\\")) {
      current.lines.push({ type: "noeol", text: rawLine, oldNo: null, newNo: null });
      continue;
    }
    const marker = rawLine[0];
    if (marker === "+") {
      current.lines.push({ type: "add", text: rawLine, oldNo: null, newNo: newNo++ });
    } else if (marker === "-") {
      current.lines.push({ type: "remove", text: rawLine, oldNo: oldNo++, newNo: null });
    } else if (marker === " ") {
      current.lines.push({ type: "context", text: rawLine, oldNo: oldNo++, newNo: newNo++ });
    } else if (rawLine === "") {
      // Blank diff line: a blank context line emitted bare.
      current.lines.push({ type: "context", text: "", oldNo: oldNo++, newNo: newNo++ });
    } else {
      current.lines.push({ type: "meta", text: rawLine, oldNo: null, newNo: null });
    }
  }
  return hunks;
}

/** Canonical hunk payload for stage/unstage IPC (header + body lines). */
export function hunkPayload(hunk: DiffHunk): { header: string; lines: string[] } {
  const header = hunk.header;
  const lines = hunk.lines
    .filter((l) => l.type !== "hunk")
    .map((l) => l.text);
  return { header, lines };
}

export function hunkHasChanges(hunk: DiffHunk): boolean {
  return hunk.lines.some((l) => l.type === "add" || l.type === "remove");
}
