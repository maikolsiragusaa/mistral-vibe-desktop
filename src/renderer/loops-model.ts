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
