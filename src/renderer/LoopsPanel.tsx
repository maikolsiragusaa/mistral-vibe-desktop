import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Plus, RefreshCw, Trash2, X } from "lucide-react";
import {
  canonicalLoopId,
  describeLoopInterval,
  describeLoopLastRun,
  describeLoopNextFire,
  planLoopReplace,
  sanitizeLoops,
  type LoopWireItem as LoopItem,
} from "./loops-model";

const bridge = window.vibe;

interface Props {
  sessionId: string | null;
  backendActive: boolean;
  disabled?: boolean;
  onClose: () => void;
}



/** Official Code scheduled loops (loops/*).
 *
 * Loops run only while their session's backend is alive. Creation and single
 * deletion are explicit; Clear All is a two-step confirmed action. Destructive
 * actions use canonical backend ids only — rows without an id cannot be
 * deleted. Mutations carry pending state and refresh afterwards.
 */
export function LoopsPanel({ sessionId, backendActive, disabled, onClose }: Props) {
  const [loops, setLoops] = useState<LoopItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [interval, setInterval] = useState("1h");
  const [prompt, setPrompt] = useState("");
  const [mutating, setMutating] = useState<string | null>(null);
  const [clearArmed, setClearArmed] = useState(false);
  const [replacingId, setReplacingId] = useState<string | null>(null);
  const [replaceInterval, setReplaceInterval] = useState("");
  const [replacePrompt, setReplacePrompt] = useState("");

  const refresh = useCallback(async () => {
    if (!sessionId || !bridge) return;
    setLoading(true);
    setError("");
    try {
      const result = await bridge.request<{ loops?: unknown; items?: unknown }>(
        "loops/list",
        { sessionId },
      );
      const raw = result.loops ?? result.items ?? [];
      setLoops(sanitizeLoops(raw));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    setClearArmed(false);
    void refresh();
  }, [refresh]);

  const busy = disabled || mutating !== null;

  const create = async () => {
    if (!sessionId || !bridge || !prompt.trim() || !interval.trim() || busy) return;
    setMutating("create");
    setError("");
    setNotice("");
    try {
      await bridge.request("loops/create", {
        sessionId,
        interval: interval.trim(),
        prompt: prompt.trim(),
      });
      setPrompt("");
      setNotice("Loop created by Vibe for this session.");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setMutating(null);
    }
  };

  const remove = async (loopId: string) => {
    if (!sessionId || !bridge || busy) return;
    setMutating(loopId);
    setError("");
    try {
      await bridge.request("loops/delete", { sessionId, loopId });
      setNotice("Loop deleted.");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setMutating(null);
    }
  };

  const clear = async () => {
    if (!sessionId || !bridge || busy) return;
    if (!clearArmed) {
      setClearArmed(true);
      return;
    }
    setMutating("clear");
    setError("");
    try {
      await bridge.request("loops/clear", { sessionId });
      setNotice("All loops cleared for this session.");
      setClearArmed(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setMutating(null);
    }
  };

  const beginReplace = (loop: LoopItem) => {
    const id = canonicalLoopId(loop);
    if (!id) return;
    setReplacingId(id);
    setReplaceInterval(typeof loop.interval === "string" ? loop.interval : "1h");
    setReplacePrompt(typeof loop.prompt === "string" ? loop.prompt : "");
    setError("");
    setNotice("");
  };

  const confirmReplace = async (oldLoop: LoopItem) => {
    // Explicit replacement: no loops/update upstream. Create the replacement
    // first; delete the original only after Vibe validates the new loop.
    // The previous prompt is preserved on failure; no duplicates are created.
    if (!sessionId || !bridge || busy || !replacingId) return;
    const plan = planLoopReplace(oldLoop, { interval: replaceInterval, prompt: replacePrompt });
    if (!plan) {
      setError("Replacement needs a valid interval and prompt.");
      return;
    }
    setMutating(replacingId);
    setError("");
    setNotice("");
    try {
      await bridge.request("loops/create", {
        sessionId,
        interval: plan.interval,
        prompt: plan.prompt,
      });
      await bridge.request("loops/delete", { sessionId, loopId: plan.oldId });
      setReplacingId(null);
      setNotice("Loop replaced: the new schedule was validated before the old one was removed.");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setMutating(null);
    }
  };

  return (
    <section className="loops-panel" aria-label="Scheduled loops">
      <header>
        <div>
          <p className="eyebrow">Code automations</p>
          <h2>Scheduled loops</h2>
          <small>
            {sessionId
              ? `Recurring prompts for session ${sessionId.slice(0, 8)}, stored by Vibe.`
              : "Open a session to manage its loops."}
          </small>
        </div>
        <button className="icon-button" aria-label="Close scheduled loops" onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      {!sessionId && <p>Open a local session first.</p>}
      {sessionId && !backendActive && (
        <p className="notice-text" role="status">
          The backend for this session is not active, so loops cannot fire
          right now. They resume when the session backend runs.
        </p>
      )}
      {sessionId && (
        <>
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="notice-text" role="status">
              {notice}
            </p>
          )}
          <div className="loops-create">
            <label>
              Interval
              <input
                aria-label="Loop interval"
                placeholder="1h, 30m, daily…"
                value={interval}
                disabled={busy}
                onChange={(e) => setInterval(e.target.value)}
              />
            </label>
            <label>
              Prompt
              <textarea
                aria-label="Loop prompt"
                placeholder="What should Vibe run on this schedule?"
                value={prompt}
                disabled={busy}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </label>
            <div className="button-row">
              <button
                className="primary"
                disabled={busy || !prompt.trim() || !interval.trim()}
                onClick={() => void create()}
              >
                <Plus size={14} /> {mutating === "create" ? "Creating…" : "Create loop"}
              </button>
              <button className="secondary" disabled={busy || loading} onClick={() => void refresh()}>
                <RefreshCw size={13} /> Refresh
              </button>
              {loops.length > 0 && !clearArmed && (
                <button className="secondary" disabled={busy} onClick={() => void clear()}>
                  Clear all…
                </button>
              )}
              {clearArmed && (
                <span className="clear-confirm" role="group" aria-label="Confirm clear all loops">
                  <AlertTriangle size={14} />
                  <span>Delete all {loops.length} loop(s)?</span>
                  <button
                    className="secondary danger"
                    disabled={busy}
                    onClick={() => void clear()}
                  >
                    {mutating === "clear" ? "Clearing…" : "Yes, clear all"}
                  </button>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => setClearArmed(false)}
                  >
                    Keep loops
                  </button>
                </span>
              )}
            </div>
            <small>
              Loops fire only while this session's backend runs. Closing the
              session or stopping the backend pauses execution.
            </small>
          </div>
          <div className="loops-list">
            {loading && <p role="status">Loading loops…</p>}
            {!loading && !loops.length && <p>No loops for this session.</p>}
            {loops.map((loop, index) => {
              const id = canonicalLoopId(loop);
              const key = id ?? `row-${index}`;
              const next = describeLoopNextFire(loop);
              const last = describeLoopLastRun(loop);
              const isReplacing = replacingId === id;
              return (
                <div className="loop-row" key={key}>
                  <div>
                    <strong>{describeLoopInterval(loop)}</strong>
                    <p>{typeof loop.prompt === "string" ? loop.prompt : ""}</p>
                    {next && <small>{next}</small>}
                    {last && <small>{last}</small>}
                    {!next && !last && <small>Schedule details come from Vibe; last run is shown only when exposed.</small>}
                    {!id && (
                      <small className="error-text">
                        Unidentified row from Vibe — refresh before deleting.
                      </small>
                    )}
                    {isReplacing && id && (
                      <div className="loop-replace">
                        <label>
                          New interval
                          <input
                            aria-label="Replacement loop interval"
                            value={replaceInterval}
                            disabled={busy}
                            onChange={(e) => setReplaceInterval(e.target.value)}
                          />
                        </label>
                        <label>
                          New prompt
                          <textarea
                            aria-label="Replacement loop prompt"
                            value={replacePrompt}
                            disabled={busy}
                            onChange={(e) => setReplacePrompt(e.target.value)}
                          />
                        </label>
                        <div className="button-row">
                          <button
                            className="primary"
                            disabled={busy || !replaceInterval.trim() || !replacePrompt.trim()}
                            onClick={() => void confirmReplace(loop)}
                          >
                            {mutating === id ? "Replacing…" : "Create replacement, then remove old"}
                          </button>
                          <button
                            className="secondary"
                            disabled={busy}
                            onClick={() => setReplacingId(null)}
                          >
                            Keep original
                          </button>
                        </div>
                        <small>
                          The original loop is deleted only after Vibe validates the replacement. Upstream has no atomic update.
                        </small>
                      </div>
                    )}
                  </div>
                  <span className="loop-actions">
                    {id && !isReplacing && (
                      <button
                        className="secondary"
                        disabled={busy}
                        title="Replace via explicit create-then-delete (no atomic update upstream)"
                        onClick={() => beginReplace(loop)}
                      >
                        Replace…
                      </button>
                    )}
                    <button
                      className="icon-button"
                      aria-label={id ? `Delete loop ${id}` : "Delete loop (unavailable: no id)"}
                      disabled={busy || !id}
                      title={id ? `Delete loop ${id}` : "This row has no backend id and cannot be safely deleted."}
                      onClick={() => id && void remove(id)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
