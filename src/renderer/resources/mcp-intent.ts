import type {
  McpEnvChange,
  McpMutationIntent,
  McpScalarChanges,
  RedactedMcpServer,
} from "./mcp-mutation-types";

export interface StdioFormState {
  command: string;
  args: string[];
  cwd: string;
  prompt: string;
  startupTimeout: string;
  toolTimeout: string;
  samplingEnabled: boolean;
  disabled: boolean;
  disabledTools: string[];
}

export interface EnvFormState {
  kept: string[];
  replaced: Record<string, string>;
  added: Record<string, string>;
  removed: string[];
}

function numbersEqual(a: number | undefined, b: number | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a === b;
}

function arraysEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function optionalText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function optionalNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Scalar end-state the form manages; the service diffs it again server-side. */
export function formToScalars(form: StdioFormState): McpScalarChanges {
  return {
    command: form.command.trim(),
    args: [...form.args],
    cwd: optionalText(form.cwd),
    prompt: optionalText(form.prompt),
    startup_timeout_sec: optionalNumber(form.startupTimeout),
    tool_timeout_sec: optionalNumber(form.toolTimeout),
    sampling_enabled: form.samplingEnabled,
    disabled: form.disabled,
    disabled_tools: [...form.disabledTools],
  };
}

export function scalarsFromSnapshot(entry: RedactedMcpServer): McpScalarChanges {
  const out: McpScalarChanges = {};
  if (typeof entry.command === "string") out.command = entry.command;
  if (Array.isArray(entry.args)) out.args = entry.args.filter((a): a is string => typeof a === "string");
  if (typeof entry.cwd === "string" || entry.cwd === null) out.cwd = entry.cwd ?? null;
  if (typeof entry.prompt === "string" || entry.prompt === null) out.prompt = entry.prompt ?? null;
  if (typeof entry.startup_timeout_sec === "number") out.startup_timeout_sec = entry.startup_timeout_sec;
  if (typeof entry.tool_timeout_sec === "number") out.tool_timeout_sec = entry.tool_timeout_sec;
  if (typeof entry.sampling_enabled === "boolean") out.sampling_enabled = entry.sampling_enabled;
  if (typeof entry.disabled === "boolean") out.disabled = entry.disabled;
  if (Array.isArray(entry.disabled_tools))
    out.disabled_tools = entry.disabled_tools.filter((a): a is string => typeof a === "string");
  return out;
}

/**
 * Keep only fields that differ from the redacted snapshot. Unknown snapshot
 * fields are never included, so they can never be overwritten or dropped.
 */
export function diffScalars(
  baseline: McpScalarChanges,
  desired: McpScalarChanges,
): { fields: McpScalarChanges; unset: string[] } {
  const fields: McpScalarChanges = {};
  const unset: string[] = [];
  const keys: (keyof McpScalarChanges)[] = [
    "command",
    "args",
    "cwd",
    "prompt",
    "startup_timeout_sec",
    "tool_timeout_sec",
    "sampling_enabled",
    "disabled",
    "disabled_tools",
  ];
  for (const key of keys) {
    const before = baseline[key];
    const after = desired[key];
    if (after === undefined) continue;
    if (key === "args" || key === "disabled_tools") {
      if (!arraysEqual(before as string[] | undefined, after as string[] | undefined))
        (fields[key] as unknown) = after;
      continue;
    }
    if (key === "startup_timeout_sec" || key === "tool_timeout_sec") {
      if (!numbersEqual(before as number | undefined, after as number | undefined)) {
        if (after === undefined) unset.push(key);
        else (fields[key] as unknown) = after;
      }
      continue;
    }
    if (key === "cwd" || key === "prompt") {
      const normBefore = (before as string | null | undefined) ?? null;
      const normAfter = (after as string | null | undefined) ?? null;
      if (normBefore !== normAfter) {
        if (normAfter === null) unset.push(key);
        else (fields[key] as unknown) = normAfter;
      }
      continue;
    }
    if (before !== after) (fields[key] as unknown) = after;
  }
  return { fields, unset };
}

export function buildEnvChange(
  existingKeys: string[],
  form: EnvFormState,
): McpEnvChange | null {
  const known = new Set(existingKeys);
  const keep = form.kept.filter((key) => known.has(key) && !form.removed.includes(key));
  const remove = form.removed.filter((key) => known.has(key));
  const set: Record<string, string> = {};
  for (const [key, value] of Object.entries(form.replaced)) {
    if (known.has(key) && !remove.includes(key)) set[key] = value;
  }
  for (const [key, value] of Object.entries(form.added)) {
    if (!known.has(key)) set[key] = value;
  }
  if (keep.length === existingKeys.length && remove.length === 0 && Object.keys(set).length === 0)
    return null;
  return { keep, set, remove };
}

export function buildAddIntent(
  name: string,
  revision: string | null,
  form: StdioFormState,
  env: Record<string, string>,
  targetLayer: string | null,
): McpMutationIntent {
  const scalars = formToScalars(form);
  return {
    op: "add",
    name: name.trim(),
    expectedRevision: revision,
    targetLayer,
    entry: { ...scalars, env: { ...env } },
  };
}

export function buildEditIntent(
  snapshotEntry: RedactedMcpServer,
  revision: string | null,
  form: StdioFormState,
  envChange: McpEnvChange | null,
): McpMutationIntent {
  const { fields, unset } = diffScalars(scalarsFromSnapshot(snapshotEntry), formToScalars(form));
  return {
    op: "set",
    name: snapshotEntry.name,
    expectedRevision: revision,
    fields,
    unset,
    env: envChange,
  };
}

export function isEmptyEdit(intent: McpMutationIntent): boolean {
  return (
    intent.op === "set" &&
    Object.keys(intent.fields).length === 0 &&
    (intent.unset ?? []).length === 0 &&
    intent.env === null
  );
}
