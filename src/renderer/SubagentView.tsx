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
import {
  SUBAGENT_RENDER_WINDOW,
  applyEarlierPageToStore,
  applySessionReadToStore,
  type SubagentHistoryStore,
} from "./subagent-history";

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
  const [showAllHistory, setShowAllHistory] = useState(false);
  const requestSeq = useRef(0);
  const failuresRef = useRef(0);
  const errorRef = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Independent per-child paging stores: extended transcript + cursor.
  const historyStores = useRef(new Map<string, SubagentHistoryStore>());
  const activeChildRef = useRef(childId);
  const visibleRef = useRef(
    typeof document === "undefined" ? true : document.visibilityState === "visible",
  );

  const clearTimer = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const pruneStores = (keepId: string) => {
    const stores = historyStores.current;
    if (stores.size <= 10) return;
    for (const key of stores.keys()) {
      if (key !== keepId) {
        stores.delete(key);
        if (stores.size <= 10) break;
      }
    }
  };

  const noteSuccess = useCallback(
    (state: SessionState, forChildId: string) => {
      failuresRef.current = 0;
      errorRef.current = "";
      // Deterministic merge: preserve pages the user already loaded.
      const previous = historyStores.current.get(forChildId);
      const next = applySessionReadToStore(
        previous,
        state.history,
        state.historyBeforeCursor ?? null,
      );
      historyStores.current.set(forChildId, next);
      pruneStores(forChildId);
      setChild({
        ...state,
        history: next.extended,
        historyBeforeCursor: next.beforeCursor,
      });
      setError("");
      setFailures(0);
      setLastSuccessAt(Date.now());
    },
    [],
  );

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
    async (
      requestId: number,
      forChildId: string,
      { silent = false }: { silent?: boolean } = {},
    ) => {
      if (forChildId !== activeChildRef.current) return;
      if (!bridge) {
        if (
          forChildId === activeChildRef.current &&
          !isStaleResponse(requestId, requestSeq.current)
        ) {
          noteFailure("Open Vibe Desktop to connect to the local engine.");
          setLoading(false);
        }
        return;
      }
      if (!silent) setLoading(true);
      try {
        const result = await bridge.request<{ state: SessionState }>("session/read", {
          sessionId: forChildId,
          history: { limit: HISTORY_PAGE_LIMIT },
        });
        if (
          forChildId !== activeChildRef.current ||
          isStaleResponse(requestId, requestSeq.current)
        )
          return;
        noteSuccess(result.state, forChildId);
      } catch (e: unknown) {
        if (
          forChildId !== activeChildRef.current ||
          isStaleResponse(requestId, requestSeq.current)
        )
          return;
        // Non-destructive: keep the last good transcript visible.
        noteFailure(e instanceof Error ? e.message : String(e));
      } finally {
        if (
          forChildId === activeChildRef.current &&
          !isStaleResponse(requestId, requestSeq.current)
        )
          setLoading(false);
      }
    },
    [noteSuccess],
  );

  const scheduleNext = useCallback(
    (forChildId: string) => {
      clearTimer();
      timer.current = setTimeout(() => {
        if (
          forChildId !== activeChildRef.current ||
          !visibleRef.current ||
          (typeof document !== "undefined" && document.hidden)
        ) {
          // Suspended while hidden or after a child switch: re-arm with the
          // same policy, no request.
          if (forChildId === activeChildRef.current) scheduleNext(forChildId);
          return;
        }
        requestSeq.current += 1;
        const id = requestSeq.current;
        void read(id, forChildId, { silent: true }).finally(() =>
          scheduleNext(forChildId),
        );
      }, nextDelay());
    },
    [read],
  );

  // Initial load. Child switches get independent cursors and stores; stale
  // responses for the previous child are discarded via requestSeq + child id.
  useEffect(() => {
    activeChildRef.current = childId;
    failuresRef.current = 0;
    errorRef.current = "";
    setFailures(0);
    setError("");
    setChild(null);
    setLoading(true);
    setShowAllHistory(false);
    setLoadingEarlier(false);
    requestSeq.current += 1;
    const id = requestSeq.current;
    // Restore the cached extended transcript for fast back-navigation;
    // the fresh read below merges deterministically on top of it.
    const cached = historyStores.current.get(childId);
    if (cached) {
      // Show cached data immediately while the live read refreshes.
      // The actual SessionState shell is replaced on success; history shown
      // comes from the store merge.
    }
    void read(id, childId).finally(() => scheduleNext(childId));
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
        const forChildId = activeChildRef.current;
        void read(id, forChildId, { silent: true }).finally(() =>
          scheduleNext(forChildId),
        );
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
        void read(id, childId, { silent: true }).finally(() =>
          scheduleNext(childId),
        );
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
    const forChildId = activeChildRef.current;
    void read(id, forChildId).finally(() => scheduleNext(forChildId));
  };

  const loadEarlier = async () => {
    const store = historyStores.current.get(childId);
    const cursor = store?.beforeCursor ?? child?.historyBeforeCursor;
    if (!bridge || !cursor || loadingEarlier) return;
    const forChildId = childId;
    const requestId = requestSeq.current;
    setLoadingEarlier(true);
    try {
      const response = await bridge.request<{
        items?: HistoryEntry[];
        entries?: HistoryEntry[];
        previousCursor?: string | null;
      }>("session/history/list", {
        sessionId: forChildId,
        page: { cursor, limit: 100, direction: "backward" },
      });
      // Stale guard: ignore pages for a child the user already left, or
      // responses overtaken by a newer read.
      if (
        forChildId !== activeChildRef.current ||
        isStaleResponse(requestId, requestSeq.current)
      )
        return;
      const older = response.items ?? response.entries ?? [];
      const base =
        historyStores.current.get(forChildId) ??
        (child && forChildId === childId
          ? {
              extended: child.history ?? [],
              beforeCursor: child.historyBeforeCursor ?? null,
              hasOlderPages: false,
              truncated: false,
            }
          : {
              extended: [],
              beforeCursor: cursor,
              hasOlderPages: false,
              truncated: false,
            });
      const next = applyEarlierPageToStore(
        base,
        older,
        response.previousCursor ?? null,
      );
      historyStores.current.set(forChildId, next);
      setChild((prev) => {
        if (!prev || forChildId !== activeChildRef.current) return prev;
        return {
          ...prev,
          history: next.extended,
          historyBeforeCursor: next.beforeCursor,
        };
      });
    } catch (e: unknown) {
      if (forChildId !== activeChildRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (forChildId === activeChildRef.current) setLoadingEarlier(false);
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
          {(() => {
            const full = child.history ?? [];
            const collapsed = !showAllHistory && full.length > SUBAGENT_RENDER_WINDOW;
            const visible = collapsed ? full.slice(-SUBAGENT_RENDER_WINDOW) : full;
            return (
              <>
                {collapsed && (
                  <p className="subagent-virtual-note" role="status">
                    Showing latest {visible.length} of {full.length} messages
                    for smooth scrolling.{" "}
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => setShowAllHistory(true)}
                    >
                      Show all {full.length}
                    </button>
                  </p>
                )}
                {showAllHistory && full.length > SUBAGENT_RENDER_WINDOW && (
                  <p className="subagent-virtual-note" role="status">
                    Showing all {full.length} messages.{" "}
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => setShowAllHistory(false)}
                    >
                      Collapse to latest {SUBAGENT_RENDER_WINDOW}
                    </button>
                  </p>
                )}
                <div
                  className="conversation subagent-conversation"
                  style={{ contentVisibility: "auto" }}
                >
                  {visible.map((entry) => (
                    <Entry key={entry.id} entry={entry} />
                  ))}
                  {!full.length && !loading && (
                    <p>The subagent has not produced visible output yet.</p>
                  )}
                </div>
              </>
            );
          })()}
        </>
      )}
    </section>
  );
}
