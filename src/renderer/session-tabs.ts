/** M3 session tabs — pure tab descriptors (no side effects).
 *
 * Hierarchy: Project → Repository → Worktree → Session → Agent/Subagents.
 * A session is bound to its worktree via canonical cwd (never by guessing
 * from branch names). History is never duplicated locally — this only
 * describes what the official backend already reports.
 */

export type SessionOperationalState =
  | "working"
  | "waiting-approval"
  | "idle"
  | "detached"
  | "terminated"
  | "externally-held";

export interface SessionTabInput {
  id: string;
  title?: string | null;
  cwd?: string | null;
  branch?: string | null;
  model?: string | null;
  hasActiveTurn: boolean;
  hasPendingCallbacks: boolean;
  attached: boolean;
  leaseHeld: boolean;
  terminated: boolean;
  childRunning: number;
  childWaiting: number;
  detached: boolean;
  draftLength: number;
}

export interface SessionTabDescriptor {
  id: string;
  title: string;
  shortCwd: string | null;
  branch: string | null;
  model: string | null;
  state: SessionOperationalState;
  badge: string;
  tooltip: string;
  attention: boolean;
}

function shortCwd(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const clean = cwd.replace(/[\\/]+$/, "");
  const parts = clean.split(/[\\/]/);
  return parts.at(-1) || cwd;
}

export function describeSessionTab(input: SessionTabInput): SessionTabDescriptor {
  const title = (input.title ?? "").trim() || "New session";
  let state: SessionOperationalState;
  if (input.terminated) state = "terminated";
  else if (input.leaseHeld) state = "externally-held";
  else if (input.hasActiveTurn) state = "working";
  else if (input.hasPendingCallbacks) state = "waiting-approval";
  else if (!input.attached || input.detached) state = "detached";
  else state = "idle";

  const badge =
    state === "working"
      ? "working"
      : state === "waiting-approval"
        ? "waiting"
        : state === "detached"
          ? "detached"
          : state === "externally-held"
            ? "external"
            : state === "terminated"
              ? "ended"
              : "ready";

  const bits: string[] = [title];
  const cwdShort = shortCwd(input.cwd ?? null);
  if (cwdShort) bits.push(`in ${cwdShort}`);
  if (input.branch) bits.push(`on ${input.branch}`);
  if (input.model) bits.push(`via ${input.model}`);
  if (input.childRunning > 0) bits.push(`${input.childRunning} subagent(s) working`);
  if (input.childWaiting > 0) bits.push(`${input.childWaiting} waiting`);
  if (input.draftLength > 0) bits.push("draft kept");
  if (state === "externally-held") bits.push("held by another client (read-only here)");
  if (state === "detached") bits.push("detached — tab visible, backend not attached");
  if (state === "terminated") bits.push("ended");

  return {
    id: input.id,
    title,
    shortCwd: cwdShort,
    branch: input.branch ?? null,
    model: input.model ?? null,
    state,
    badge,
    tooltip: bits.join(" · "),
    attention: state === "waiting-approval" || state === "externally-held",
  };
}

/** Explain why a new attached session cannot open when all slots are used.
 * Viewable tabs (detached) are unlimited; attached backends are capped. */
export function connectionLimitExplanation(
  attachedCount: number,
  maxConnections: number,
): string {
  return (
    `All ${maxConnections} attached session slots are in use (${attachedCount} attached). ` +
    "Tabs stay viewable, but a new live session needs a free slot. " +
    "Stop an attached session explicitly, or close an empty tab (it stops automatically), " +
    "then open the session again. Detaching never stops a session silently."
  );
}

/** Per-tab UI state preserved across fast switches (scroll, inspector panel,
 * open file/diff, unsent draft, worktree context). History itself stays with Vibe. */
export interface TabUiState {
  scrollTop: number;
  inspector: string | null;
  openFile: string | null;
  showStagedDiff: boolean;
  draft: string;
  worktreePath: string | null;
}

export function emptyTabUiState(): TabUiState {
  return {
    scrollTop: 0,
    inspector: null,
    openFile: null,
    showStagedDiff: false,
    draft: "",
    worktreePath: null,
  };
}
