import type { HistoryEntry } from "./types";

/** Bounded, deterministic history merging for read-only subagent views.
 *
 * The backend's session/read returns a recent window (limit 200) while
 * session/history/list returns older pages. Polling must never drop pages
 * the user already loaded. All merges are pure, id-deduped and order-stable.
 */

export const MAX_SUBAGENT_HISTORY = 1000;
/** Render window before collapsing older transcript rows (CSS-assisted). */
export const SUBAGENT_RENDER_WINDOW = 400;

function entryId(entry: HistoryEntry): string {
  return typeof entry?.id === "string" ? entry.id : "";
}

/** Deduplicate by stable id; later occurrences win content, first order wins position. */
export function dedupeHistory(entries: HistoryEntry[]): HistoryEntry[] {
  const latest = new Map<string, HistoryEntry>();
  const order: string[] = [];
  for (const entry of entries) {
    const id = entryId(entry);
    if (!id) continue;
    if (!latest.has(id)) order.push(id);
    latest.set(id, entry);
  }
  return order.map((id) => latest.get(id)!);
}

/**
 * Merge a fresh session/read window into the previously extended transcript.
 * Entries absent from the fresh window are older pages the user loaded —
 * they are preserved as a prefix. Fresh entries win on content conflicts.
 */
export function mergeSessionRead(
  previous: readonly HistoryEntry[] | null | undefined,
  fresh: readonly HistoryEntry[] | null | undefined,
): HistoryEntry[] {
  const prevList = Array.isArray(previous) ? previous : [];
  const freshList = Array.isArray(fresh) ? fresh : [];
  if (prevList.length === 0) return trimHistory(dedupeHistory([...freshList])).entries;
  if (freshList.length === 0) return trimHistory(dedupeHistory([...prevList])).entries;
  const freshIds = new Set(freshList.map(entryId));
  // Older pages not covered by the fresh window stay as an ordered prefix.
  const prefix = prevList.filter((entry) => !freshIds.has(entryId(entry)));
  return trimHistory(dedupeHistory([...prefix, ...freshList])).entries;
}

/** Prepend an older page (from session/history/list) to the transcript. */
export function mergeEarlierPage(
  olderPage: readonly HistoryEntry[] | null | undefined,
  current: readonly HistoryEntry[] | null | undefined,
): HistoryEntry[] {
  const older = Array.isArray(olderPage) ? olderPage : [];
  const list = Array.isArray(current) ? current : [];
  if (older.length === 0) return dedupeHistory([...list]);
  // Older page comes first; current wins on id conflicts (fresher content).
  const merged = dedupeHistory([...older, ...list]);
  // dedupeHistory keeps first position but latest content; for prepended
  // duplicates the position stays in the older region which is correct
  // because the entry predates the current window.
  return trimHistory(merged).entries;
}

export function trimHistory(entries: HistoryEntry[]): {
  entries: HistoryEntry[];
  truncated: boolean;
} {
  if (entries.length <= MAX_SUBAGENT_HISTORY) return { entries, truncated: false };
  return {
    entries: entries.slice(entries.length - MAX_SUBAGENT_HISTORY),
    truncated: true,
  };
}

/** Per-child paging store: independent cursors, no cross-child leakage. */
export interface SubagentHistoryStore {
  extended: HistoryEntry[];
  beforeCursor: string | null;
  hasOlderPages: boolean;
  truncated: boolean;
}

export function createEmptyStore(
  freshHistory: readonly HistoryEntry[] = [],
  beforeCursor: string | null = null,
): SubagentHistoryStore {
  return {
    extended: dedupeHistory([...freshHistory]),
    beforeCursor,
    hasOlderPages: false,
    truncated: false,
  };
}

export function applySessionReadToStore(
  store: SubagentHistoryStore | undefined,
  freshHistory: readonly HistoryEntry[] | null | undefined,
  freshCursor: string | null | undefined,
): SubagentHistoryStore {
  const fresh = Array.isArray(freshHistory) ? [...freshHistory] : [];
  if (!store) {
    return createEmptyStore(fresh, freshCursor ?? null);
  }
  const merged = mergeSessionRead(store.extended, fresh);
  return {
    extended: merged,
    // Once the user paged deeper, the paging cursor belongs to the oldest
    // loaded page — a fresh window cursor must not rewind it.
    beforeCursor: store.hasOlderPages ? store.beforeCursor : (freshCursor ?? null),
    hasOlderPages: store.hasOlderPages,
    truncated: merged.length >= MAX_SUBAGENT_HISTORY || store.truncated,
  };
}

export function applyEarlierPageToStore(
  store: SubagentHistoryStore,
  olderPage: readonly HistoryEntry[] | null | undefined,
  previousCursor: string | null | undefined,
): SubagentHistoryStore {
  const merged = mergeEarlierPage(olderPage, store.extended);
  const added = Array.isArray(olderPage) ? olderPage.length : 0;
  return {
    extended: merged,
    beforeCursor: previousCursor ?? null,
    hasOlderPages: store.hasOlderPages || added > 0,
    truncated: store.truncated,
  };
}
