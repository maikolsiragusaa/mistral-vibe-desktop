import type {
  ConfigField,
  ConfigLayerValue,
  McpSource,
  McpToolEntry,
  PluginComponent,
  PluginEntry,
  SkillCatalogEntry,
  SkillEntry,
} from "./types";

export type PlainRecord = Record<string, string | number | boolean | null | undefined | unknown>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function unwrap<T>(response: unknown, key: string): T | undefined {
  if (!isRecord(response)) return undefined;
  return response[key] as T | undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((entry): entry is string => typeof entry === "string");
  return out;
}

export function listFromSkills(value: unknown): SkillEntry[] {
  const holder = isRecord(value) ? value : {};
  const raw = holder["skills"];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): SkillEntry[] => {
    if (!isRecord(entry)) return [];
    const name = text(entry["name"] ?? entry["skillId"] ?? entry["skill_id"]);
    if (!name) return [];
    const versionRaw = entry["version"];
    return [
      {
        name,
        description: text(entry["description"]),
        prompt: text(entry["prompt"]),
        source: text(entry["source"] ?? entry["origin"]),
        scope: text(entry["scope"]),
        enabled: typeof entry["enabled"] === "boolean" ? entry["enabled"] : undefined,
        version:
          typeof versionRaw === "number" || typeof versionRaw === "string"
            ? versionRaw
            : undefined,
        alias: text(entry["alias"]),
        skillId: text(entry["skillId"] ?? entry["skill_id"]),
        local: typeof entry["local"] === "boolean" ? entry["local"] : undefined,
        loadError: text(entry["loadError"] ?? entry["load_error"]),
      },
    ];
  });
}

export function listFromCatalog(value: unknown): SkillCatalogEntry[] {
  const holder = isRecord(value) ? value : {};
  const raw = holder["skills"];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): SkillCatalogEntry[] => {
    if (!isRecord(entry)) return [];
    const name = text(entry["name"]);
    const skillId = text(entry["skillId"] ?? entry["skill_id"] ?? entry["name"]);
    if (!name && !skillId) return [];
    const versionRaw = entry["version"];
    const versionsRaw = entry["versions"];
    return [
      {
        name,
        skillId,
        description: text(entry["description"]),
        source: text(entry["source"] ?? entry["origin"]),
        origin: text(entry["origin"]),
        version:
          typeof versionRaw === "number" || typeof versionRaw === "string"
            ? versionRaw
            : undefined,
        versions: Array.isArray(versionsRaw)
          ? versionsRaw.filter(
              (v): v is number | string =>
                typeof v === "number" || typeof v === "string",
            )
          : undefined,
        scope: text(entry["scope"]),
      },
    ];
  });
}

export function sourcesFromMcp(value: unknown): McpSource[] {
  const holder = isRecord(value) ? value : {};
  const nested = isRecord(holder["mcp"]) ? (holder["mcp"] as Record<string, unknown>) : holder;
  const raw = nested["sources"];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): McpSource[] => {
    if (!isRecord(entry)) return [];
    const name = text(entry["name"]);
    if (!name) return [];
    const toolsRaw = entry["tools"];
    const tools: McpToolEntry[] = Array.isArray(toolsRaw)
      ? toolsRaw.flatMap((tool): McpToolEntry[] => {
          if (!isRecord(tool)) return [];
          const toolName = text(tool["name"]);
          if (!toolName) return [];
          return [
            {
              name: toolName,
              description: text(tool["description"]),
              enabled: typeof tool["enabled"] === "boolean" ? tool["enabled"] : undefined,
            },
          ];
        })
      : [];
    return [
      {
        name,
        displayName: text(entry["displayName"] ?? entry["display_name"]),
        kind: typeof entry["kind"] === "string" ? entry["kind"] : undefined,
        transport: typeof entry["transport"] === "string" ? entry["transport"] : undefined,
        status: typeof entry["status"] === "string" ? entry["status"] : undefined,
        tools,
        error:
          typeof entry["error"] === "string" || entry["error"] === null
            ? (entry["error"] as string | null)
            : undefined,
        pluginName:
          typeof entry["pluginName"] === "string" || entry["pluginName"] === null
            ? (entry["pluginName"] as string | null)
            : typeof entry["plugin_name"] === "string" || entry["plugin_name"] === null
              ? (entry["plugin_name"] as string | null)
              : undefined,
        disabled: typeof entry["disabled"] === "boolean" ? entry["disabled"] : undefined,
      },
    ];
  });
}

