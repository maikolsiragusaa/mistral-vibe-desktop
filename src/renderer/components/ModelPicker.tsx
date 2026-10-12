import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";
import {
  modelCategory,
  normalizeModelInventory,
  type RuntimeModelOption,
} from "../models";

export interface ModelPickerProps {
  /** Pass `runtime.config.models` directly; this component never adds catalog entries. */
  models: readonly unknown[];
  /** Pass `runtime.config.activeModel` from the same runtime snapshot. */
  activeModel?: unknown;
  /** `runtime.contextWindow` describes the active model when per-model context is absent. */
  activeContextWindow?: number;
  /** Successful use must come from an observed runtime response, never from selection alone. */
  verifiedAliases?: readonly string[];
  disabled?: boolean;
  onSelect: (modelAlias: string, reasoningEffort?: string) => void | Promise<void>;
}

function readActiveModel(value: unknown): RuntimeModelOption | undefined {
  return normalizeModelInventory([value])[0];
}

function titleCase(value: string): string {
  if (value.toLowerCase() === "mistral") return "Mistral";
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function providerLabel(value: string): string {
  return value.toLowerCase() === "mistral" ? "Mistral" : value;
}

function formatTokenCount(value: number): string {
  return `${value.toLocaleString()} tokens`;
}

function reasoningLabel(value: string): string {
  if (value.toLowerCase() === "off") return "Off";
  return titleCase(value);
}

function pickInitialReasoning(
  model: RuntimeModelOption,
  active: RuntimeModelOption | undefined,
): string | undefined {
  const levels = model.thinkingLevels;
  if (!levels?.length) return undefined;
  if (
    active?.alias === model.alias &&
    active.thinking &&
    levels.includes(active.thinking)
  )
    return active.thinking;
  if (active?.thinking && levels.includes(active.thinking)) return active.thinking;
  return model.thinking && levels.includes(model.thinking)
    ? model.thinking
    : undefined;
}

function formatPrice(value: number, currency: string): string {
  return `${currency} ${value.toLocaleString(undefined, { maximumFractionDigits: 6 })} / 1M`;
}

export function ModelPicker({
  models: modelSource,
  activeModel: activeSource,
  activeContextWindow,
  verifiedAliases = [],
  disabled = false,
  onSelect,
}: ModelPickerProps) {
  const id = useId();
  const models = useMemo(() => normalizeModelInventory(modelSource), [modelSource]);
  const activeModel = useMemo(() => readActiveModel(activeSource), [activeSource]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const [candidateAlias, setCandidateAlias] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<string | undefined>();
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const previousFocus = useRef<HTMLElement | null>(null);

  const categories = useMemo(
    () => ["All", ...new Set(models.map(modelCategory))],
    [models],
  );
  const visibleModels = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return models.filter((model) => {
      if (category !== "All" && modelCategory(model) !== category) return false;
      if (!normalizedQuery) return true;
      return [
        model.displayName,
        model.alias,
        model.apiId,
        model.provider,
        model.category,
      ]
        .filter(Boolean)
        .some((value) => value!.toLocaleLowerCase().includes(normalizedQuery));
    });
  }, [category, models, query]);
  const candidate =
    models.find((model) => model.alias === candidateAlias) || undefined;

  useEffect(() => {
    if (disabled && open) setOpen(false);
  }, [disabled, open]);

  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement as HTMLElement | null;
    const focusFrame = window.requestAnimationFrame(() => searchRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(focusFrame);
      const restore = previousFocus.current;
      if (restore?.isConnected) restore.focus();
    };
  }, [open]);

  useEffect(() => {
    setHighlightedIndex((index) =>
      visibleModels.length ? Math.min(index, visibleModels.length - 1) : 0,
    );
    optionRefs.current = [];
  }, [visibleModels.length, category, query]);

  const showPicker = () => {
    if (disabled) return;
    const initial =
      models.find((model) => model.alias === activeModel?.alias) || models[0];
    setCandidateAlias(initial?.alias || "");
    setReasoningEffort(
      initial ? pickInitialReasoning(initial, activeModel) : undefined,
    );
    setQuery("");
    setCategory("All");
    setError("");
    setOpen(true);
  };

  const chooseCandidate = (model: RuntimeModelOption, index: number) => {
    setCandidateAlias(model.alias);
    setReasoningEffort(pickInitialReasoning(model, activeModel));
    setHighlightedIndex(index);
  };

  const applySelection = async () => {
    if (disabled || applying || !candidate) return;
    const sameModel = candidate.alias === activeModel?.alias;
    const selectedReasoning = candidate.thinkingLevels?.includes(reasoningEffort || "")
      ? reasoningEffort
      : undefined;
    if (sameModel && selectedReasoning === activeModel?.thinking) {
      setOpen(false);
      return;
    }

    setApplying(true);
    setError("");
    try {
      await onSelect(candidate.alias, selectedReasoning);
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setApplying(false);
    }
  };

  const trapFocus = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if (event.key !== "Tab" || !dialogRef.current) return;
    const focusable = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [href], [tabindex="0"]',
      ),
    ).filter((element) => element.getClientRects().length > 0);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) {
      event.preventDefault();
      dialogRef.current.focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const focusOption = (index: number) => {
    if (!visibleModels.length) return;
    const nextIndex = (index + visibleModels.length) % visibleModels.length;
    setHighlightedIndex(nextIndex);
    optionRefs.current[nextIndex]?.focus();
  };

  const handleSearchKeys = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" && visibleModels.length) {
      event.preventDefault();
      focusOption(highlightedIndex);
    } else if (event.key === "Enter" && visibleModels[highlightedIndex]) {
      event.preventDefault();
      chooseCandidate(visibleModels[highlightedIndex], highlightedIndex);
    }
  };

  const activeVerified =
    activeModel?.verifiedUsable === true ||
    verifiedAliases.includes(activeModel?.alias || "");
  const activeTitle = activeModel?.displayName || "Choose a model";

  return (
    <div className="model-picker">
      <button
        ref={triggerRef}
        type="button"
        className="model-picker-trigger"
        aria-label={`Model: ${activeTitle}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={`${id}-dialog`}
        disabled={disabled}
        onClick={showPicker}
      >
        <span className="model-picker-trigger-copy">
          <small>MODEL</small>
          <strong>{activeTitle}</strong>
        </span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>

      {open && (
        <div
          className="model-picker-backdrop"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <section
            ref={dialogRef}
            id={`${id}-dialog`}
            className="model-picker-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={`${id}-title`}
            tabIndex={-1}
            onKeyDown={trapFocus}
          >
            <header className="model-picker-header">
              <div>
                <p className="model-picker-eyebrow">Vibe runtime</p>
                <h2 id={`${id}-title`}>Choose a model</h2>
              </div>
              <button
                type="button"
                className="model-picker-close"
                aria-label="Close model picker"
                onClick={() => setOpen(false)}
              >
                <X size={16} />
              </button>
            </header>

            <label className="model-picker-search">
              <Search size={15} aria-hidden="true" />
              <input
                ref={searchRef}
                type="search"
                aria-label="Search configured models"
                value={query}
                placeholder="Search name, provider, or API ID"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={handleSearchKeys}
                aria-controls={`${id}-options`}
              />
              <kbd>↑↓</kbd>
            </label>

            {categories.length > 1 && (
              <div className="model-picker-categories" aria-label="Model categories">
                {categories.map((item) => (
                  <button
                    type="button"
                    key={item}
                    className={category === item ? "active" : ""}
                    aria-pressed={category === item}
                    onClick={() => setCategory(item)}
                  >
                    {titleCase(item)}
                  </button>
                ))}
              </div>
            )}

            <div className="model-picker-content">
              <div className="model-picker-results">
                <div className="model-picker-results-heading">
                  <span>Configured models</span>
                  <small>{visibleModels.length}</small>
                </div>
                {visibleModels.length ? (
                  <div
                    id={`${id}-options`}
                    className="model-picker-options"
                    role="listbox"
                    aria-label="Models exposed by the Vibe runtime"
                  >
                    {visibleModels.map((model, index) => {
                      const selected = candidateAlias === model.alias;
                      const current = activeModel?.alias === model.alias;
                      const verified =
                        model.verifiedUsable === true ||
                        verifiedAliases.includes(model.alias);
                      return (
                        <button
                          ref={(element) => {
                            optionRefs.current[index] = element;
                          }}
                          type="button"
                          role="option"
                          aria-selected={selected}
                          id={`${id}-option-${index}`}
                          key={model.alias}
                          className={`model-picker-option ${selected ? "selected" : ""}`}
                          tabIndex={0}
                          onClick={() => chooseCandidate(model, index)}
                          onKeyDown={(event) => {
                            if (event.key === "ArrowDown") {
                              event.preventDefault();
                              focusOption(index + 1);
                            } else if (event.key === "ArrowUp") {
                              event.preventDefault();
                              if (index === 0) searchRef.current?.focus();
                              else focusOption(index - 1);
                            } else if (event.key === "Home") {
                              event.preventDefault();
                              focusOption(0);
                            } else if (event.key === "End") {
                              event.preventDefault();
                              focusOption(visibleModels.length - 1);
                            } else if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              chooseCandidate(model, index);
                            }
                          }}
                        >
                          <span className="model-picker-option-mark" aria-hidden="true">
                            <i />
                            <i />
                            <i />
                            <i />
                          </span>
                          <span className="model-picker-option-copy">
                            <strong>{model.displayName}</strong>
                            <small>
                              {model.provider ? providerLabel(model.provider) : model.alias}
                              {current ? " · Current" : ""}
                            </small>
                          </span>
                          <span
                            className={`model-picker-status ${verified ? "verified" : "configured"}`}
                            title={verified ? "Runtime confirmed successful use" : "Configured and selectable in this runtime"}
                          >
                            {verified ? "Verified" : current ? "Current" : "Ready"}
                          </span>
                          {selected && <Check size={15} aria-hidden="true" />}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="model-picker-empty" role="status">
                    {models.length
                      ? "No configured models match this search."
                      : "This Vibe runtime has not exposed a selectable model."}
                  </div>
                )}
              </div>

              <aside className="model-picker-details" aria-live="polite">
                {candidate ? (
                  <>
                    <p className="model-picker-eyebrow">Model details</p>
                    <h3>{candidate.displayName}</h3>
                    <dl>
                      <dt>Provider</dt>
                      <dd>{candidate.provider ? providerLabel(candidate.provider) : "Not exposed by this Vibe runtime"}</dd>
                      <dt>API ID</dt>
                      <dd>
                        {candidate.apiId ? (
                          <code>{candidate.apiId}</code>
                        ) : (
                          "Not exposed by this Vibe runtime"
                        )}
                      </dd>
                      <dt>Category</dt>
                      <dd>{titleCase(modelCategory(candidate))}</dd>
                      {(candidate.maxContextLength ||
                        (activeModel?.alias === candidate.alias && activeContextWindow)) && (
                        <>
                          <dt>Maximum context</dt>
                          <dd>
                            {formatTokenCount(
                              candidate.maxContextLength || activeContextWindow!,
                            )}
                          </dd>
                        </>
                      )}
                      {candidate.supportsImages !== undefined && (
                        <>
                          <dt>Images</dt>
                          <dd>{candidate.supportsImages ? "Supported" : "Not supported"}</dd>
                        </>
                      )}
                      {candidate.imageDelivery && (
                        <>
                          <dt>Image delivery</dt>
                          <dd>{titleCase(candidate.imageDelivery)}</dd>
                        </>
                      )}
                    </dl>

                    {candidate.thinkingLevels?.length ? (
                      <fieldset className="model-picker-reasoning">
                        <legend>Reasoning</legend>
                        <div className="model-picker-reasoning-options">
                          {candidate.thinkingLevels.map((level) => (
                            <label key={level} className={reasoningEffort === level ? "selected" : ""}>
                              <input
                                type="radio"
                                name={`${id}-reasoning`}
                                value={level}
                                checked={reasoningEffort === level}
                                onChange={() => setReasoningEffort(level)}
                              />
                              <span>{reasoningLabel(level)}</span>
                            </label>
                          ))}
                        </div>
                      </fieldset>
                    ) : candidate.thinkingLevels ? (
                      <div className="model-picker-reasoning-note">
                        Reasoning: off only (runtime exposes no choices)
                      </div>
                    ) : candidate.thinking ? (
                      <div className="model-picker-reasoning-note">
                        Current reasoning: {reasoningLabel(candidate.thinking)} · choices not exposed
                      </div>
                    ) : null}

                    {candidate.pricing && (
                      <div className="model-picker-pricing">
                        <strong>Indicative API pricing</strong>
                        <span>
                          {candidate.pricing.inputPerMillion !== undefined
                            ? `Input ${formatPrice(candidate.pricing.inputPerMillion, candidate.pricing.currency)}`
                            : ""}
                        </span>
                        <span>
                          {candidate.pricing.outputPerMillion !== undefined
                            ? `Output ${formatPrice(candidate.pricing.outputPerMillion, candidate.pricing.currency)}`
                            : ""}
                        </span>
                        {candidate.pricing.cachedInputPerMillion !== undefined && (
                          <span>
                            Cached input {formatPrice(candidate.pricing.cachedInputPerMillion, candidate.pricing.currency)}
                          </span>
                        )}
                        <small>
                          Source: docs.mistral.ai · updated {new Date(candidate.pricing.updatedAt).toLocaleDateString()}
                        </small>
                      </div>
                    )}

                    <div className="model-picker-availability">
                      <strong>
                        {candidate.verifiedUsable === true || verifiedAliases.includes(candidate.alias)
                          ? "Verified usable"
                          : candidate.alias === activeModel?.alias
                            ? "Current runtime model"
                            : "Configured and selectable"}
                      </strong>
                      <small>
                        {candidate.verifiedUsable === true || verifiedAliases.includes(candidate.alias)
                          ? "A successful runtime response confirmed this model."
                          : "The runtime exposes this model for selection; API reachability has not been verified here."}
                      </small>
                    </div>
                  </>
                ) : (
                  <p className="model-picker-details-empty">
                    Select a model exposed by the active Vibe runtime to inspect its details.
                  </p>
                )}
              </aside>
            </div>

            {error && <p className="model-picker-error" role="alert">{error}</p>}
            <footer className="model-picker-footer">
              <small>Inventory and restrictions come from this Vibe session.</small>
              <div>
                <button
                  type="button"
                  className="model-picker-cancel"
                  onClick={() => setOpen(false)}
                  disabled={applying}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="model-picker-apply"
                  onClick={() => void applySelection()}
                  disabled={!candidate || disabled || applying}
                >
                  {applying ? "Applying…" : "Use model"}
                </button>
              </div>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}
