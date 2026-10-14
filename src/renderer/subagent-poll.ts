/** Bounded polling policy for read-only subagent inspection.
 *
 * Pure helpers so the backoff/stale rules are unit-testable without React.
 * The child session stays owned by its parent: the view only reads.
 */

export const BASE_POLL_MS = 2500;
export const MAX_POLL_MS = 15000;
export const ERROR_BASE_POLL_MS = 5000;
export const ERROR_MAX_POLL_MS = 30000;

export function nextPollDelay(
  consecutiveFailures: number,
  baseMs = BASE_POLL_MS,
  maxMs = MAX_POLL_MS,
): number {
  const failures = Math.max(0, Math.floor(consecutiveFailures));
  const delay = baseMs * 2 ** Math.min(failures, 4);
  return Math.min(delay, maxMs);
}

export function nextErrorDelay(consecutiveFailures: number): number {
  return nextPollDelay(consecutiveFailures, ERROR_BASE_POLL_MS, ERROR_MAX_POLL_MS);
}

/** Monotonic request ids let late responses lose to newer reads. */
export function isStaleResponse(requestId: number, latestRequestId: number): boolean {
  return requestId < latestRequestId;
}

export function syncLabel(
  loading: boolean,
  error: string,
  lastSuccessAt: number | null,
  activeTurn: boolean,
): string {
  if (loading && lastSuccessAt === null && !error) return "loading";
  if (error && lastSuccessAt === null) return "error";
  if (error) return "stale";
  if (loading) return "syncing";
  if (activeTurn) return "watching";
  return "synced";
}
