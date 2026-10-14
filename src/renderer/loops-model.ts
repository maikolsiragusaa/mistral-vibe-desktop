/** Pure loop-row helpers: canonical ids only for destructive actions. */

export interface LoopWireItem {
  id?: unknown;
  loopId?: unknown;
  interval?: unknown;
  intervalSeconds?: unknown;
  cron?: unknown;
  prompt?: unknown;
  nextFireAt?: unknown;
  nextFire?: unknown;
  [key: string]: unknown;
}

/** Backend id, preferring `id` with legacy `loopId` fallback. Null when absent. */
export function canonicalLoopId(loop: LoopWireItem): string | null {
  for (const candidate of [loop.id, loop.loopId]) {
    if (typeof candidate === "string" && candidate) return candidate;
  }
  return null;
}

export function describeLoopInterval(loop: LoopWireItem): string {
  if (typeof loop.interval === "string" && loop.interval) return loop.interval;
  if (typeof loop.cron === "string" && loop.cron) return `cron ${loop.cron}`;
  if (typeof loop.intervalSeconds === "number" && Number.isFinite(loop.intervalSeconds)) {
    const seconds = loop.intervalSeconds;
    if (seconds % 3600 === 0) return `every ${seconds / 3600}h`;
    if (seconds % 60 === 0) return `every ${seconds / 60}m`;
    return `every ${seconds}s`;
  }
  return "scheduled";
}

export function describeLoopNextFire(loop: LoopWireItem): string | null {
  const raw = loop.nextFireAt ?? loop.nextFire;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  try {
    return `next: ${new Date(raw * 1000).toLocaleString()}`;
  } catch {
    return null;
  }
}

/** Rows must be objects; incomplete RPC data is dropped, never guessed. */
export function sanitizeLoops(raw: unknown): LoopWireItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is LoopWireItem => !!item && typeof item === "object");
}

/** Last execution, only when the backend exposes a real timestamp. Null otherwise —
 * the desktop never invents a last-run time. */
export function describeLoopLastRun(loop: LoopWireItem): string | null {
  const raw =
    loop.lastRunAt ?? loop.lastFiredAt ?? loop.lastFireAt ?? loop.lastRun ?? null;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  try {
    return `last: ${new Date(raw * 1000).toLocaleString()}`;
  } catch {
    return null;
  }
}

/** Explicit replace plan (no loops/update upstream): create the replacement
 * first, delete the original only after the replacement is validated.
 * Returns the ordered steps so the UI cannot delete first or duplicate. */
export interface LoopReplacePlan {
  oldId: string;
  interval: string;
  prompt: string;
}

export function planLoopReplace(
  oldLoop: LoopWireItem,
  next: { interval: string; prompt: string },
): LoopReplacePlan | null {
  const oldId = canonicalLoopId(oldLoop);
  const interval = next.interval.trim();
  const prompt = next.prompt.trim();
  if (!oldId || !interval || !prompt) return null;
  if (interval.length > 64 || prompt.length > 8000) return null;
  return { oldId, interval, prompt };
}
