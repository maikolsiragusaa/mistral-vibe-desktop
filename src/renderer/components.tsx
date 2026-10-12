import { useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  Check,
  Circle,
  CircleHelp,
  Command,
  LoaderCircle,
  ShieldCheck,
  Workflow,
} from "lucide-react";
import type { HistoryEntry } from "./types";
import { questionAnswers } from "./questions";
const bridge = window.vibe;
const pretty = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);
const text = (entry: HistoryEntry) =>
  entry.text ||
  entry.content
    ?.filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n\n") ||
  "";
export function Mark({ large = false }: { large?: boolean }) {
  return (
    <span className={`signal ${large ? "large" : ""}`} aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}
export function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      components={{
        a: ({ href, children }) => (
          <a
            href={href}
            onClick={(event) => {
              event.preventDefault();
              if (href) bridge?.openExternal(href).catch(() => {});
            }}
          >
            {children}
          </a>
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  );
}

export function Entry({ entry }: { entry: HistoryEntry }) {
  if (entry.type === "message")
    return (
      <article className={`message ${entry.role}`}>
        <div className="message-heading">
          {entry.role === "user" ? (
            <>
              <span className="avatar">Y</span>You
            </>
          ) : (
            <>
              <Mark />
              Vibe
            </>
          )}
          {entry.generationStatus === "in_progress" && (
            <span className="live-label">Streaming</span>
          )}
        </div>
        <div className="markdown">
          <Markdown>{text(entry)}</Markdown>
        </div>
      </article>
    );
  if (entry.type === "reasoning")
    return (
      <details className="reasoning">
        <summary>
          <Workflow size={14} /> Thinking
        </summary>
        <div className="markdown">
          <Markdown>{text(entry)}</Markdown>
        </div>
      </details>
    );
  if (entry.type === "effect")
    return (
      <details className="effect">
        <summary>
          {entry.state?.status === "running" ||
          entry.state?.status === "pending" ? (
            <LoaderCircle size={14} className="spin" />
          ) : entry.state?.status === "completed" ? (
            <Check size={14} />
          ) : (
            <Command size={14} />
          )}
          <span>
            {entry.title || entry.detail?.toolName || "Agent operation"}
          </span>
          <small>{entry.state?.status}</small>
        </summary>
        <pre>{pretty(entry.detail?.input || entry.detail || {})}</pre>
        {entry.state?.outputText && (
          <pre className="tool-output">{entry.state.outputText}</pre>
        )}
        {entry.state?.error && (
          <p className="error-text">{entry.state.error.message}</p>
        )}
      </details>
    );
  if (entry.type === "callback")
    return (
      <div className="timeline-note">
        <CircleHelp size={14} />
        {entry.title || "Input requested"}
        <small>{entry.state?.status}</small>
      </div>
    );
  return (
    <div className="timeline-note">
      <Circle size={12} />
      {entry.title || text(entry) || entry.type}
    </div>
  );
}

export function CallbackCard({
  entry,
  onAnswer,
}: {
  entry: HistoryEntry;
  onAnswer: (output: Record<string, unknown>) => Promise<void>;
}) {
  const [selected, setSelected] = useState<Record<number, string[]>>({});
  const [custom, setCustom] = useState<Record<number, string>>({});
  const [pathScope, setPathScope] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const answer = async (output: Record<string, unknown>) => {
    setSubmitting(true);
    setError("");
    try {
      await onAnswer(output);
    } catch (e) {
      setError(String(e));
      setSubmitting(false);
    }
  };
  const detail = entry.detail || {};
  const answers = questionAnswers(
    detail.request?.questions || [],
    selected,
    custom,
  );
  const labels: Record<string, string> = {
    approve: "Approve once",
    approve_for_session: "Approve for session",
    approve_permanently: "Always approve",
    deny: "Deny",
    cancel_turn: "Stop turn",
  };
  return (
    <section className="callback-card" aria-label="Vibe needs your input">
      <div className="callback-heading">
        <ShieldCheck size={18} />
        <strong>{entry.title || "Vibe needs your input"}</strong>
      </div>
      {detail.kind === "approval" ? (
        <>
          {detail.reason && <p>{detail.reason}</p>}
          <pre>{pretty(detail.effect?.input || detail.effect || {})}</pre>
          {detail.requiredPermissions?.length > 0 && (
            <details>
              <summary>Requested permissions</summary>
              <pre>{pretty(detail.requiredPermissions)}</pre>
            </details>
          )}
          {detail.pathScopeChoices?.length > 0 && (
            <label className="scope-choice">
              Permission scope
              <select
                aria-label="Permission scope"
                value={pathScope || detail.pathScopeChoices[0]}
                onChange={(event) => setPathScope(event.target.value)}
              >
                {detail.pathScopeChoices.map((scope: string) => (
                  <option key={scope} value={scope}>
                    {scope === "exact"
                      ? "This path"
                      : "This directory and its contents"}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="button-row">
            {(detail.choices || []).map((choice: string) => (
              <button
                key={choice}
                disabled={submitting}
                className={choice === "approve" ? "primary" : "secondary"}
                onClick={() =>
                  void answer({
                    type: "approval",
                    decision: {
                      type: choice,
                      ...(detail.pathScopeChoices?.length &&
                      ["approve_for_session", "approve_permanently"].includes(
                        choice,
                      )
                        ? { pathScope: pathScope || detail.pathScopeChoices[0] }
                        : {}),
                    },
                  })
                }
              >
                {labels[choice] || choice}
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          {(detail.request?.questions || []).map(
            (question: any, index: number) => (
              <fieldset key={index}>
                <legend>{question.question}</legend>
                <div className="question-options">
                  {question.options.map((option: any) => (
                    <label key={option.label}>
                      <input
                        type={question.multiSelect ? "checkbox" : "radio"}
                        name={`question-${entry.id}-${index}`}
                        checked={
                          !custom[index] &&
                          (selected[index] || []).includes(option.label)
                        }
                        onChange={(event) => {
                          setCustom((previous) => ({
                            ...previous,
                            [index]: "",
                          }));
                          setSelected((previous) => ({
                            ...previous,
                            [index]: question.multiSelect
                              ? event.target.checked
                                ? [...(previous[index] || []), option.label]
                                : (previous[index] || []).filter(
                                    (value) => value !== option.label,
                                  )
                              : [option.label],
                          }));
                        }}
                      />
                      <span>
                        {option.label}
                        <small>{option.description}</small>
                      </span>
                    </label>
                  ))}
                </div>
                {!question.hideOther && (
                  <input
                    aria-label={`Custom answer ${index + 1}`}
                    placeholder="Your answer…"
                    value={custom[index] || ""}
                    onChange={(event) => {
                      setSelected((previous) => ({ ...previous, [index]: [] }));
                      setCustom((previous) => ({
                        ...previous,
                        [index]: event.target.value,
                      }));
                    }}
                  />
                )}
              </fieldset>
            ),
          )}
          <div className="button-row">
            <button
              className="primary"
              disabled={
                submitting || !answers.every((answer) => answer.answer.trim())
              }
              onClick={() =>
                void answer({
                  type: "user_input",
                  result: {
                    answers,
                    cancelled: false,
                  },
                })
              }
            >
              Send answer
            </button>
            <button
              className="secondary"
              disabled={submitting}
              onClick={() =>
                void answer({
                  type: "user_input",
                  result: { answers: [], cancelled: true },
                })
              }
            >
              Cancel
            </button>
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
    </section>
  );
}
