/** Durable unsent-prompt drafts with explicit opt-in.
 *
 * Drafts survive a full app restart via renderer localStorage, which is scoped
 * to the desktop origin and the current OS user. Nothing leaves the machine:
 * the store never journals session history, only the unsent composer text.
 */

const DRAFTS_KEY = "vibe-desktop:drafts:v1";
const OPT_IN_KEY = "vibe-desktop:drafts-opt-in:v1";
const MAX_DRAFTS = 50;
const MAX_DRAFT_CHARS = 100_000;

export function isDraftPersistenceEnabled(): boolean {
  try {
    const stored = localStorage.getItem(OPT_IN_KEY);
    // Opt-in, default on for new installs. Turning it off clears stored drafts.
    return stored === null ? true : stored === "1";
  } catch {
    return false;
  }
}

export function setDraftPersistenceEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(OPT_IN_KEY, enabled ? "1" : "0");
    if (!enabled) localStorage.removeItem(DRAFTS_KEY);
  } catch {
    /* localStorage may be unavailable in some test harnesses. */
  }
}

export function loadDurableDrafts(): Map<string, string> {
  const drafts = new Map<string, string>();
  if (!isDraftPersistenceEnabled()) return drafts;
  try {
    const raw = localStorage.getItem(DRAFTS_KEY);
    if (!raw) return drafts;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return drafts;
    let count = 0;
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (count >= MAX_DRAFTS) break;
      if (typeof key !== "string" || typeof value !== "string") continue;
      if (!key || value.length > MAX_DRAFT_CHARS) continue;
      drafts.set(key, value);
      count += 1;
    }
  } catch {
    /* Corrupt drafts are ignored; the next save overwrites them. */
  }
  return drafts;
}

export function saveDurableDrafts(drafts: Map<string, string>): void {
  if (!isDraftPersistenceEnabled()) return;
  try {
    const record: Record<string, string> = {};
    let count = 0;
    for (const [key, value] of drafts) {
      if (count >= MAX_DRAFTS) break;
      if (!key || typeof value !== "string") continue;
      if (!value) continue;
      record[key] = value.slice(0, MAX_DRAFT_CHARS);
      count += 1;
    }
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(record));
  } catch {
    /* Quota or privacy mode: in-memory drafts still work for this run. */
  }
}
