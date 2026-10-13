/** M3 notifications — pure dedupe + copy rules (no side effects).
 *
 * Desktop toasts are non-invasive, Windows-consistent, and honest:
 * - Only fired for reliable backend events while the app runs.
 * - Never promise delivery with the app fully closed.
 * - No sensitive content (prompts, file bodies, keys) by default.
 * - Click routes to the owning session when supported.
 */

export type DesktopNoticeKind =
  | "task-done"
  | "loop-failed"
  | "approval-waiting"
  | "backend-error"
  | "result-available";

export interface DesktopNotice {
  kind: DesktopNoticeKind;
  sessionId: string;
  title: string;
  body: string;
}

const NOTICE_TITLES: Record<DesktopNoticeKind, string> = {
  "task-done": "Agent task finished",
  "loop-failed": "Scheduled loop failed",
  "approval-waiting": "Agent waits for approval",
  "backend-error": "Backend error",
  "result-available": "Result available",
};

/** Build a safe notice: titles are fixed, bodies carry only ids/counts —
 * never prompt text, file content, or credentials. */
export function buildNotice(
  kind: DesktopNoticeKind,
  sessionId: string,
  detail?: string | null,
): DesktopNotice {
  const short = sessionId.slice(0, 8);
  const suffix = detail ? ` — ${detail.slice(0, 120)}` : "";
  return {
    kind,
    sessionId,
    title: NOTICE_TITLES[kind],
    body: `Session ${short}${suffix}`,
  };
}

/** Dedupe key: one toast per (kind, session) until the session changes state. */
export function noticeKey(notice: Pick<DesktopNotice, "kind" | "sessionId">): string {
  return `${notice.kind}:${notice.sessionId}`;
}

export class NoticeDeduper {
  private seen = new Set<string>();
  private maxSize = 200;

  /** Returns true when the notice should be shown (first time). */
  shouldShow(notice: Pick<DesktopNotice, "kind" | "sessionId">): boolean {
    const key = noticeKey(notice);
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > this.maxSize) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }

  /** Clear a session's notices (e.g. user opened that session). */
  clearSession(sessionId: string): void {
    for (const key of [...this.seen]) {
      if (key.endsWith(`:${sessionId}`)) this.seen.delete(key);
    }
  }

  clearAll(): void {
    this.seen.clear();
  }
}
