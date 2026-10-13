/** Capability state without side effects.
 *
 * Rules (M2.0 hardening):
 * - Never auto-probe mutative RPCs. `session/compact` compacts history when
 *   the engine implements it, so merely opening a menu must not invoke it.
 * - Official discovery (runtime/server capability lists) is adopted when
 *   available, and it can only mark methods as verified — never unsupported.
 * - The registry alone never marks a method unsupported. Unsupported comes
 *   only from an explicit user-initiated call that answers method_not_found /
 *   not implemented.
 * - Cache is bound to the runtime identity (server version/instance). When
 *   the identity changes the cache is invalidated.
 * - Unknown is the safe default for anything not verifiable without effects.
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

/** Methods with observable side effects: never probed automatically. */
export const MUTATIVE_METHODS: ReadonlySet<string> = new Set([
  "session/compact",
  "review/approve",
  "review/revert",
  "session/rewind",
  "session/history/clear",
]);

export function isMutativeMethod(method: string): boolean {
  return MUTATIVE_METHODS.has(method);
}

/** True only for cheap, read-only probes that are safe to run automatically. */
export function canProbeSafely(method: string): boolean {
  return !isMutativeMethod(method);
}

const cache = new Map<string, Map<string, CapabilityState>>();
const sessionRuntimeVersions = new Map<string, string>();
let runtimeIdentity = "";

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
    if (oldest !== undefined) {
      cache.delete(oldest);
      sessionRuntimeVersions.delete(oldest);
    }
  }
}

export function getRuntimeIdentity(): string {
  return runtimeIdentity;
}

/** Bind the cache to a runtime version/instance; clears on change. */
export function setRuntimeIdentity(identity: string): void {
  if (identity !== runtimeIdentity) {
    runtimeIdentity = identity;
    cache.clear();
    sessionRuntimeVersions.clear();
  }
}

/**
 * Record which runtime version a session was seen on. A version change for
 * the same session id invalidates that session's cached verdicts.
 */
export function noteSessionRuntime(sessionId: string, serverVersion: string): void {
  const previous = sessionRuntimeVersions.get(sessionId);
  if (previous === undefined) {
    sessionRuntimeVersions.set(sessionId, serverVersion);
    return;
  }
  if (previous !== serverVersion) {
    sessionRuntimeVersions.set(sessionId, serverVersion);
    cache.delete(sessionId);
  }
}

/**
 * Adopt official capability discovery (e.g. runtime/read capabilities or
 * initialize serverInfo lists). Only marks listed methods as verified;
 * never marks anything unsupported — the registry alone is not a verdict.
 */
export function adoptDiscoveredCapabilities(
  sessionId: string,
  capabilities: unknown,
  serverVersion?: string,
): void {
  if (typeof serverVersion === "string" && serverVersion) {
    noteSessionRuntime(sessionId, serverVersion);
  }
  if (!Array.isArray(capabilities)) return;
  const listed = new Set(capabilities.filter((c): c is string => typeof c === "string"));
  for (const method of OPTIONAL_METHODS) {
    if (listed.has(method)) {
      setCapability(sessionId, method, "verified");
    }
  }
}

export function isUnsupportedError(message: string): boolean {
  return /method[_ ]not[_ ]found|not[_ ]implemented/i.test(message);
}

/** Record an explicit user-initiated success (the only way mutative methods verify). */
export function markExplicitSuccess(sessionId: string, method: string): void {
  setCapability(sessionId, method, "verified");
}

/** Record an explicit user-initiated not-implemented answer. */
export function markExplicitUnsupported(
  sessionId: string,
  method: string,
  message: string,
): boolean {
  if (!isUnsupportedError(message)) return false;
  setCapability(sessionId, method, "unsupported");
  return true;
}

type Requester = <T = unknown>(
  method: string,
  params?: Record<string, unknown>,
) => Promise<T>;

/**
 * Probe one optional method with a cheap read-only call. Never mutates:
 * mutative methods always resolve to the cached state (unknown unless a
 * previous explicit action verified or disproved them) without invoking the
 * requester at all.
 */
export async function probeCapability(
  request: Requester,
  sessionId: string,
  method: OptionalMethod,
): Promise<CapabilityState> {
  const known = getCapability(sessionId, method);
  if (known !== "unknown") return known;
  if (isMutativeMethod(method)) {
    // Mutative RPCs are verified only via explicit user actions that call
    // them directly. No automatic probe, no side effect.
    return "unknown";
  }
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
  sessionRuntimeVersions.delete(sessionId);
}
