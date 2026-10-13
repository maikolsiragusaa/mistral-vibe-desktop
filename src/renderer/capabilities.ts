/** Lightweight runtime capability detection.
 *
 * The protocol registry declares methods; the selected runtime (Unified vs
 * legacy) decides which ones run. This probe distinguishes, per session:
 * - verified: a cheap call succeeded.
 * - unsupported: the engine answered method_not_found / not implemented.
 * - unknown: never probed, or the probe failed for another reason.
 *
 * No second protocol and no version table: results are cached per session and
 * only cheap, non-mutating probes are used. Callers disable incompatible
 * actions with a concise explanation instead of firing doomed requests.
 */

export type CapabilityState = "verified" | "unsupported" | "unknown";

export const OPTIONAL_METHODS = [
  "session/compact",
  // review/state is probed as the representative of the review/* family
  // (baseline, turnDiff, hunks, approve, revert): when the engine reports it
  // as unsupported the UI gates the whole family without firing each member.
  "review/state",
  "stats/read",
  "diagnostics/list",
  "tools/list",
] as const;

export type OptionalMethod = (typeof OPTIONAL_METHODS)[number];

const cache = new Map<string, Map<string, CapabilityState>>();

function sessionCache(sessionId: string): Map<string, CapabilityState> {
  let entry = cache.get(sessionId);
  if (!entry) {
    entry = new Map();
    cache.set(sessionId, entry);
  }
  return entry;
}

export function getCapability(sessionId: string, method: string): CapabilityState {
  return sessionCache(sessionId).get(method) ?? "unknown";
}

export function setCapability(
  sessionId: string,
  method: string,
  state: CapabilityState,
): void {
  sessionCache(sessionId).set(method, state);
  if (cache.size > 20) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

export function isUnsupportedError(message: string): boolean {
  return /method[_ ]not[_ ]found|not[_ ]implemented/i.test(message);
}

type Requester = <T = unknown>(
  method: string,
  params?: Record<string, unknown>,
) => Promise<T>;

/** Probe one optional method with a cheap read-only call. Never mutates. */
export async function probeCapability(
  request: Requester,
  sessionId: string,
  method: OptionalMethod,
): Promise<CapabilityState> {
  const known = getCapability(sessionId, method);
  if (known !== "unknown") return known;
  try {
    await request(method, { sessionId });
    setCapability(sessionId, method, "verified");
    return "verified";
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    if (isUnsupportedError(message)) {
      setCapability(sessionId, method, "unsupported");
      return "unsupported";
    }
    // Authorization, missing session, network: not a capability verdict.
    return "unknown";
  }
}

export function forgetSession(sessionId: string): void {
  cache.delete(sessionId);
}
