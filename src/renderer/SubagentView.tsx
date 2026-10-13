import { useEffect, useRef, useState } from "react";
import { ArrowLeft, LoaderCircle, Workflow } from "lucide-react";
import { Entry } from "./components";
import type { SessionState } from "./types";

const bridge = window.vibe;

interface Props {
  parentTitle: string;
  childId: string;
  childName: string;
  childTask?: string | null;
  onBack: (childState: SessionState | null) => void;
}

/** A real navigable subagent conversation, not a summary.
 *
 * The child session stays owned by its parent: this view only reads through
 * the public session/read surface, polls with backoff while visible, and
 * never sends turns or takes ownership. The parent keeps working underneath.
 */
export function SubagentView({ parentTitle, childId, childName, childTask, onBack }: Props) {
  const [child, setChild] = useState<SessionState | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshTick, setRefreshTick] = useState(0);
  const visible = useRef(true);
  const failures = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const onVisibility = () => {
      visible.current = document.visibilityState === "visible";
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    bridge
      ?.request<{ state: SessionState }>("session/read", {
        sessionId: childId,
        history: { limit: 200 },
      })
      .then((result) => {
        if (cancelled) return;
        setChild(result.state);
        failures.current = 0;
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [childId, refreshTick]);

  // Bounded live refresh: 2s base with backoff to 15s, suspended when hidden.
  useEffect(() => {
    const tick = () => {
      if (visible.current && !document.hidden) setRefreshTick((n) => n + 1);
      const delay = Math.min(2000 * 2 ** failures.current, 15000);
      timer.current = setTimeout(tick, delay);
    };
    timer.current = setTimeout(tick, 2500);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  useEffect(() => {
    if (!child) return;
    const active = child.turns?.some((t) => t.status === "in_progress");
    failures.current = active ? 0 : Math.min(failures.current + 1, 3);
  }, [child]);

  const status = child?.session.status?.type ?? "unknown";
  const activeTurn = child?.turns?.some((t) => t.status === "in_progress");
  const tokens = child?.session.tokenUsage ?? child?.session.contextUsage;

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
      {loading && !child && (
        <p role="status">
          <LoaderCircle size={14} className="spin" /> Loading subagent history…
        </p>
      )}
      {error && !child && (
        <p className="error-text" role="alert">
          Could not read this subagent: {error}
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
          <div className="conversation subagent-conversation">
            {child.history?.map((entry) => (
              <Entry key={entry.id} entry={entry} />
            ))}
            {!child.history?.length && (
              <p>The subagent has not produced visible output yet.</p>
            )}
          </div>
        </>
      )}
    </section>
  );
}
