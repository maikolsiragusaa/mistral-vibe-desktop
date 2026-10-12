import { useEffect, useRef, useState } from "react";
import { BrainCircuit, Check, ChevronDown } from "lucide-react";

const label = (value: string) =>
  value.replace(/[_-]/g, " ").replace(/^./, (char) => char.toUpperCase());

export function ReasoningPicker({
  levels,
  current,
  disabled,
  onSelect,
}: {
  levels: string[];
  current: string;
  disabled: boolean;
  onSelect: (level: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    container.current
      ?.querySelector<HTMLButtonElement>('[aria-checked="true"]')
      ?.focus();
    const outside = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  return (
    <div className="reasoning-picker" ref={container}>
      <button
        className="reasoning-picker-trigger"
        ref={trigger}
        aria-label={`Reasoning level: ${label(current)}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <BrainCircuit size={14} />
        <span>
          <small>Reasoning</small>
          {label(current)}
        </span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <div
          className="reasoning-level-menu"
          role="menu"
          aria-label="Choose reasoning level"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
              trigger.current?.focus();
            }
            if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
              event.preventDefault();
              const items = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  "button",
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
                    : (index +
                        (event.key === "ArrowDown" ? 1 : -1) +
                        items.length) %
                      items.length;
              items[next]?.focus();
            }
          }}
        >
          <header>
            <BrainCircuit size={16} />
            <span>
              <strong>Thinking effort</strong>
              <small>Supported by the current model</small>
            </span>
          </header>
          {levels.map((level) => (
            <button
              key={level}
              role="menuitemradio"
              aria-checked={level === current}
              onClick={() => {
                setOpen(false);
                trigger.current?.focus();
                void onSelect(level);
              }}
            >
              <span>{label(level)}</span>
              {level === current && <Check size={14} />}
            </button>
          ))}
          <p>Vibe applies this level to your next turn.</p>
        </div>
      )}
    </div>
  );
}
