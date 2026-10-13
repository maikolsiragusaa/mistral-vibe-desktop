import { useCallback, useEffect, useState } from "react";
import { Plus, RefreshCw, Trash2, X } from "lucide-react";

const bridge = window.vibe;

interface LoopItem {
  id?: string;
  loopId?: string;
  interval?: string;
  cron?: string;
  prompt?: string;
  nextFire?: number | null;
  next_fire?: number | null;
  [key: string]: unknown;
}

interface Props {
  sessionId: string | null;
  disabled?: boolean;
  onClose: () => void;
}

/** Official Code scheduled loops (loops/*).
 *
 * Loops run only while their session's backend is alive. This panel never
 * claims unattended execution when the backend is closed: creation is
 * explicit, deletion is explicit, and an empty backend state is shown as-is.
 */
export function LoopsPanel({ sessionId, disabled, onClose }: Props) {
  const [loops, setLoops] = useState<LoopItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [interval, setInterval] = useState("1h");
  const [prompt, setPrompt] = useState("");

  const refresh = useCallback(async () => {
    if (!sessionId || !bridge) return;
    setLoading(true);
    setError("");
    try {
      const result = await bridge.request<{ loops?: LoopItem[]; items?: LoopItem[] }>(
        "loops/list",
        { sessionId },
      );
      setLoops(result.loops ?? result.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = async () => {
    if (!sessionId || !bridge || !prompt.trim() || !interval.trim()) return;
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
    }
  };

  const remove = async (loopId: string) => {
    if (!sessionId || !bridge) return;
    setError("");
    try {
      await bridge.request("loops/delete", { sessionId, loopId });
      setNotice("Loop deleted.");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const clear = async () => {
    if (!sessionId || !bridge) return;
    setError("");
    try {
      await bridge.request("loops/clear", { sessionId });
      setNotice("All loops cleared for this session.");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
              ? "Recurring prompts for the active session, stored by Vibe."
              : "Open a session to manage its loops."}
          </small>
        </div>
        <button className="icon-button" aria-label="Close scheduled loops" onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      {!sessionId && <p>Open a local session first.</p>}
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
                disabled={disabled}
                onChange={(e) => setInterval(e.target.value)}
              />
            </label>
            <label>
              Prompt
              <textarea
                aria-label="Loop prompt"
                placeholder="What should Vibe run on this schedule?"
                value={prompt}
                disabled={disabled}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </label>
            <div className="button-row">
              <button
                className="primary"
                disabled={disabled || !prompt.trim() || !interval.trim()}
                onClick={() => void create()}
              >
                <Plus size={14} /> Create loop
              </button>
              <button className="secondary" disabled={disabled || loading} onClick={() => void refresh()}>
                <RefreshCw size={13} /> Refresh
              </button>
              {loops.length > 0 && (
                <button className="secondary" disabled={disabled} onClick={() => void clear()}>
                  Clear all
                </button>
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
              const id = String(loop.loopId ?? loop.id ?? index);
              return (
                <div className="loop-row" key={id}>
                  <div>
                    <strong>{String(loop.interval ?? loop.cron ?? "scheduled")}</strong>
                    <p>{String(loop.prompt ?? "")}</p>
                  </div>
                  <button
                    className="icon-button"
                    aria-label={`Delete loop ${id}`}
                    disabled={disabled}
                    onClick={() => void remove(id)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
