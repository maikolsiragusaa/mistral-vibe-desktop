import type { RpcEvent, SessionState } from "./types.ts";

/** Reduce public wire projections only; Vibe remains the session owner. */
export function applyPatch<T>(
  source: T,
  patches: { op: string; path: string; value?: unknown }[],
): T {
  let document: any = structuredClone(source);
  for (const patch of patches) {
    if (patch.path === "") {
      if (patch.op !== "replace" && patch.op !== "add")
        throw new Error("Unsupported root patch");
      document = structuredClone(patch.value);
      continue;
    }
    if (!patch.path.startsWith("/")) throw new Error("Invalid JSON pointer");
    const keys = patch.path
      .slice(1)
      .split("/")
      .map((key) => key.replace(/~1/g, "/").replace(/~0/g, "~"));
    if (
      keys.some((key) =>
        ["__proto__", "constructor", "prototype"].includes(key),
      )
    )
      throw new Error("Unsafe JSON pointer");
    let target = document;
    for (const key of keys.slice(0, -1)) {
      if (target === null || typeof target !== "object" || !(key in target))
        throw new Error("Missing patch parent");
      target = target[key];
    }
    const key = keys.at(-1)!;
    switch (patch.op) {
      case "append":
        if (typeof target[key] !== "string" || typeof patch.value !== "string")
          throw new Error("Append requires strings");
        target[key] += patch.value;
        break;
      case "replace":
        if (!(key in target)) throw new Error("Missing replace target");
        target[key] = structuredClone(patch.value);
        break;
      case "add":
        if (Array.isArray(target)) {
          const index = key === "-" ? target.length : Number(key);
          if (!Number.isInteger(index) || index < 0 || index > target.length)
            throw new Error("Invalid array index");
          target.splice(index, 0, structuredClone(patch.value));
        } else target[key] = structuredClone(patch.value);
        break;
      case "remove":
        if (!(key in target)) throw new Error("Missing remove target");
        if (Array.isArray(target)) target.splice(Number(key), 1);
        else delete target[key];
        break;
      case "test":
        if (JSON.stringify(target[key]) !== JSON.stringify(patch.value))
          throw new Error("Patch test failed");
        break;
      default:
        throw new Error(`Unknown patch: ${patch.op}`);
    }
  }
  return document;
}

export function reduceEvent(
  current: SessionState,
  event: RpcEvent,
): SessionState {
  const p = event.params;
  if (
    p.state &&
    ["session/compacted", "session/contextCleared"].includes(event.method)
  )
    return p.state;
  if (p.state && event.method === "session/snapshot") {
    if (p.state.session.id !== current.session.id) return current;
    if (p.state.eventId <= current.eventId) return current;
    // Background-work snapshots omit history and turns; null means "not included".
    return {
      ...p.state,
      history: p.state.history ?? current.history,
      historyBeforeCursor:
        p.state.history == null
          ? current.historyBeforeCursor
          : p.state.historyBeforeCursor,
      turns: p.state.turns ?? current.turns,
    };
  }
  if (p.sessionId && p.sessionId !== current.session.id) return current;
  if (!Number.isSafeInteger(p.eventId)) return current;
  if (p.eventId <= current.eventId) return current;
  if (p.eventId !== current.eventId + 1)
    throw new Error("Event gap; reload the public session");
  const next = structuredClone(current);
  next.eventId = p.eventId;
  const upsert = <T extends { id: string }>(items: T[], item: T) => {
    const index = items.findIndex((existing) => existing.id === item.id);
    if (index < 0) items.push(item);
    else items[index] = item;
  };
  switch (event.method) {
    case "history/entryAdded":
      upsert((next.history ??= []), p.entry);
      break;
    case "history/entryUpdated": {
      const entries = next.history ?? [];
      const index = entries.findIndex((entry) => entry.id === p.entryId);
      if (index >= 0) entries[index] = applyPatch(entries[index], p.patch);
      break;
    }
    case "session/updated":
      next.session = applyPatch(next.session, p.patch);
      break;
    case "turn/started":
    case "turn/completed":
      upsert((next.turns ??= []), p.turn);
      next.retrying = null;
      break;
    case "turn/queueUpdated":
      next.turnQueue = p.queue;
      break;
    case "session/childSessionUpdated":
      upsert(next.childSessions, p.childSession);
      break;
    case "session/statsUpdated":
      next.session.tokenUsage = p.stats.tokenUsage;
      break;
  }
  next.activeCallbacks = (next.history ?? []).filter(
    (entry) => entry.type === "callback" && entry.state?.status === "open",
  );
  return next;
}
