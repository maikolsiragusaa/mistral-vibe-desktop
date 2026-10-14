import { createHash } from "node:crypto";

const MCP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CREDENTIAL_KEY_PATTERN =
  /(?:secret|password|token|authorization|headers|api_key)(?!_env_var)/i;

// Scalar mcp_servers fields this service manages through targeted leaf ops.
// Unknown upstream fields are never written and therefore never dropped.
const MANAGED_FIELDS = new Set([
  "transport",
  "url",
  "command",
  "args",
  "cwd",
  "prompt",
  "startup_timeout_sec",
  "tool_timeout_sec",
  "sampling_enabled",
  "disabled",
  "disabled_tools",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value, label, { min = 1, max = 4096 } = {}) {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw new TypeError(`${label} must be a string between ${min} and ${max} characters`);
  }
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value))
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (isObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  return JSON.stringify(value) ?? "null";
}

export function fingerprintServers(list) {
  return createHash("sha256").update(canonicalJson(list ?? [])).digest("hex");
}

function redactValue(key, value) {
  if (key === "env" && isObject(value)) return undefined;
  if (typeof value === "string" && CREDENTIAL_KEY_PATTERN.test(key))
    return { redacted: true };
  return value;
}

export function redactServer(entry) {
  if (!isObject(entry)) return { name: "" };
  const out = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key === "env") continue;
    const redacted = redactValue(key, value);
    if (redacted !== undefined) out[key] = redacted;
  }
  out.envKeys = isObject(entry.env) ? Object.keys(entry.env).sort() : [];
  out.envConfigured = out.envKeys.length > 0;
  if (typeof out.name !== "string") out.name = "";
  return out;
}

