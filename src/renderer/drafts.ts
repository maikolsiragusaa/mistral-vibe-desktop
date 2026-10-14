/** Durable unsent-prompt drafts with explicit opt-in (default off).
 *
 * Drafts survive a full app restart via renderer localStorage, which is scoped
 * to the desktop origin and the current OS user. Nothing leaves the machine:
 * the store never journals session history, only the unsent composer text per
 * session/project key. In-memory drafts always work during the app run,
 * independent of this persistent switch.
 *
 * Privacy notes:
 * - Stored data is exactly the unsent composer text the user typed or pasted,
 *   which may itself contain secrets the user pasted. The store never adds
 *   credentials, history or diagnostics on its own.
 * - No remote sync: localStorage never leaves this machine.
 * - Disabling persistence deletes the stored drafts (explicit action only).
 * - Pre-M1.1 installs defaulted to on: legacy drafts found without an opt-in
 *   record are surfaced once for the running session, never silently deleted
 *   and never silently re-enabled. The user chooses to keep (opt in) or clear.
 */

const DRAFTS_KEY = "vibe-desktop:drafts:v1";
const OPT_IN_KEY = "vibe-desktop:drafts-opt-in:v1";
const MAX_DRAFTS = 50;
const MAX_DRAFT_CHARS = 100_000;

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function isDraftPersistenceEnabled(): boolean {
  // Explicit opt-in. Missing, corrupt or unavailable storage means OFF.
  try {
    return localStorage.getItem(OPT_IN_KEY) === "1";
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

/** Remove only the stored drafts, keeping the opt-in choice untouched. */
export function clearStoredDrafts(): void {
  try {
    localStorage.removeItem(DRAFTS_KEY);
  } catch {
    /* Unavailable storage means there is nothing durable to clear. */
  }
}

function sanitizeStoredDrafts(raw: string | null): Map<string, string> {
  const drafts = new Map<string, string>();
  if (!raw) return drafts;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return drafts;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return drafts;
  let count = 0;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (count >= MAX_DRAFTS) break;
    if (typeof key !== "string" || typeof value !== "string") continue;
    if (!key || key.length > 4096) continue;
    if (!value || value.length > MAX_DRAFT_CHARS) continue;
    drafts.set(key, value);
    count += 1;
  }
  return drafts;
}

/** Drafts persisted under an explicit opt-in. Empty unless enabled. */
export function loadDurableDrafts(): Map<string, string> {
  if (!isDraftPersistenceEnabled()) return new Map();
  return sanitizeStoredDrafts(readStorage(DRAFTS_KEY));
}

/** Legacy drafts stored before explicit opt-in existed (M1 default-on).
 * Used once at startup to avoid silent loss; does not enable persistence. */
export function loadLegacyDrafts(): Map<string, string> {
  try {
    if (localStorage.getItem(OPT_IN_KEY) !== null) return new Map();
  } catch {
    return new Map();
  }
  return sanitizeStoredDrafts(readStorage(DRAFTS_KEY));
}

/** True when any well-formed stored draft exists, regardless of opt-in. */
export function hasStoredDrafts(): boolean {
  return sanitizeStoredDrafts(readStorage(DRAFTS_KEY)).size > 0;
}

export function saveDurableDrafts(drafts: Map<string, string>): void {
  if (!isDraftPersistenceEnabled()) return;
  try {
    const record: Record<string, string> = {};
    let count = 0;
    for (const [key, value] of drafts) {
      if (count >= MAX_DRAFTS) break;
      if (typeof key !== "string" || typeof value !== "string") continue;
      if (!key || key.length > 4096) continue;
      if (!value) continue;
      record[key] = value.slice(0, MAX_DRAFT_CHARS);
      count += 1;
    }
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(record));
  } catch {
    /* Quota or privacy mode: in-memory drafts still work for this run. */
  }
}

export const DRAFT_LIMITS = { MAX_DRAFTS, MAX_DRAFT_CHARS } as const;
