import { useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, Minus, Plus } from "lucide-react";
import {
  hasCrlf,
  hunkHasChanges,
  hunkPayload,
  isBinaryDiff,
  parseDiffHunks,
  type DiffHunk,
} from "./git-diff";

interface Props {
  diffText: string;
  filePath: string;
  staged: boolean;
  working: boolean;
  truncated?: boolean;
  onStageHunk?: (header: string, lines: string[]) => void;
  onUnstageHunk?: (header: string, lines: string[]) => void;
}

const PAGE_LINES = 2000;

export function DiffViewer({
  diffText,
  filePath,
  staged,
  working,
  truncated,
  onStageHunk,
  onUnstageHunk,
}: Props) {
  const [mode, setMode] = useState<"unified" | "split">("unified");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [visibleLines, setVisibleLines] = useState(PAGE_LINES);
  const [activeHunk, setActiveHunk] = useState(0);
  const hunkRefs = useRef(new Map<number, HTMLDivElement | null>());

  const hunks = useMemo(() => parseDiffHunks(diffText), [diffText]);
  const binary = useMemo(() => isBinaryDiff(diffText), [diffText]);
  const crlf = useMemo(() => hasCrlf(diffText), [diffText]);

  const totalLines = useMemo(
    () => hunks.reduce((n, h) => n + h.lines.length, 0),
    [hunks],
  );

  const matchCount = useMemo(() => {
    if (!query) return 0;
    const needle = query.toLowerCase();
    return hunks.reduce(
      (n, h) => n + h.lines.filter((l) => l.text.toLowerCase().includes(needle)).length,
      0,
    );
  }, [hunks, query]);

  if (binary) {
    return (
      <div className="git-workspace__diff-empty" role="note">
        <Minus size={18} />
        <span>Binary file — no text diff is shown. Stage the whole file to include it.</span>
      </div>
    );
  }

  if (!hunks.length) return null;

  const toggleCollapse = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const scrollToHunk = (index: number) => {
    const clamped = Math.max(0, Math.min(hunks.length - 1, index));
    setActiveHunk(clamped);
    hunkRefs.current.get(clamped)?.scrollIntoView({ block: "nearest" });
  };

  const renderHunkAction = (hunk: DiffHunk) => {
    if (!hunkHasChanges(hunk)) return null;
    if (!staged && onStageHunk) {
      return (
        <button
          type="button"
          className="git-workspace__mini-button"
          disabled={working}
          title={`Stage this hunk of ${filePath}`}
          onClick={() => {
            const payload = hunkPayload(hunk);
            onStageHunk(payload.header, payload.lines);
          }}
        >
          <Plus size={13} /> Stage hunk
        </button>
      );
    }
    if (staged && onUnstageHunk) {
      return (
        <button
          type="button"
          className="git-workspace__mini-button"
          disabled={working}
          title={`Unstage this hunk of ${filePath}`}
          onClick={() => {
            const payload = hunkPayload(hunk);
            onUnstageHunk(payload.header, payload.lines);
          }}
        >
          <Minus size={13} /> Unstage hunk
        </button>
      );
    }
    return null;
  };

  const highlight = (text: string) => {
    if (!query) return text;
    const needle = query.toLowerCase();
    const index = text.toLowerCase().indexOf(needle);
    if (index < 0) return text;
    return (
      <>
        {text.slice(0, index)}
        <mark>{text.slice(index, index + query.length)}</mark>
        {text.slice(index + query.length)}
      </>
    );
  };

  let renderedLines = 0;

  return (
    <div className="git-diff-viewer">
      <div className="git-diff-viewer__toolbar" role="toolbar" aria-label="Diff options">
        <div className="git-workspace__diff-toggle" role="group" aria-label="Diff layout">
          <button
            type="button"
            className={mode === "unified" ? "is-active" : ""}
            aria-pressed={mode === "unified"}
            onClick={() => setMode("unified")}
          >
            Unified
          </button>
          <button
            type="button"
            className={mode === "split" ? "is-active" : ""}
            aria-pressed={mode === "split"}
            onClick={() => setMode("split")}
          >
            Side-by-side
          </button>
        </div>
        <label className="git-diff-viewer__search">
          <span className="visually-hidden">Search in diff</span>
          <input
            type="search"
            placeholder="Search diff…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search in diff"
          />
          {query && <small>{matchCount} matches</small>}
        </label>
        <div className="git-diff-viewer__nav" role="group" aria-label="Hunk navigation">
          <button
            type="button"
            className="git-workspace__mini-button"
            onClick={() => scrollToHunk(activeHunk - 1)}
            disabled={activeHunk <= 0}
            aria-label="Previous hunk"
          >
            ↑ Prev
          </button>
          <small>
            Hunk {activeHunk + 1} / {hunks.length}
          </small>
          <button
            type="button"
            className="git-workspace__mini-button"
            onClick={() => scrollToHunk(activeHunk + 1)}
            disabled={activeHunk >= hunks.length - 1}
            aria-label="Next hunk"
          >
            ↓ Next
          </button>
        </div>
      </div>
      {crlf && (
        <p className="git-diff-viewer__note" role="note">
          CRLF line endings detected — hunk staging preserves them exactly.
        </p>
      )}
      <div className="git-diff-viewer__hunks">
        {hunks.map((hunk, index) => {
          if (renderedLines >= visibleLines) return null;
          const isCollapsed = collapsed.has(hunk.id);
          renderedLines += hunk.lines.length;
          const changeCount = hunk.lines.filter(
            (l) => l.type === "add" || l.type === "remove",
          ).length;
          return (
            <div
              key={hunk.id}
              ref={(el) => {
                hunkRefs.current.set(index, el);
              }}
              className={`git-diff-hunk ${index === activeHunk ? "is-active" : ""}`}
            >
              <div className="git-diff-hunk__head">
                <button
                  type="button"
                  className="git-workspace__icon-button"
                  aria-expanded={!isCollapsed}
                  aria-label={isCollapsed ? "Expand hunk" : "Collapse hunk"}
                  onClick={() => toggleCollapse(hunk.id)}
                >
                  {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                </button>
                <code title={hunk.header}>{hunk.header}</code>
                <small>
                  {changeCount} changed
                </small>
                {renderHunkAction(hunk)}
              </div>
              {!isCollapsed && mode === "unified" && (
                <div className="git-workspace__diff-lines" role="table" aria-label={`Hunk ${index + 1}`}>
                  {hunk.lines.map((line, li) => (
                    <div
                      className={`git-workspace__diff-line git-workspace__diff-line--${line.type}`}
                      key={li}
                      role="row"
                    >
                      <span className="git-diff-lineno" aria-hidden="true">
                        {line.oldNo ?? ""}
                      </span>
                      <span className="git-diff-lineno" aria-hidden="true">
                        {line.newNo ?? ""}
                      </span>
                      <span aria-hidden="true" className="git-workspace__diff-marker">
                        {line.type === "add" ? "+" : line.type === "remove" ? "−" : line.type === "hunk" ? "·" : ""}
                      </span>
                      <code role="cell">{highlight(line.text) || " "}</code>
                    </div>
                  ))}
                </div>
              )}
              {!isCollapsed && mode === "split" && (
                <div className="git-diff-split" role="table" aria-label={`Hunk ${index + 1} side-by-side`}>
                  <div className="git-diff-split__col" aria-label="Original">
                    {hunk.lines
                      .filter((l) => l.type !== "add")
                      .map((line, li) => (
                        <div
                          className={`git-workspace__diff-line git-workspace__diff-line--${line.type}`}
                          key={li}
                          role="row"
                        >
                          <span className="git-diff-lineno" aria-hidden="true">
                            {line.oldNo ?? ""}
                          </span>
                          <code role="cell">{highlight(line.text) || " "}</code>
                        </div>
                      ))}
                  </div>
                  <div className="git-diff-split__col" aria-label="Modified">
                    {hunk.lines
                      .filter((l) => l.type !== "remove")
                      .map((line, li) => (
                        <div
                          className={`git-workspace__diff-line git-workspace__diff-line--${line.type}`}
                          key={li}
                          role="row"
                        >
                          <span className="git-diff-lineno" aria-hidden="true">
                            {line.newNo ?? ""}
                          </span>
                          <code role="cell">{highlight(line.text) || " "}</code>
                        </div>
                      ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {totalLines > visibleLines && (
        <button
          type="button"
          className="git-workspace__button git-workspace__button--quiet"
          onClick={() => setVisibleLines((n) => n + PAGE_LINES)}
        >
          Show more diff lines ({totalLines - visibleLines} remaining)
        </button>
      )}
      {truncated && (
        <div className="git-workspace__truncation">
          <Check size={13} /> Diff preview is capped client-side; stage whole files for oversized diffs.
        </div>
      )}
    </div>
  );
}