function scrubMessage(value) {
  return String(value ?? "Unknown error")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(
      /\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password)(\s*[:=]\s*)\S+/gi,
      "$1$2[redacted]",
    )
    .replace(/[A-Za-z_][A-Za-z0-9_]*=["'][^"']{4,}["']/g, (match) =>
      match.replace(/=["'].*["']$/, '="[redacted]"'),
    )
    .slice(0, 300);
}

function validateName(name) {
  const raw = requireString(name, "MCP server name", { min: 1, max: 128 });
  if (!MCP_NAME_PATTERN.test(raw))
    throw new TypeError(
      "MCP server name must start alphanumerically and use only letters, digits, dot, underscore or dash",
    );
  return raw;
}

function validateScalarField(key, value) {
  if (!MANAGED_FIELDS.has(key))
    throw new TypeError(`MCP field is not managed here: ${key}`);
  switch (key) {
    case "transport":
      if (!["http", "streamable-http", "stdio"].includes(value))
        throw new TypeError("MCP transport must be http, streamable-http or stdio");
      return value;
    case "url": {
      const raw = requireString(value, "MCP URL", { max: 2048 });
      let url;
      try {
        url = new URL(raw);
      } catch {
        throw new TypeError("MCP URL must be a valid URL");
      }
      if (url.protocol !== "https:" || url.username || url.password)
        throw new TypeError("MCP URL must use HTTPS and cannot contain credentials");
      return raw;
    }
    case "command": {
      const raw = requireString(value, "command", { min: 1, max: 1024 });
      if (raw.includes("\0") || /[\r\n]/.test(raw))
        throw new TypeError("MCP command must not contain line breaks");
      if (/[;&|`$]/.test(raw))
        throw new TypeError("MCP command must be an executable, not a shell string");
      return raw;
    }
    case "args":
      if (!Array.isArray(value) || value.length > 64)
        throw new TypeError("MCP args must be a list of at most 64 entries");
      for (const entry of value) {
        requireString(entry, "MCP arg", { min: 0, max: 4096 });
        if (entry.includes("\0"))
          throw new TypeError("MCP args must not contain null bytes");
      }
      return [...value];
    case "cwd": {
      if (value === null || value === undefined || value === "") return null;
      const raw = requireString(value, "cwd", { min: 1, max: 4096 });
      if (raw.includes("\0")) throw new TypeError("MCP working directory is invalid");
      if (raw.startsWith("\\\\"))
        throw new TypeError("MCP working directory cannot be UNC");
      if (!/^[A-Za-z]:[\\/]/.test(raw) && !raw.startsWith("/"))
        throw new TypeError("MCP working directory must be absolute");
      return raw;
    }
    case "prompt":
      if (value === null || value === undefined) return null;
      return requireString(value, "prompt", { min: 0, max: 2000 });
    case "startup_timeout_sec":
    case "tool_timeout_sec":
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 600)
        throw new TypeError(`${key} must be between 0 and 600`);
      return value;
    case "sampling_enabled":
    case "disabled":
      if (typeof value !== "boolean") throw new TypeError(`${key} must be a boolean`);
      return value;
    case "disabled_tools":
      if (!Array.isArray(value) || value.length > 128)
        throw new TypeError("disabled_tools must be a list of at most 128 names");
      for (const entry of value) requireString(entry, "disabled tool", { max: 256 });
      return [...value];
    default:
      throw new TypeError(`MCP field is not managed here: ${key}`);
  }
}

function validateEnvMap(value, label) {
  if (!isObject(value)) throw new TypeError(`${label} must be an object map`);
  const keys = Object.keys(value);
  if (keys.length > 64) throw new TypeError(`${label} has too many entries`);
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!ENV_NAME_PATTERN.test(key))
      throw new TypeError("MCP env keys must be environment variable names");
    requireString(entry, `MCP env ${key}`, { min: 0, max: 8192 });
    if (entry.includes("\0"))
      throw new TypeError("MCP env values must not contain null bytes");
    out[key] = entry;
  }
  return out;
}

function valuesEqual(a, b) {
  if (typeof a === "number" && typeof b === "number") return a === b;
  return canonicalJson(a) === canonicalJson(b);
}

/**
 * Adapter around the official Mistral config API for mcp_servers mutations.
 * The renderer describes the desired change; this service owns freshness,
 * identity, field preservation, conflict detection, write inspection and
 * readback. It never rewrites whole lists from UI projections and never
 * returns existing env values.
 */
export class McpConfigService {
  constructor({ request }) {
    if (typeof request !== "function")
      throw new TypeError("McpConfigService requires a request function");
    this.request = request;
    this.tail = Promise.resolve();
  }

  #serialize(task) {
    const run = this.tail.then(task, task);
    this.tail = run.catch(() => {});
    return run;
  }

  async #readLayer(sessionId) {
    const response = await this.request("config/fields/read", { sessionId });
    const raw = response && typeof response === "object" ? response : {};
    const targets = Array.isArray(raw.targets)
      ? raw.targets.filter((entry) => typeof entry === "string")
      : [];
    const fields = Array.isArray(raw.fields) ? raw.fields : [];
    const field = fields.find(
      (entry) => isObject(entry) && entry.name === "mcp_servers",
    );
    const layerValues =
      field && Array.isArray(field.layerValues)
        ? field.layerValues.filter(isObject)
        : [];
    return { targets, layerValues };
  }

  #resolveLayer(layerValues, targets, intent, entryName) {
    if (
      typeof intent?.targetLayer === "string" &&
      intent.targetLayer &&
      targets.includes(intent.targetLayer)
    ) {
      const pinned = layerValues.find(
        (entry) => entry.layer === intent.targetLayer && Array.isArray(entry.value),
      );
      if (pinned) return pinned;
    }
    if (entryName) {
      const owned = layerValues.filter(
        (entry) =>
          Array.isArray(entry.value) &&
          entry.value.some((item) => isObject(item) && item.name === entryName),
      );
      const writableOwned = owned.filter((entry) => targets.includes(entry.layer));
      if (writableOwned.length === 1) return writableOwned[0];
      if (writableOwned.length > 1)
        throw Object.assign(
          new Error(`Server ${entryName} is declared in several writable layers; edit it where it is owned.`),
          { code: "mcp-layer-ambiguous" },
        );
      if (owned.length > 0)
        throw Object.assign(
          new Error(`Server ${entryName} is not in a writable layer exposed by Vibe.`),
          { code: "mcp-layer-readonly" },
        );
    }
    const writable = layerValues.find(
      (entry) => targets.includes(entry.layer) && Array.isArray(entry.value),
    );
    if (writable) return writable;
    // Fresh homes expose only the read-only default layer: resolve to the
    // first writable target with a virtual empty list. Adds then write a
    // full single-entry list (nothing exists to preserve); edits still
    // conflict because the named entry is absent everywhere.
    if (targets.length > 0) return { layer: targets[0], value: [] };
    throw Object.assign(
      new Error("Vibe exposed no mcp_servers configuration layer."),
      { code: "mcp-layer-missing" },
    );
  }

  async describe(sessionId) {
    requireString(sessionId, "sessionId", { max: 256 });
    const { targets, layerValues } = await this.#readLayer(sessionId);
    const layer = this.#resolveLayer(layerValues, targets, null, null);
    const list = layer.value;
    return {
      servers: list.map(redactServer),
      revision: fingerprintServers(list),
      targetLayer: layer.layer,
      targets,
    };
  }

  mutate(sessionId, rawIntent) {
    requireString(sessionId, "sessionId", { max: 256 });
    const intent = validateIntent(rawIntent);
    return this.#serialize(() => this.#apply(sessionId, intent));
  }

  async #apply(sessionId, intent) {
    let read;
    try {
      read = await this.#readLayer(sessionId);
    } catch (error) {
      return {
        outcome: "unknown",
        message: `The configuration could not be read (${scrubMessage(error)}). Nothing was written; retry after re-reading. No automatic retry was attempted.`,
        servers: [],
        revision: "",
        targetLayer: intent.targetLayer ?? "",
      };
    }
    let layer;
    try {
      layer = this.#resolveLayer(
        read.layerValues,
        read.targets,
        intent,
        intent.op === "add" ? null : intent.name,
      );
    } catch (error) {
      return {
        outcome: "rejected",
        message: `${scrubMessage(error)} Nothing was written.`,
        servers: [],
        revision: "",
        targetLayer: intent.targetLayer ?? "",
      };
    }
    const baseline = layer.value;
    const revision = fingerprintServers(baseline);
    const snapshot = () => ({
      servers: baseline.map(redactServer),
      revision,
      targetLayer: layer.layer,
    });
    if (intent.expectedRevision && intent.expectedRevision !== revision) {
      return {
        outcome: "conflict",
        message:
          "The MCP configuration changed since this view was loaded. Reload the layer and retry — nothing was written.",
        ...snapshot(),
      };
    }

    let index = -1;
    if (intent.op !== "add") {
      const matches = baseline
        .map((entry, position) => ({ entry, position }))
        .filter(({ entry }) => isObject(entry) && entry.name === intent.name);
      if (matches.length !== 1) {
        return {
          outcome: "conflict",
          message:
            matches.length === 0
              ? `Server ${intent.name} is no longer present. Reload the layer — nothing was written.`
              : `Server ${intent.name} is declared more than once. Refusing to guess which one to change.`,
          ...snapshot(),
        };
      }
      index = matches[0].position;
    } else if (baseline.some((entry) => isObject(entry) && entry.name === intent.name)) {
      return {
        outcome: "conflict",
        message: `A server named ${intent.name} already exists. Edit it instead of duplicating it.`,
        ...snapshot(),
      };
    }

    const current = index >= 0 ? baseline[index] : null;
    let ops;
    try {
      ops = this.#buildOps(intent, current, index, baseline);
    } catch (error) {
      if (error?.code === "mcp-env-conflict") {
        return {
          outcome: "conflict",
          message: `${scrubMessage(error.message)} Nothing was written.`,
          ...snapshot(),
        };
      }
      if (error?.code === "mcp-noop") {
        const verification = this.#verify(intent, baseline, baseline, index);
        return {
          outcome: verification.ok ? "applied-verified" : "readback-failed",
          message: verification.ok
            ? "No change was needed: the saved state already matches the request."
            : verification.message,
          ...snapshot(),
        };
      }
      throw error;
    }
    let receipt;
    try {
      receipt = await this.request("config/write", {
        sessionId,
        ops: ops.map((op) => ({ ...op, targetLayer: layer.layer })),
        reason: intent.reason ?? "MCP server change from Resources workspace",
        reloadRuntime: true,
      });
    } catch (error) {
      return {
        outcome: "unknown",
        message: `${scrubMessage(error)} The write may or may not have applied: re-read the layer before retrying. No automatic retry was attempted.`,
        servers: baseline.map(redactServer),
        revision,
        targetLayer: layer.layer,
      };
    }

    const failures = Array.isArray(receipt?.failures) ? receipt.failures : [];
    if (receipt?.rejected === true || failures.length > 0) {
      const detail = failures
        .map((failure) =>
          isObject(failure) && failure.path
            ? `${failure.path}: ${scrubMessage(failure.message)}`
            : scrubMessage(failure?.message ?? failure),
        )
        .join("; ");
      return {
        outcome: "rejected",
        message: `Vibe refused${failures.length ? " part of" : ""} the change${detail ? `: ${detail}` : "."} Nothing was assumed applied.`,
        servers: baseline.map(redactServer),
        revision,
        targetLayer: layer.layer,
      };
    }

    const pending = receipt?.status === "pending";
    try {
      await this.request("mcp_catalog/refresh", { sessionId });
    } catch {
      // Refresh is best-effort; the authoritative readback below decides.
    }

    let after;
    try {
      const reread = await this.#readLayer(sessionId);
      const nextLayer = reread.layerValues.find(
        (entry) => entry.layer === layer.layer && Array.isArray(entry.value),
      );
      if (!nextLayer) throw new Error("The configuration layer is no longer exposed");
      after = nextLayer.value;
    } catch (error) {
      return {
        outcome: "readback-failed",
        message: `The write was accepted but the verification read failed (${scrubMessage(error)}). Re-open the MCP view before making further changes.`,
        servers: baseline.map(redactServer),
        revision,
        targetLayer: layer.layer,
      };
    }

    const verification = this.#verify(intent, baseline, after, index);
    if (!verification.ok) {
      return {
        outcome: "readback-failed",
        message: `${verification.message} Re-open the MCP view before making further changes.`,
        servers: after.map(redactServer),
        revision: fingerprintServers(after),
        targetLayer: layer.layer,
      };
    }
    if (pending) {
      return {
        outcome: "pending-reload",
        message:
          "Vibe accepted the change but deferred the runtime reload (for example during an active turn). The saved state is shown; refresh the catalog to confirm the live state.",
        servers: after.map(redactServer),
        revision: fingerprintServers(after),
        targetLayer: layer.layer,
      };
    }
    return {
      outcome: "applied-verified",
      message: verification.message,
      servers: after.map(redactServer),
      revision: fingerprintServers(after),
      targetLayer: layer.layer,
    };
  }

  #buildOps(intent, current, index, baseline) {
    if (intent.op === "add") {
      // Whole-list write only when nothing exists to preserve; otherwise a
      // targeted append so concurrent entries are never rewritten.
      if ((baseline ?? []).length === 0)
        return [{ op: "set", path: "/mcp_servers", value: [intent.entry] }];
      return [{ op: "set", path: "/mcp_servers/-", value: intent.entry }];
    }
    if (intent.op === "remove") {
      return [{ op: "remove", path: `/mcp_servers/${index}` }];
    }
    const ops = [];
    if (intent.op === "enable") {
      ops.push({ op: "set", path: `/mcp_servers/${index}/disabled`, value: intent.disabled });
      return ops;
    }
    // intent.op === "set": only leaves that actually differ from fresh state.
    for (const [key, value] of Object.entries(intent.fields ?? {})) {
      if (valuesEqual(current?.[key], value)) continue;
      ops.push({ op: "set", path: `/mcp_servers/${index}/${key}`, value });
    }
    for (const key of intent.unset ?? []) {
      if (current?.[key] === undefined || current?.[key] === null) continue;
      ops.push({ op: "remove", path: `/mcp_servers/${index}/${key}` });
    }
    if (intent.env) {
      const existing = isObject(current?.env) ? current.env : {};
      const keep = intent.env.keep ?? [];
      const remove = intent.env.remove ?? [];
      const set = intent.env.set ?? {};
      for (const key of [...keep, ...remove]) {
        if (!Object.hasOwn(existing, key))
          throw Object.assign(
            new Error(
              `Environment variable ${key} changed underneath this edit. Reload the server and retry — nothing was written.`,
            ),
            { code: "mcp-env-conflict" },
          );
      }
      const merged = {};
      for (const key of keep) merged[key] = existing[key];
      for (const [key, value] of Object.entries(set)) merged[key] = value;
      const changed =
        !valuesEqual(merged, existing) ||
        Object.keys(existing).some((key) => !Object.hasOwn(merged, key));
      if (changed) ops.push({ op: "set", path: `/mcp_servers/${index}/env`, value: merged });
    }
    if (ops.length === 0)
      throw Object.assign(new Error("Nothing to change: the saved state already matches."), {
        code: "mcp-noop",
      });
    return ops;
  }

  #verify(intent, baseline, after, index) {
    const byName = (list, name) =>
      list.filter((entry) => isObject(entry) && entry.name === name);
    if (intent.op === "remove") {
      if (byName(after, intent.name).length > 0)
        return { ok: false, message: `Vibe still lists ${intent.name} after removal.` };
      return this.#verifyNeighbors(intent, baseline, after, null, "Removed");
    }
    const found = byName(after, intent.newName ?? intent.name);
    if (found.length !== 1)
      return {
        ok: false,
        message: `Vibe does not list ${(intent.newName ?? intent.name)} exactly once after the change.`,
      };
    const entry = found[0];
    if (intent.op === "add") {
      for (const [key, value] of Object.entries(intent.entry)) {
        if (key === "env") {
          if (!valuesEqual(entry.env ?? {}, value))
            return { ok: false, message: "The saved environment does not match the request." };
          continue;
        }
        if (!valuesEqual(entry[key], value))
          return { ok: false, message: `The saved field ${key} does not match the request.` };
      }
    } else if (intent.op === "enable") {
      if (entry.disabled !== intent.disabled)
        return { ok: false, message: "The saved enabled state does not match the request." };
    } else {
      for (const [key, value] of Object.entries(intent.fields ?? {})) {
        if (!valuesEqual(entry[key], value))
          return { ok: false, message: `The saved field ${key} does not match the request.` };
      }
      for (const key of intent.unset ?? []) {
        if (entry[key] !== undefined && entry[key] !== null)
          return { ok: false, message: `The field ${key} was not cleared.` };
      }
      if (intent.env) {
        const expected = {};
        const before = isObject(baseline[index]?.env) ? baseline[index].env : {};
        for (const key of intent.env.keep ?? []) expected[key] = before[key];
        Object.assign(expected, intent.env.set ?? {});
        if (!valuesEqual(entry.env ?? {}, expected))
          return { ok: false, message: "The saved environment does not match the request." };
      }
    }
    const verb =
      intent.op === "add"
        ? "Added"
        : intent.op === "enable"
          ? intent.disabled
            ? "Disabled"
            : "Enabled"
          : "Updated";
    return this.#verifyNeighbors(intent, baseline, after, entry.name, verb);
  }

  #verifyNeighbors(intent, baseline, after, changedName, verb) {
    const othersBefore = baseline.filter(
      (entry) => !isObject(entry) || entry.name !== intent.name,
    );
    const othersAfter = after.filter(
      (entry) => !isObject(entry) || entry.name !== (intent.newName ?? changedName),
    );
    if (intent.op === "add") {
      if (othersAfter.length !== othersBefore.length)
        return { ok: false, message: "The server list changed unexpectedly during the write." };
    } else if (intent.op === "remove") {
      if (othersAfter.length !== othersBefore.length)
        return { ok: false, message: "Other servers changed during removal." };
    } else if (othersAfter.length !== othersBefore.length) {
      return { ok: false, message: "The server list changed unexpectedly during the write." };
    }
    for (let position = 0; position < othersBefore.length; position += 1) {
      if (canonicalJson(othersBefore[position]) !== canonicalJson(othersAfter[position]))
        return {
          ok: false,
          message: `A different server (${isObject(othersAfter[position]) ? othersAfter[position].name : "?"} changed during the write.`,
        };
    }
    const subject = intent.op === "remove" ? intent.name : (intent.newName ?? changedName ?? intent.name);
    return { ok: true, message: `${verb} ${subject}; all other servers are unchanged.` };
  }
}

function validateIntent(raw) {
  if (!isObject(raw)) throw new TypeError("MCP mutation intent must be an object");
  const { op, name, expectedRevision, targetLayer, reason } = raw;
  if (!["add", "set", "enable", "remove"].includes(op))
    throw new TypeError("Unsupported MCP mutation");
  const cleanName = validateName(name);
  let expected = null;
  if (expectedRevision !== undefined && expectedRevision !== null)
    expected = requireString(expectedRevision, "expectedRevision", { max: 128 });
  if (targetLayer !== undefined && targetLayer !== null)
    requireString(targetLayer, "targetLayer", { max: 128 });
  if (reason !== undefined && reason !== null)
    requireString(reason, "reason", { max: 256 });
  const intent = {
    op,
    name: cleanName,
    expectedRevision: expected,
    targetLayer: targetLayer ?? null,
    reason: reason ?? "MCP server change from Resources workspace",
  };
  if (op === "add") {
    if (!isObject(raw.entry)) throw new TypeError("New server entry must be an object");
    intent.entry = validateFullEntry(raw.entry, cleanName);
    return intent;
  }
  if (op === "enable") {
    if (typeof raw.disabled !== "boolean")
      throw new TypeError("disabled must be a boolean");
    intent.disabled = raw.disabled;
    return intent;
  }
  if (op === "remove") return intent;
  // op === "set"
  const fields = {};
  if (raw.fields !== undefined) {
    if (!isObject(raw.fields)) throw new TypeError("fields must be an object map");
    for (const [key, value] of Object.entries(raw.fields))
      fields[key] = validateScalarField(key, value);
  }
  const unset = [];
  if (raw.unset !== undefined) {
    if (!Array.isArray(raw.unset)) throw new TypeError("unset must be a list");
    for (const key of raw.unset) {
      if (typeof key !== "string" || !MANAGED_FIELDS.has(key) || key === "name")
        throw new TypeError(`Field cannot be cleared here: ${String(key)}`);
      unset.push(key);
    }
  }
  let env = null;
  if (raw.env !== undefined && raw.env !== null) {
    if (!isObject(raw.env)) throw new TypeError("env change must be an object");
    const keep = raw.env.keep ?? [];
    const remove = raw.env.remove ?? [];
    const set = raw.env.set ?? {};
    if (!Array.isArray(keep) || !Array.isArray(remove) || !isObject(set))
      throw new TypeError("env change must use keep/remove lists and a set map");
    for (const key of [...keep, ...remove]) {
      if (!ENV_NAME_PATTERN.test(key))
        throw new TypeError("MCP env keys must be environment variable names");
    }
    env = { keep: [...keep], remove: [...remove], set: validateEnvMap(set, "env values") };
  }
  if (Object.keys(fields).length === 0 && unset.length === 0 && env === null)
    throw Object.assign(new Error("Nothing to change."), { code: "mcp-noop" });
  intent.fields = fields;
  intent.unset = unset;
  if (env) intent.env = env;
  return intent;
}

function validateFullEntry(raw, cleanName) {
  const entry = { name: cleanName };
  const transport = raw.transport === undefined ? "stdio" : raw.transport;
  entry.transport = validateScalarField("transport", transport);
  if (entry.transport === "stdio") {
    if (raw.url !== undefined)
      throw new TypeError("stdio MCP servers cannot declare a URL");
    entry.command = validateScalarField("command", raw.command);
    if (raw.args !== undefined) entry.args = validateScalarField("args", raw.args);
    else entry.args = [];
    if (raw.env !== undefined) entry.env = validateEnvMap(raw.env, "env");
    if (raw.cwd !== undefined && raw.cwd !== null && raw.cwd !== "")
      entry.cwd = validateScalarField("cwd", raw.cwd);
  } else {
    for (const key of ["command", "args", "env", "cwd"]) {
      if (raw[key] !== undefined)
        throw new TypeError("HTTP MCP servers cannot declare stdio fields");
    }
    entry.url = validateScalarField("url", raw.url);
  }
  for (const key of ["prompt", "startup_timeout_sec", "tool_timeout_sec", "sampling_enabled", "disabled", "disabled_tools"]) {
    if (raw[key] !== undefined && raw[key] !== null)
      entry[key] = validateScalarField(key, raw[key]);
  }
  for (const key of Object.keys(raw)) {
    if (key === "name") continue;
    if (
      !["transport", "url", "command", "args", "env", "cwd", ...MANAGED_FIELDS].includes(key)
    )
      throw new TypeError(`MCP field is not managed here: ${key}`);
  }
  return entry;
}
