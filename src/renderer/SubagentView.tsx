import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, LoaderCircle, RefreshCw, Workflow } from "lucide-react";
import { Entry } from "./components";
import type { HistoryEntry, SessionState } from "./types";
import {
  isStaleResponse,
  nextErrorDelay,
  nextPollDelay,
  syncLabel,
} from "./subagent-poll";

const bridge = window.vibe;
const HISTORY_PAGE_LIMIT = 200;

interface Props {
  parentTitle: string;
  childId: string;
  childName: string;
  childTask?: string | null;
  onBack: (childState: SessionState | null) => void;
}

function formatTime(timestamp: number | null): string {
  if (!timestamp) return "never";
  try {
    return new Date(timestamp).toLocaleTimeString();
  } catch {
    return "unknown";
  }
}

/** A real navigable subagent conversation, not a summary.
 *
 * The child session stays owned by its parent: this view only reads through
 * the public session/read + session/history/list surfaces, polls with backoff
 * while visible, and never sends turns or takes ownership. The parent keeps
 * working underneath. Errors are non-destructive: stale data stays visible
 * with a clear sync state, last-success time and manual retry.
 */
export function SubagentView({ parentTitle, childId, childName, childTask, onBack }: Props) {
  const [child, setChild] = useState<SessionState | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null);
  const [failures, setFailures] = useState(0);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const requestSeq = useRef(0);
  const failuresRef = useRef(0);
  const errorRef = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visibleRef = useRef(
    typeof document === "undefined" ? true : document.visibilityState === "visible",
  );

  const clearTimer = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const noteSuccess = (state: SessionState) => {
    failuresRef.current = 0;
    errorRef.current = "";
    setChild(state);
    setError("");
    setFailures(0);
    setLastSuccessAt(Date.now());
  };

  const noteFailure = (message: string) => {
    failuresRef.current += 1;
    errorRef.current = message;
    setError(message);
    setFailures(failuresRef.current);
  };

  const nextDelay = () =>
    errorRef.current
      ? nextErrorDelay(failuresRef.current)
      : nextPollDelay(failuresRef.current);

  const read = useCallback(
    async (requestId: number, { silent = false }: { silent?: boolean } = {}) => {
      if (!bridge) {
        if (!isStaleResponse(requestId, requestSeq.current)) {
          noteFailure("Open Vibe Desktop to connect to the local engine.");
          setLoading(false);
        }
        return;
      }
      if (!silent) setLoading(true);
      try {
        const result = await bridge.request<{ state: SessionState }>("session/read", {
          sessionId: childId,
          history: { limit: HISTORY_PAGE_LIMIT },
        });
        if (isStaleResponse(requestId, requestSeq.current)) return;
        noteSuccess(result.state);
      } catch (e: unknown) {
        if (isStaleResponse(requestId, requestSeq.current)) return;
        // Non-destructive: keep the last good transcript visible.
        noteFailure(e instanceof Error ? e.message : String(e));
      } finally {
        if (!isStaleResponse(requestId, requestSeq.current)) setLoading(false);
      }
    },
    [childId],
  );

  const scheduleNext = useCallback(() => {
    clearTimer();
    timer.current = setTimeout(() => {
      if (!visibleRef.current || (typeof document !== "undefined" && document.hidden)) {
        // Suspended while hidden: re-arm with the same policy, no request.
        scheduleNext();
        return;
      }
      requestSeq.current += 1;
      const id = requestSeq.current;
      void read(id, { silent: true }).finally(scheduleNext);
    }, nextDelay());
  }, [read]);

  // Initial load.
  useEffect(() => {
    failuresRef.current = 0;
    errorRef.current = "";
    setFailures(0);
    setError("");
    requestSeq.current += 1;
    const id = requestSeq.current;
    void read(id).finally(scheduleNext);
    return () => {
      // Invalidate in-flight responses for a previous child.
      requestSeq.current += 1;
      clearTimer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [childId]);

  // Visibility handling: suspend while hidden, resume immediately.
  useEffect(() => {
    const onVisibility = () => {
      visibleRef.current = document.visibilityState === "visible";
      if (visibleRef.current) {
        clearTimer();
        requestSeq.current += 1;
        const id = requestSeq.current;
        void read(id, { silent: true }).finally(scheduleNext);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [read, scheduleNext]);

  // Official notifications are opportunistic refresh triggers, not the data
  // source: the transcript always comes from session/read.
  useEffect(() => {
    if (!bridge?.onEvent) return undefined;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const off = bridge.onEvent((event) => {
      const sessionId =
        (event.params as Record<string, unknown>)?.sessionId ?? null;
      if (sessionId !== childId) return;
      if (!visibleRef.current || document.hidden) return;
      if (debounce) return;
      debounce = setTimeout(() => {
        debounce = null;
        clearTimer();
        requestSeq.current += 1;
        const id = requestSeq.current;
        void read(id, { silent: true }).finally(scheduleNext);
      }, 750);
    });
    return () => {
      off();
      if (debounce) clearTimeout(debounce);
    };
  }, [childId, read, scheduleNext]);

  const retry = () => {
    clearTimer();
    failuresRef.current = 0;
    errorRef.current = "";
    setFailures(0);
    setError("");
    requestSeq.current += 1;
    const id = requestSeq.current;
    void read(id).finally(scheduleNext);
  };

  const loadEarlier = async () => {
    const cursor = child?.historyBeforeCursor;
    if (!bridge || !cursor || !child || loadingEarlier) return;
    setLoadingEarlier(true);
    try {
      const response = await bridge.request<{
        items?: HistoryEntry[];
        entries?: HistoryEntry[];
        previousCursor?: string | null;
      }>("session/history/list", {
        sessionId: childId,
        page: { cursor, limit: 100, direction: "backward" },
      });
      const older = response.items ?? response.entries ?? [];
      const merged: HistoryEntry[] = [...older, ...(child.history ?? [])];
      const seen = new Set<string>();
      const deduped = merged.filter((entry) => {
        if (seen.has(entry.id)) return false;
        seen.add(entry.id);
        return true;
      });
      setChild({
        ...child,
        history: deduped,
        historyBeforeCursor: response.previousCursor ?? null,
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingEarlier(false);
    }
  };

  const status = child?.session.status?.type ?? "unknown";
  const activeTurn = Boolean(child?.turns?.some((t) => t.status === "in_progress"));
  const tokens = child?.session.tokenUsage ?? child?.session.contextUsage;
  const sync = syncLabel(loading, error, lastSuccessAt, activeTurn);

  return (
    <section className="subagent-view" aria-label={`Subagent ${childName}`}>
      <nav className="subagent-breadcrumb" aria-label="Session hierarchy">
        <button className="secondary" onClick={() => onBack(child)}>
          <ArrowLeft size={14} />
          Back to {parentTitle || "parent session"}
        </button>
        <span aria-current="page">
          <Workflow size={13} /> {childName}
          <small>{status}{activeTurn ? " · working" : ""}</small>
        </span>
      </nav>
      {childTask && <p className="subagent-task-full">{childTask}</p>}
      <p className="subagent-readonly-note">
        Read-only view. This subagent is controlled by its parent; direct
        commands are disabled here.
      </p>
      <div className="subagent-sync" role="status">
        <span>
          {sync === "loading" && (
            <>
              <LoaderCircle size={12} className="spin" /> Loading subagent history…
            </>
          )}
          {sync === "syncing" && (
            <>
              <LoaderCircle size={12} className="spin" /> Updating…
            </>
          )}
          {sync === "watching" && <>Watching — updates while the subagent works.</>}
          {sync === "synced" && <>Up to date.</>}
          {sync === "stale" && <>Showing last good data — refresh failed.</>}
          {sync === "error" && <>Could not load this subagent.</>}
        </span>
        <small>Last update: {formatTime(lastSuccessAt)}</small>
        {(sync === "stale" || sync === "error") && (
          <button className="secondary" onClick={retry} disabled={loading}>
            <RefreshCw size={13} /> Retry
          </button>
        )}
      </div>
      {error && (
        <p className="error-text" role="alert">
          {child
            ? `Refresh failed, keeping last good data: ${error}`
            : `Could not read this subagent: ${error}`}
        </p>
      )}
      {child && (
        <>
          <dl className="child-session-details">
            <div>
              <dt>Session</dt>
              <dd className="break-word">{child.session.id}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{status}{activeTurn ? " · working" : ""}</dd>
            </div>
            <div>
              <dt>Tokens</dt>
              <dd>
                {tokens ? `${tokens.totalTokens.toLocaleString()} total` : "Not reported"}
              </dd>
            </div>
          </dl>
          {child.historyBeforeCursor && (
            <button
              className="history-more"
              disabled={loadingEarlier}
              onClick={() => void loadEarlier()}
            >
              {loadingEarlier ? "Loading earlier messages…" : "Load earlier messages"}
            </button>
          )}
          <div className="conversation subagent-conversation">
            {child.history?.map((entry) => (
              <Entry key={entry.id} entry={entry} />
            ))}
            {!child.history?.length && !loading && (
              <p>The subagent has not produced visible output yet.</p>
            )}
          </div>
        </>
      )}
    </section>
  );
}
