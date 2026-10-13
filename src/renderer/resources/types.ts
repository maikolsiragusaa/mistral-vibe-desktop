export type McpSourceKind = "server" | "connector" | "plugin" | string;
export type McpSourceStatus =
  | "connected"
  | "needs_auth"
  | "disabled"
  | "error"
  | "unknown"
  | string;

export interface McpToolEntry {
  name: string;
  description?: string;
  enabled?: boolean;
}

export interface McpSource {
  name: string;
  displayName?: string;
  display_name?: string;
  kind?: McpSourceKind;
  transport?: string;
  status?: McpSourceStatus;
  tools?: McpToolEntry[];
  error?: string | null;
  pluginName?: string | null;
  plugin_name?: string | null;
  disabled?: boolean;
}

export interface SkillEntry {
  name: string;
  description?: string;
  prompt?: string;
  source?: string;
  scope?: string;
  enabled?: boolean;
  version?: number | string;
  alias?: string;
  skillId?: string;
  skill_id?: string;
  local?: boolean;
  updateAvailable?: boolean;
  loadError?: string;
}

export interface SkillCatalogEntry {
  name?: string;
  skillId?: string;
  skill_id?: string;
  description?: string;
  source?: string;
  origin?: string;
  version?: number | string;
  versions?: Array<number | string>;
  scope?: string;
}

export interface PluginEntry {
  name: string;
  version?: string;
  description?: string;
  author?: string | { name?: string };
  scope?: string;
  sourceFormat?: string;
  source_format?: string;
  components?: Array<{ kind?: string; name?: string; status?: string | null }>;
  drifted?: number;
}

export interface PluginComponent {
  kind?: string;
  name?: string;
  sourcePath?: string;
  source_path?: string;
  config?: Record<string, string | number | boolean | null>;
}

export interface ConfigLayerValue {
  layer: string;
  value: unknown;
}

export interface ConfigField {
  name: string;
  kind?: string;
  path?: string;
  value?: unknown;
  layerValues?: ConfigLayerValue[];
}

export interface StdioServerDraft {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  env: Array<{ key: string; value: string }>;
  disabled: boolean;
}

export interface McpServerRecord {
  name: string;
  transport?: string;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string | null;
  disabled?: boolean;
  prompt?: string;
}

export interface CapabilityState {
  configured: boolean;
  enabled: boolean;
  connected: boolean;
  usable: string;
}

export function sourceDisplayName(source: McpSource): string {
  return source.displayName ?? source.display_name ?? source.name;
}

export function sourcePluginName(source: McpSource): string | null {
  return source.pluginName ?? source.plugin_name ?? null;
}

export function capabilityOf(source: McpSource): CapabilityState {
  const status = (source.status ?? "unknown").toLowerCase();
  const configured = Boolean(source.name);
  const enabled = status !== "disabled";
  const connected = status === "connected" || status === "ready";
  const toolCount = Array.isArray(source.tools) ? source.tools.length : 0;
  let usable = "not verifiable";
  if (!configured) usable = "unknown";
  else if (!enabled) usable = "disabled";
  else if (source.error) usable = "error";
  else if (status === "needs_auth" || status === "needs-auth") usable = "awaits authentication";
  else if (connected && toolCount > 0) usable = `usable (${toolCount} tools)`;
  else if (connected) usable = "connected, tools not listed";
  else if (toolCount > 0) usable = "configured, connection not verified";
  return { configured, enabled, connected, usable };
}
