import { useAnchoredPopover } from "./useAnchoredPopover";
import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  LoaderCircle,
  Search,
  type LucideIcon,
} from "lucide-react";

export interface PickerOption {
  value: string;
  label: string;
  detail?: string;
  metadata?: string;
  title?: string;
}

/** Shared anchored menu for the composer's runtime-backed choices. */
export function ComposerPicker({
  label,
  current,
  options,
  icon: Icon,
  title,
  subtitle,
  footer,
  disabled = false,
  searchable = false,
  onSelect,
}: {
  label: string;
  current: string;
  options: PickerOption[];
  icon: LucideIcon;
  title: string;
  subtitle: string;
  footer?: string;
  disabled?: boolean;
  searchable?: boolean;
  onSelect: (value: string) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");

  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const selected = options.find((option) => option.value === current);
  const visible = options.filter((option) =>
    [option.label, option.value, option.detail, option.title].some((value) =>
      value?.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
    ),
  );

  const position = useAnchoredPopover(open, trigger, menu);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      if (searchable) search.current?.focus();
      else
        (
          menu.current?.querySelector<HTMLButtonElement>(
            '[aria-checked="true"]',
          ) ||
          menu.current?.querySelector<HTMLButtonElement>(
            '[role="menuitemradio"]',
          )
        )?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [open, searchable]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const select = async (value: string) => {
    if (applying || disabled) return;
    setApplying(true);
    setError("");
    try {
      await onSelect(value);
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setApplying(false);
    }
  };
  return (
    <div className="composer-picker">
      <button
        type="button"
        className="composer-picker-trigger"
        ref={trigger}
        aria-label={`${label}: ${selected?.label || current || "Default"}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled || applying}
        onClick={() => {
          setQuery("");
          setError("");
          setOpen((value) => !value);
        }}
      >
        <Icon size={14} />
        <span>
          <small>{label}</small>
          {selected?.label || current || "Default"}
        </span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <div
          ref={menu}
          popover="auto"
          role="menu"
          aria-label={title}
          className={`composer-picker-menu ${searchable ? "composer-picker-menu--models" : ""}`}
          style={{ left: position.left, top: position.top }}
          onToggle={(event) => {
            if (event.newState === "closed") setOpen(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" || event.key === "Tab") {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
              }
              close();
            }
            if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
              if (
                event.target === search.current &&
                ["Home", "End"].includes(event.key)
              )
                return;
              event.preventDefault();
              event.stopPropagation();
              const items = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  '[role="menuitemradio"]',
                ),
              );
              const index = items.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? items.length - 1
                    : index < 0
                      ? event.key === "ArrowDown"
                        ? 0
                        : items.length - 1
                      : (index +
                          (event.key === "ArrowDown" ? 1 : -1) +
                          items.length) %
                        items.length;
              items[next]?.focus();
            }
          }}
        >
          <header>
            <Icon size={16} />
            <span>
              <strong>{title}</strong>
              <small>{subtitle}</small>
            </span>
          </header>
          {searchable && (
            <label className="composer-picker-search">
              <Search size={14} />
              <input
                ref={search}
                type="search"
                aria-label="Search configured models"
                placeholder="Search models"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          )}
          <div className="composer-picker-options">
            {visible.map((option) => (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={option.value === current}
                disabled={applying}
                title={option.title}
                onClick={() => void select(option.value)}
              >
                <span className="composer-picker-option-copy">
                  <strong>{option.label}</strong>
                  {option.detail && <small>{option.detail}</small>}
                </span>
                {option.metadata && (
                  <small className="composer-picker-metadata">
                    {option.metadata}
                  </small>
                )}
                {option.value === current && <Check size={14} />}
              </button>
            ))}
            {!visible.length && (
              <p role="status">No configured models match this search.</p>
            )}
          </div>
          {error && (
            <p role="alert" className="composer-picker-error">
              {error}
            </p>
          )}
          {applying && (
            <p role="status">
              <LoaderCircle size={12} className="spin" /> Applying…
            </p>
          )}
          {footer && <p>{footer}</p>}
        </div>
      )}
    </div>
  );
}