export function listFromPlugins(value: unknown, key: string): PluginEntry[] {
  if (!isRecord(value)) return [];
  const raw = value[key];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): PluginEntry[] => {
    if (!isRecord(entry)) return [];
    const name = text(entry["name"]);
    if (!name) return [];
    const authorRaw = entry["author"];
    const componentsRaw = entry["components"];
    return [
      {
        name,
        version: text(entry["version"]),
        description: text(entry["description"]),
        author:
          typeof authorRaw === "string"
            ? authorRaw
            : isRecord(authorRaw)
              ? text(authorRaw["name"])
              : undefined,
        scope: text(entry["scope"]),
        sourceFormat: text(entry["sourceFormat"] ?? entry["source_format"]),
        components: Array.isArray(componentsRaw)
          ? componentsRaw.flatMap((c): Array<{ kind?: string; name?: string; status?: string | null }> => {
              if (!isRecord(c)) return [];
              return [
                {
                  kind: typeof c["kind"] === "string" ? (c["kind"] as string) : undefined,
                  name: text(c["name"]),
                  status:
                    typeof c["status"] === "string" || c["status"] === null
                      ? (c["status"] as string | null)
                      : undefined,
                },
              ];
            })
          : undefined,
        drifted: typeof entry["drifted"] === "number" ? entry["drifted"] : undefined,
      },
    ];
  });
}

export function componentsFromInfo(value: unknown): PluginComponent[] {
  if (!isRecord(value)) return [];
  const info = isRecord(value["info"]) ? (value["info"] as Record<string, unknown>) : value;
  const raw = info["components"];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): PluginComponent[] => {
    if (!isRecord(entry)) return [];
    const config: PluginComponent["config"] = {};
    if (isRecord(entry["config"])) {
      for (const [k, v] of Object.entries(entry["config"])) {
        if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean")
          config[k] = v;
      }
    }
    return [
      {
        kind: typeof entry["kind"] === "string" ? (entry["kind"] as string) : undefined,
        name: text(entry["name"]),
        sourcePath: text(entry["sourcePath"] ?? entry["source_path"]),
        config,
      },
    ];
  });
}

export function fieldsFromConfig(value: unknown): { targets: string[]; fields: ConfigField[] } {
  if (!isRecord(value)) return { targets: [], fields: [] };
  const targets = Array.isArray(value["targets"])
    ? (value["targets"] as unknown[]).filter((t): t is string => typeof t === "string")
    : [];
  const rawFields = value["fields"];
  const fields: ConfigField[] = Array.isArray(rawFields)
    ? rawFields.flatMap((entry): ConfigField[] => {
        if (!isRecord(entry)) return [];
        if (typeof entry["name"] !== "string") return [];
        const layerValues = Array.isArray(entry["layerValues"])
          ? (entry["layerValues"] as unknown[]).flatMap((lv): ConfigLayerValue[] => {
              if (!isRecord(lv) || typeof lv["layer"] !== "string") return [];
              return [{ layer: lv["layer"] as string, value: lv["value"] }];
            })
          : undefined;
        return [
          {
            name: entry["name"] as string,
            kind: typeof entry["kind"] === "string" ? (entry["kind"] as string) : undefined,
            path: typeof entry["path"] === "string" ? (entry["path"] as string) : undefined,
            value: entry["value"],
            layerValues,
          },
        ];
      })
    : [];
  return { targets, fields };
}

export function getErrorMessage(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value ?? "Unknown error");
  return raw
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(
      /\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password)(\s*[:=]\s*)\S+/gi,
      "$1$2[redacted]",
    )
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[URL]")
    .slice(0, 280);
}

export function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export { stringList };
