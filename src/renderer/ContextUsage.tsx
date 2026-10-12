import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { Runtime, SessionState } from "./types";
import { useAnchoredPopover } from "./components/useAnchoredPopover";

const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
const field = (object: any, camel: string, snake: string) =>
  number(object?.[camel] ?? object?.[snake]);
const count = (value: number | null) =>
  value === null ? "—" : value.toLocaleString();
const short = (value: number | null) =>
  value === null
    ? "—"
    : value >= 1_000_000
      ? `${(value / 1_000_000).toFixed(1)}M`
      : value >= 1000
        ? `${(value / 1000).toFixed(1)}k`
        : `${value}`;

export function ContextUsage({
  runtime,
  state,
}: {
  runtime: Runtime | null;
  state: SessionState | null;
}) {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const position = useAnchoredPopover(open, trigger, dialog);
  const stats = runtime?.stats;
  const context = (state?.session as any)?.contextUsage;
  const input = field(context, "inputTokens", "input_tokens");
  const output = field(context, "outputTokens", "output_tokens");
  const measured = field(stats, "contextTokens", "context_tokens");
  const occupied =
    input !== null && output !== null
      ? input + output
      : measured !== null && measured > 0
        ? measured
        : null;
  const capacity = number(runtime?.contextWindow);
  const percentage =
    occupied !== null && capacity && capacity > 0
      ? (occupied / capacity) * 100
      : null;
  const promptTokens =
    field(stats, "sessionPromptTokens", "session_prompt_tokens") ??
    state?.session.tokenUsage?.inputTokens ??
    null;
  const completionTokens =
    field(stats, "sessionCompletionTokens", "session_completion_tokens") ??
    state?.session.tokenUsage?.outputTokens ??
    null;
  const cached = field(stats, "sessionCachedTokens", "session_cached_tokens");
  const headroom =
    occupied !== null && capacity !== null
      ? Math.max(0, capacity - occupied)
      : null;
  const denominator = capacity ? Math.max(capacity, occupied || 0) : 1;
  const inputFraction = (input ?? occupied ?? 0) / denominator;
  const outputFraction = (output || 0) / denominator;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
      if (event.key === "Tab") setOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (previous?.isConnected) previous.focus();
    };
  }, [open]);
  return (
    <div className="context-meter">
      <button
        ref={trigger}
        className="context-meter-trigger"
        aria-label="Context and token usage"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(!open)}
      >
        <svg viewBox="0 0 36 36" aria-hidden="true">
          <circle className="meter-track" cx="18" cy="18" r="13" />
          <circle
            className="meter-input"
            cx="18"
            cy="18"
            r="13"
            pathLength="100"
            strokeDasharray={`${inputFraction * 100} 100`}
            transform="rotate(-90 18 18)"
          />
          <circle
            className="meter-output"
            cx="18"
            cy="18"
            r="13"
            pathLength="100"
            strokeDasharray={`${outputFraction * 100} 100`}
            strokeDashoffset={-inputFraction * 100}
            transform="rotate(-90 18 18)"
          />
        </svg>
        <span>
          {percentage === null
            ? "Context"
            : `${percentage.toFixed(percentage < 10 ? 1 : 0)}%`}
          <small>
            {short(occupied)} / {short(capacity)}
          </small>
        </span>
      </button>
      <span
        className="token-inline"
        title="Cumulative input and output tokens for this session"
      >
        <small>
          {short(
            promptTokens !== null && completionTokens !== null
              ? promptTokens + completionTokens
              : null,
          )}{" "}
          total tokens
        </small>
      </span>
      {open && (
        <div
          ref={dialog}
          className="context-meter-dialog"
          popover="auto"
          style={position}
          onToggle={(event) => {
            if (event.newState === "closed") setOpen(false);
          }}
          role="dialog"
          aria-label="Context and token usage details"
        >
          <header>
            <div>
              <p className="eyebrow">This session</p>
              <h2>Context & tokens</h2>
            </div>
            <button
              aria-label="Close context usage"
              className="icon-button"
              onClick={() => setOpen(false)}
            >
              <X size={17} />
            </button>
          </header>
          <div className="context-total">
            <strong>{count(occupied)}</strong>
            <span>of {count(capacity)} context tokens</span>
            <small>Latest measurement from Vibe</small>
          </div>
          <div
            className="context-partition"
            aria-label="Measured context partition"
          >
            <i className="input" style={{ width: `${inputFraction * 100}%` }} />
            <i
              className="output"
              style={{ width: `${outputFraction * 100}%` }}
            />
          </div>
          <dl className="usage-grid">
            <div>
              <dt>Context input</dt>
              <dd>{count(input)}</dd>
            </div>
            <div>
              <dt>Latest output</dt>
              <dd>{count(output)}</dd>
            </div>
            <div>
              <dt>Context headroom</dt>
              <dd>{count(headroom)}</dd>
            </div>
            <div>
              <dt>Session input</dt>
              <dd>{count(promptTokens)}</dd>
            </div>
            <div>
              <dt>Session output</dt>
              <dd>{count(completionTokens)}</dd>
            </div>
            <div>
              <dt>Total session tokens</dt>
              <dd>
                {count(
                  promptTokens !== null && completionTokens !== null
                    ? promptTokens + completionTokens
                    : null,
                )}
              </dd>
            </div>
            <div>
              <dt>Cached input</dt>
              <dd>{cached && cached > 0 ? count(cached) : "Not reported"}</dd>
            </div>
          </dl>
          <p className="measurement-note">
            Input and output form the measured context. Session totals count all
            turns. Other partitions are not reported.
          </p>
        </div>
      )}
    </div>
  );
}
