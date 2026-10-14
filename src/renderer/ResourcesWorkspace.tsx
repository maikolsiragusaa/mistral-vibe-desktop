import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleHelp,
  ExternalLink,
  Eye,
  EyeOff,
  Layers,
  LoaderCircle,
  LockKeyhole,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import type { Runtime } from "./types";
import "./resources.css";
import { SkillImport, SkillLifecycle } from "./resources/SkillLifecycle";
import { StdioMcpDialog } from "./resources/StdioMcpDialog";
import { ToolsInspector } from "./resources/ToolsInspector";
import { LayerInspector } from "./resources/LayerInspector";
import { AcpPanel } from "./resources/AcpPanel";
import { describeMcpLayer, mutateMcpLayer } from "./resources/mcp-config-client";
import type {
  McpLayerSnapshot,
  McpMutationResult,
} from "./resources/mcp-mutation-types";

type ResourceTab =
  "mcp" | "skills" | "plugins" | "providers" | "diagnostics" | "usage";
type AnyRecord = Record<string, any>;

export interface ResourcesWorkspaceProps {
  sessionId?: string;
  runtime: Runtime | null;
  disabled?: boolean;
  onRuntime?: (runtime: Runtime) => void;
  onError?: (message: string) => void;
}

const TABS: { id: ResourceTab; label: string; icon: typeof Plug }[] = [
  { id: "mcp", label: "MCP", icon: Server },
  { id: "skills", label: "Skills", icon: Wrench },
  { id: "plugins", label: "Plugins", icon: Layers },
  { id: "providers", label: "Providers", icon: Plug },
  { id: "diagnostics", label: "Diagnostics", icon: Activity },
  { id: "usage", label: "Quota & usage", icon: ShieldCheck },
];

function isRecord(value: unknown): value is AnyRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unwrap<T = AnyRecord>(response: unknown, key: string): T | undefined {
  if (!isRecord(response)) return undefined;
  return response[key] as T | undefined;
}

function safeError(value: unknown): string {
  const raw =
    value instanceof Error ? value.message : String(value || "Unknown error");
  return raw
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(
      /\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password)(\s*[:=]\s*)\S+/gi,
      "$1$2[redacted]",
    )
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => safeUrl(url) || "[URL]")
    .slice(0, 280);
}

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol)) return undefined;
    if (
      url.protocol === "http:" &&
      !["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase())
    )
      return undefined;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, url.pathname === "/" ? "" : "/");
  } catch {
    return undefined;
  }
}

function editableApiBase(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash)
      return undefined;
    const allowed =
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase()));
    return allowed ? value : undefined;
  } catch {
    return undefined;
  }
}

function validApiBase(value: string): boolean {
  try {
    const url = new URL(value.trim());
    if (url.username || url.password || url.search || url.hash) return false;
    if (url.protocol === "https:") return true;
    return (
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

function validMcpEndpoint(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function valueAt(
  record: AnyRecord | null | undefined,
  camel: string,
  snake: string,
): unknown {
  if (!record) return undefined;
  return record[camel] ?? record[snake];
}

function formatCount(value: unknown): string {
  const number = finiteNumber(value);
  return number === undefined
    ? "Not reported"
    : Math.max(0, Math.round(number)).toLocaleString();
}

function formatReportedCount(value: unknown): string {
  const number = finiteNumber(value);
  return number === undefined || number <= 0
    ? "Not reported"
    : formatCount(number);
}

function formatDuration(value: unknown): string {
  const number = finiteNumber(value);
  if (number === undefined || number <= 0) return "Not reported";
  if (number < 60) return number.toFixed(1) + " s";
  const minutes = Math.floor(number / 60);
  const seconds = Math.round(number % 60);
  return minutes + " min " + seconds + " s";
}

function titleCase(value: unknown): string {
  if (typeof value !== "string" || !value) return "Unknown";
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function configFromEffective(value: unknown): AnyRecord {
  if (!isRecord(value)) return {};
  const config = isRecord(value.config) ? value.config : value;
  const providers = Array.isArray(config.providers)
    ? config.providers
        .map((provider: unknown) => {
          if (!isRecord(provider)) return null;
          return {
            name: typeof provider.name === "string" ? provider.name : "",
            apiBase: editableApiBase(provider.api_base ?? provider.apiBase),
            apiKeyEnvVar:
              typeof provider.api_key_env_var === "string"
                ? provider.api_key_env_var
                : undefined,
            backend:
              typeof provider.backend === "string"
                ? provider.backend
                : undefined,
            apiStyle:
              typeof provider.api_style === "string"
                ? provider.api_style
                : undefined,
          };
        })
        .filter(Boolean)
    : [];
  const sourceModels = config.models;
  const models: AnyRecord[] = [];
  if (isRecord(sourceModels)) {
    for (const [alias, model] of Object.entries(sourceModels)) {
      if (!isRecord(model)) continue;
      models.push({
        alias: typeof model.alias === "string" ? model.alias : alias,
        name: typeof model.name === "string" ? model.name : undefined,
        provider:
          typeof model.provider === "string" ? model.provider : undefined,
        displayName:
          typeof model.display_name === "string"
            ? model.display_name
            : undefined,
        maxContextLength: finiteNumber(model.max_context_length),
        supportsImages:
          typeof model.supports_images === "boolean"
            ? model.supports_images
            : undefined,
        thinking:
          typeof model.thinking === "string" ? model.thinking : undefined,
        thinkingLevels: Array.isArray(model.thinking_levels)
          ? model.thinking_levels.filter(
              (level: unknown) => typeof level === "string",
            )
          : undefined,
      });
    }
  } else if (Array.isArray(sourceModels)) {
    for (const model of sourceModels) {
      if (!isRecord(model)) continue;
      models.push({
        alias: typeof model.alias === "string" ? model.alias : "",
        name: typeof model.name === "string" ? model.name : undefined,
        provider:
          typeof model.provider === "string" ? model.provider : undefined,
        displayName:
          typeof model.display_name === "string"
            ? model.display_name
            : undefined,
        maxContextLength: finiteNumber(model.max_context_length),
        supportsImages:
          typeof model.supports_images === "boolean"
            ? model.supports_images
            : undefined,
        thinking:
          typeof model.thinking === "string" ? model.thinking : undefined,
        thinkingLevels: Array.isArray(model.thinking_levels)
          ? model.thinking_levels.filter(
              (level: unknown) => typeof level === "string",
            )
          : undefined,
      });
    }
  }
  const mcp_servers = Array.isArray(config.mcp_servers)
    ? config.mcp_servers.filter(isRecord).map((server: AnyRecord) => ({
        name: server.name,
        auth: { type: server.auth?.type },
      }))
    : [];
  return { providers, models, mcp_servers };
}

function cleanPluginInfo(value: unknown): AnyRecord {
  const info =
    isRecord(value) && isRecord(value.info)
      ? value.info
      : isRecord(value)
        ? value
        : {};
  const components = Array.isArray(info.components)
    ? info.components.filter(isRecord).map((component: AnyRecord) => ({
        kind: typeof component.kind === "string" ? component.kind : "unknown",
        name:
          typeof component.name === "string"
            ? component.name
            : "Unnamed component",
      }))
    : [];
  return { components };
}

function cleanConfigFields(value: unknown): {
  targets: string[];
  providerLayers: {
    layer: string;
    providers: { name: string; apiBase?: string }[];
  }[];
} {
  const fields =
    isRecord(value) && Array.isArray(value.fields) ? value.fields : [];
  const targets =
    isRecord(value) && Array.isArray(value.targets)
      ? value.targets.filter(
          (item: unknown): item is string => typeof item === "string",
        )
      : [];
  const providerField = fields.find(
    (field: unknown) => isRecord(field) && field.name === "providers",
  );
  const layerValues =
    isRecord(providerField) && Array.isArray(providerField.layerValues)
      ? providerField.layerValues
      : isRecord(providerField) && Array.isArray(providerField.layer_values)
        ? providerField.layer_values
        : [];
  const providerLayers = layerValues
    .filter(isRecord)
    .flatMap((entry: AnyRecord) => {
      const layer = typeof entry.layer === "string" ? entry.layer : "";
      const list = Array.isArray(entry.value) ? entry.value : [];
      if (!layer || !targets.includes(layer)) return [];
      return [
        {
          layer,
          providers: list
            .filter(isRecord)
            .map((provider: AnyRecord) => ({
              name: typeof provider.name === "string" ? provider.name : "",
              apiBase: editableApiBase(provider.api_base ?? provider.apiBase),
            }))
            .filter((provider: { name: string }) => provider.name),
        },
      ];
    });
  return { targets, providerLayers };
}

function listFrom(value: unknown, key: string): AnyRecord[] {
  if (!isRecord(value) || !Array.isArray(value[key])) return [];
  return value[key].filter(isRecord).map((item: AnyRecord) => ({
    ...item,
    skill_id: item.skillId ?? item.skill_id,
    latest_version: item.latestVersion ?? item.latest_version,
    sharing_scope: item.sharingScope ?? item.sharing_scope,
    source_format: item.sourceFormat ?? item.source_format,
    installed_root: item.installedRoot ?? item.installed_root,
    pinned_root: item.pinnedRoot ?? item.pinned_root,
  }));
}

function sourcesFrom(value: unknown): AnyRecord[] {
  if (!isRecord(value)) return [];
  const source = isRecord(value.mcp) ? value.mcp : value;
  return Array.isArray(source.sources)
    ? source.sources.filter(isRecord).map((item: AnyRecord) => ({
        ...item,
        display_name: item.displayName ?? item.display_name,
        plugin_name: item.pluginName ?? item.plugin_name,
      }))
    : [];
}

function getErrorMessage(value: unknown): string {
  return safeError(value);
}

function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <article className="rw-stat">
      <small>{label}</small>
      <strong>{value}</strong>
      {hint && <span>{hint}</span>}
    </article>
  );
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="rw-empty">
      <CircleHelp size={20} aria-hidden="true" />
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}

export function ResourcesWorkspace({
  sessionId,
  runtime,
  disabled = false,
  onRuntime,
  onError,
}: ResourcesWorkspaceProps) {
  const [tab, setTab] = useState<ResourceTab>("mcp");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [mcp, setMcp] = useState<AnyRecord | null>(null);
  const [skills, setSkills] = useState<AnyRecord[]>([]);
  const [skillCatalog, setSkillCatalog] = useState<AnyRecord[] | null>(null);
  const [catalogMeta, setCatalogMeta] = useState<AnyRecord>({});
  const [selectedSkill, setSelectedSkill] = useState<AnyRecord | null>(null);
  const [skillDetail, setSkillDetail] = useState<AnyRecord | null>(null);
  const [plugins, setPlugins] = useState<AnyRecord[]>([]);
  const [droppedPlugins, setDroppedPlugins] = useState<AnyRecord[]>([]);
  const [pluginInfo, setPluginInfo] = useState<AnyRecord>({ components: [] });
  const [config, setConfig] = useState<AnyRecord>({
    providers: [],
    models: [],
  });
  const [configFields, setConfigFields] = useState<
    ReturnType<typeof cleanConfigFields>
  >({ targets: [], providerLayers: [] });
  const [stats, setStats] = useState<AnyRecord | null>(null);
  const [diagnostics, setDiagnostics] = useState<AnyRecord | null>(null);
  const [account, setAccount] = useState<AnyRecord | null>(null);
  const [authLinks, setAuthLinks] = useState<AnyRecord[]>([]);
  const [confirmRemove, setConfirmRemove] = useState<AnyRecord | null>(null);
  const [addMcpOpen, setAddMcpOpen] = useState(false);
  const [addProviderOpen, setAddProviderOpen] = useState(false);
  const [addModelOpen, setAddModelOpen] = useState(false);
  const [credentialProvider, setCredentialProvider] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [providerName, setProviderName] = useState("");
  const [providerBase, setProviderBase] = useState("");
  const [providerLayer, setProviderLayer] = useState("");
  const [modelName, setModelName] = useState("");
  const [modelAlias, setModelAlias] = useState("");
  const [modelProvider, setModelProvider] = useState("");
  const [mcpName, setMcpName] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [mcpFilter, setMcpFilter] = useState("");
  const [skillFilter, setSkillFilter] = useState("");
  const [pluginFilter, setPluginFilter] = useState("");
  const [skillUpdates, setSkillUpdates] = useState<AnyRecord>({});
  const [stdioOpen, setStdioOpen] = useState(false);
  const [stdioEditingName, setStdioEditingName] = useState<string | null>(null);
  const [mcpSnapshot, setMcpSnapshot] = useState<McpLayerSnapshot | null>(null);
  const [pendingStdioRemove, setPendingStdioRemove] = useState<string | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  const request = useCallback(
    async (method: string, params: Record<string, unknown> = {}) => {
      const bridge = window.vibe;
      if (!bridge) throw new Error("The Vibe desktop bridge is unavailable.");
      return bridge.request(method, params);
    },
    [],
  );

  const applyRuntime = useCallback(
    (response: unknown) => {
      if (!isRecord(response) || !isRecord(response.runtime)) return;
      onRuntime?.(response.runtime as Runtime);
      setMcp(isRecord(response.runtime.mcp) ? response.runtime.mcp : null);
    },
    [onRuntime],
  );

  const runAction = useCallback(
    async (label: string, action: () => Promise<unknown>, success?: string) => {
      if (!sessionId) {
        const message =
          "Select or open a Vibe session before managing resources.";
        setError(message);
        onError?.(message);
        return undefined;
      }
      setError("");
      setNotice("");
      setBusy(label);
      try {
        const result = await action();
        if (success) setNotice(success);
        return result;
      } catch (cause) {
        const message = getErrorMessage(cause);
        setError(message);
        onError?.(message);
        return undefined;
      } finally {
        setBusy("");
      }
    },
    [onError, sessionId],
  );

  const readMcp = useCallback(async () => {
    if (!sessionId) return;
    const response = await request("mcp_catalog/read", { sessionId });
    const next =
      isRecord(response) && isRecord(response.mcp) ? response.mcp : response;
    if (isRecord(next))
      setMcp({
        ...next,
        discovery_errors: next.discoveryErrors ?? next.discovery_errors,
        connector_error: next.connectorError ?? next.connector_error,
      });
  }, [request, sessionId]);

  const readSkills = useCallback(async () => {
    if (!sessionId) return;
    const response = await request("skills/installed", { sessionId });
    setSkills(listFrom(response, "skills"));
  }, [request, sessionId]);

  const readPlugins = useCallback(async () => {
    if (!sessionId) return;
    const [catalogResult, infoResult] = await Promise.all([
      request("plugin_catalog/read", { sessionId }),
      request("plugin/info", { sessionId }),
    ]);
    const pluginState =
      isRecord(catalogResult) && isRecord(catalogResult.plugins)
        ? catalogResult.plugins
        : catalogResult;
    setPlugins(listFrom(pluginState, "plugins"));
    setDroppedPlugins(listFrom(pluginState, "dropped"));
    setPluginInfo(cleanPluginInfo(infoResult));
  }, [request, sessionId]);

  const readProviderConfig = useCallback(async () => {
    if (!sessionId) return;
    const [effective, fields] = await Promise.all([
      request("config/effective/read", { sessionId }),
      request("config/fields/read", { sessionId }),
    ]);
    setConfig(configFromEffective(effective));
    setConfigFields(cleanConfigFields(fields));
    // Redacted authoritative snapshot for the stdio editor + layer view.
    // Existing env values never enter renderer state; the main-process
    // mutation service owns the raw values and all writes.
    try {
      setMcpSnapshot(await describeMcpLayer(sessionId));
    } catch {
      setMcpSnapshot(null);
    }
  }, [request, sessionId]);

  const readSkillUpdates = useCallback(async () => {
    if (!sessionId) return;
    try {
      const response = await request("skills/updates", { sessionId });
      if (isRecord(response) && isRecord(response.updates)) setSkillUpdates(response.updates as AnyRecord);
      else if (isRecord(response)) setSkillUpdates(response);
    } catch {
      // Updates are advisory; a missing registry response is not fatal.
    }
  }, [request, sessionId]);

  const readDiagnostics = useCallback(async () => {
    if (!sessionId) return;
    // Unified 2.26.1 exposes these projections on runtime/read; the separate
    // stats/read and diagnostics/list procedures are legacy-only.
    const response = await request("runtime/read", { sessionId });
    const current =
      isRecord(response) && isRecord(response.runtime)
        ? response.runtime
        : null;
    setStats(
      current
        ? { ...current.stats, contextWindow: current.contextWindow }
        : null,
    );
    setDiagnostics(
      current
        ? { issues: current.issues, hooksCount: current.hooksCount }
        : null,
    );
  }, [request, sessionId]);

  const readAll = useCallback(async () => {
    if (!sessionId) return;
    setError("");
    setNotice("");
    setBusy("load");
    const tasks = [
      { name: "MCP", read: readMcp },
      { name: "Skills", read: readSkills },
      { name: "Skill updates", read: readSkillUpdates },
      { name: "Plugins", read: readPlugins },
      { name: "Providers", read: readProviderConfig },
      { name: "Diagnostics", read: readDiagnostics },
    ];
    const results = await Promise.allSettled(tasks.map((task) => task.read()));
    const failures = results.flatMap((result, index) =>
      result.status === "rejected"
        ? [`${tasks[index].name}: ${getErrorMessage(result.reason)}`]
        : [],
    );
    setLoaded(true);
    setBusy("");
    if (failures.length) {
      setNotice(failures.join(" · "));
    }
  }, [
    readDiagnostics,
    readMcp,
    readPlugins,
    readProviderConfig,
    readSkills,
    readSkillUpdates,
    sessionId,
  ]);

  useEffect(() => {
    let live = true;
    setLoaded(false);
    setError("");
    setNotice("");
    setMcp(null);
    setSkills([]);
    setSkillCatalog(null);
    setSelectedSkill(null);
    setSkillDetail(null);
    setPlugins([]);
    setDroppedPlugins([]);
    setPluginInfo({ components: [] });
    setConfig({ providers: [], models: [] });
    setConfigFields({ targets: [], providerLayers: [] });
    setStats(null);
    setDiagnostics(null);
    setAccount(null);
    setAuthLinks([]);
    setSkillUpdates({});
    setMcpSnapshot(null);
    setStdioOpen(false);
    setStdioEditingName(null);
    setPendingStdioRemove(null);
    if (!sessionId)
      return () => {
        live = false;
      };
    void readAll().catch((cause) => {
      if (live) {
        const message = getErrorMessage(cause);
        setError(message);
        onError?.(message);
        setBusy("");
      }
    });
    return () => {
      live = false;
    };
  }, [sessionId, readAll, onError]);

  useEffect(() => {
    const off = window.vibe?.onEvent((event) => {
      if (
        !["mcp_catalog/authUrl", "connector_catalog/authUrl"].includes(
          event.method,
        )
      )
        return;
      if (event.params.sessionId && event.params.sessionId !== sessionId)
        return;
      if (
        !isRecord(event.params.authLink) ||
        typeof event.params.authLink.id !== "string"
      )
        return;
      setAuthLinks((previous) =>
        [
          ...previous.filter((entry) => entry.id !== event.params.authLink.id),
          event.params.authLink,
        ].slice(-6),
      );
    });
    return off;
  }, [sessionId]);

  const runtimeSources = useMemo(
    () => sourcesFrom(mcp || runtime?.mcp),
    [mcp, runtime?.mcp],
  );
  const visibleSources = useMemo(() => {
    const needle = mcpFilter.trim().toLocaleLowerCase();
    if (!needle) return runtimeSources;
    return runtimeSources.filter((source) =>
      [
        source.displayName,
        source.name,
        source.kind,
        source.transport,
        source.status,
        source.plugin_name,
        ...(Array.isArray(source.tools)
          ? source.tools.map((tool: AnyRecord) => tool.name)
          : []),
      ]
        .filter((value) => typeof value === "string")
        .some((value) => value.toLocaleLowerCase().includes(needle)),
    );
  }, [mcpFilter, runtimeSources]);
  const visibleSkills = useMemo(() => {
    const needle = skillFilter.trim().toLocaleLowerCase();
    return skills.filter(
      (skill) =>
        !needle ||
        [skill.name, skill.description, skill.source, skill.scope]
          .filter((value) => typeof value === "string")
          .some((value) => value.toLocaleLowerCase().includes(needle)),
    );
  }, [skillFilter, skills]);
  const visibleSkillCatalog = useMemo(() => {
    const needle = skillFilter.trim().toLocaleLowerCase();
    return (skillCatalog || []).filter(
      (skill) =>
        !needle ||
        [skill.name, skill.skill_id, skill.description]
          .filter((value) => typeof value === "string")
          .some((value) => value.toLocaleLowerCase().includes(needle)),
    );
  }, [skillCatalog, skillFilter]);
  const visiblePlugins = useMemo(() => {
    const needle = pluginFilter.trim().toLocaleLowerCase();
    return plugins.filter(
      (plugin) =>
        !needle ||
        [plugin.name, plugin.description, plugin.source_format, plugin.author]
          .filter((value) => typeof value === "string")
          .some((value) => value.toLocaleLowerCase().includes(needle)),
    );
  }, [pluginFilter, plugins]);

  const busyOrDisabled = disabled || !sessionId || Boolean(busy);
  const configuredModels = config.models as AnyRecord[];
  const writableProviderLayers = configFields.targets.flatMap((target) => {
    const layer = configFields.providerLayers.find(
      (entry) => entry.layer === target,
    );
    return layer ? [layer] : [];
  });
  const runtimeModels = Array.isArray(runtime?.config?.models)
    ? runtime.config.models
    : [];
  const selectableAliases = new Set(
    runtimeModels
      .map((model: AnyRecord) => model.alias)
      .filter((alias: unknown) => typeof alias === "string"),
  );
  const currentAlias = runtime?.config?.activeModel?.alias;
  const currentStats = stats || runtime?.stats || {};
  const sessionPrompt = valueAt(
    currentStats,
    "sessionPromptTokens",
    "session_prompt_tokens",
  );
  const sessionCompletion = valueAt(
    currentStats,
    "sessionCompletionTokens",
    "session_completion_tokens",
  );
  const cachedTokens = valueAt(
    currentStats,
    "sessionCachedTokens",
    "session_cached_tokens",
  );
  const contextTokens = valueAt(
    currentStats,
    "contextTokens",
    "context_tokens",
  );
  const modelCalls = valueAt(currentStats, "modelCalls", "model_calls");
  const contextWindow =
    runtime?.contextWindow ||
    finiteNumber(valueAt(currentStats, "contextWindow", "context_window"));
  const lastTurnDuration = valueAt(
    currentStats,
    "lastTurnDuration",
    "last_turn_duration",
  );
  const inputRate = finiteNumber(
    valueAt(currentStats, "inputPricePerMillion", "input_price_per_million"),
  );
  const outputRate = finiteNumber(
    valueAt(currentStats, "outputPricePerMillion", "output_price_per_million"),
  );
  const cachedRate = valueAt(
    currentStats,
    "cachedInputPricePerMillion",
    "cached_input_price_per_million",
  );
  const cachedRateNumber = finiteNumber(cachedRate);
  const cachedTokenCount = finiteNumber(cachedTokens);
  const promptTokenCount = finiteNumber(sessionPrompt);
  const completionTokenCount = finiteNumber(sessionCompletion);
  const billableCachedTokens = Math.min(
    Math.max(0, cachedTokenCount || 0),
    Math.max(0, promptTokenCount || 0),
  );
  const canEstimatePrice =
    inputRate !== undefined &&
    inputRate > 0 &&
    outputRate !== undefined &&
    outputRate > 0 &&
    (cachedTokenCount === undefined ||
      cachedTokenCount <= 0 ||
      cachedRate === null ||
      (cachedRateNumber !== undefined && cachedRateNumber > 0));
  const estimatedApiCost =
    canEstimatePrice &&
    promptTokenCount !== undefined &&
    completionTokenCount !== undefined
      ? ((Math.max(0, promptTokenCount) - billableCachedTokens) * inputRate! +
          billableCachedTokens * (cachedRateNumber ?? inputRate!) +
          Math.max(0, completionTokenCount) * outputRate!) /
        1_000_000
      : undefined;
  const currency = (value: number) =>
    new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 6,
    }).format(value);
  const issueList = Array.isArray(diagnostics?.issues)
    ? diagnostics!.issues.filter(isRecord)
    : runtime?.issues || [];
  const effectiveSources = isRecord(mcp)
    ? mcp
    : isRecord(runtime?.mcp)
      ? runtime!.mcp
      : {};

  const doRefresh = (label: string, action: () => Promise<unknown>) =>
    void runAction(label, action, "Resource state refreshed.");
  const refreshRuntimeAfterWrite = async () => {
    if (!sessionId) return;
    try {
      const result = await request("runtime/read", { sessionId });
      if (isRecord(result) && isRecord(result.runtime)) {
        onRuntime?.(result.runtime as Runtime);
        setMcp(isRecord(result.runtime.mcp) ? result.runtime.mcp : null);
      }
    } catch {
      // A successful config write remains saved even if the optional snapshot read fails.
    }
  };

  const openDashboard = async (kind: "vibe" | "usage" | "limits") => {
    const bridge = window.vibe as any;
    if (typeof bridge?.openQuotaDashboard !== "function") {
      setError(
        "Official quota dashboard access is not available in this desktop build.",
      );
      return;
    }
    try {
      await bridge.openQuotaDashboard(kind);
    } catch (cause) {
      const message = getErrorMessage(cause);
      setError(message);
      onError?.(message);
    }
  };

  const openAuth = async (link: AnyRecord) => {
    if (typeof link.id !== "string") return;
    try {
      await window.vibe?.openAuthLink(link.id);
      setAuthLinks((previous) =>
        previous.filter((entry) => entry.id !== link.id),
      );
      setNotice("The sign-in page was opened in the official browser window.");
    } catch (cause) {
      const message = getErrorMessage(cause);
      setError(message);
      onError?.(message);
    }
  };

  const saveMcpServer = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const url = mcpUrl.trim();
    if (!validMcpEndpoint(url)) {
      setError(
        "MCP endpoints must use HTTPS and cannot contain credentials, query parameters, or fragments.",
      );
      return;
    }
    const result = await runAction(
      "add-mcp",
      async () => {
        const response = await request("mcp_catalog/add", {
          sessionId,
          url,
          name: mcpName.trim() || undefined,
          scopes: [],
          transport: "streamable-http",
        });
        applyRuntime(response);
        await readMcp();
        return response;
      },
      "MCP server added.",
    );
    if (result !== undefined) {
      setMcpName("");
      setMcpUrl("");
      setAddMcpOpen(false);
    }
  };

  const toggleSource = async (source: AnyRecord) => {
    const isConnector = source.kind === "connector";
    const disabledNow = source.status === "disabled";
    await runAction(
      "toggle:" + source.name,
      async () => {
        const response = isConnector
          ? await request("connector_catalog/toggle", {
              sessionId,
              alias: source.name,
              disabled: !disabledNow,
            })
          : await request("mcp_catalog/toggle", {
              sessionId,
              name: source.name,
              source: "server",
              disabled: !disabledNow,
            });
        applyRuntime(response);
        await readMcp();
        if (!isConnector) {
          const confirmed = await request("mcp_catalog/read", { sessionId });
          const current = confirmed.mcp?.sources?.find(
            (item: AnyRecord) => item.name === source.name,
          );
          if ((current?.status === "disabled") !== !disabledNow) {
            // The upstream catalog toggle edits its default persistence layer.
            // A project declaration can shadow it; route the override through
            // the single MCP mutation service, which re-reads the owning
            // layer, writes only the disabled leaf and verifies the result.
            const sid = sessionId;
            if (!sid) throw new Error("Select or open a Vibe session before managing resources.");
            const snapshot = await describeMcpLayer(sid);
            setMcpSnapshot(snapshot);
            const outcome = await mutateMcpLayer(sid, {
              op: "enable",
              name: String(source.name),
              expectedRevision: snapshot.revision,
              disabled: !disabledNow,
            });
            reportMutationResult(outcome, "toggle");
            await request("mcp_catalog/refresh", { sessionId }).catch(() => undefined);
            await readMcp();
            const verified = await request("mcp_catalog/read", { sessionId });
            if (
              (verified.mcp?.sources?.find(
                (item: AnyRecord) => item.name === source.name,
              )?.status ===
                "disabled") !==
              !disabledNow
            )
              throw new Error(
                "Vibe has not applied this server state. Refresh the catalog to inspect it.",
              );
          }
        }
        return response;
      },
      (disabledNow ? "Enabled " : "Disabled ") +
        (source.display_name || source.name) +
        ".",
    );
  };

  const toggleTool = async (source: AnyRecord, tool: AnyRecord) => {
    const isConnector = source.kind === "connector";
    await runAction(
      "tool:" + source.name + ":" + tool.name,
      async () => {
        const response = isConnector
          ? await request("connector_catalog/toggle", {
              sessionId,
              alias: source.name,
              disabled: false,
              toolName: tool.name,
            })
          : await request("mcp_catalog/toggle", {
              sessionId,
              name: source.name,
              source: "server",
              disabled: false,
              toolName: tool.name,
            });
        applyRuntime(response);
        await readMcp();
        return response;
      },
      (tool.enabled ? "Disabled " : "Enabled ") + tool.name + ".",
    );
  };

  const deleteMcp = async () => {
    if (!confirmRemove?.name) return;
    const name = String(confirmRemove.name);
    const result = await runAction(
      "remove:" + name,
      async () => {
        const response = await request("mcp_catalog/remove", {
          sessionId,
          name,
        });
        applyRuntime(response);
        await readMcp();
        return response;
      },
      "MCP server removed.",
    );
    if (result !== undefined) setConfirmRemove(null);
  };

  const loginMcp = async (source: AnyRecord) => {
    if (source.kind === "connector") {
      await runAction(
        "connector-auth:" + source.name,
        async () => {
          const response = await request("connector_catalog/auth/request", {
            sessionId,
            alias: source.name,
          });
          return response;
        },
        "Sign-in requested. Open the sign-in link when Vibe provides it.",
      );
      return;
    }
    if (!sessionId) return;
    setError("");
    setNotice(
      "Vibe sign-in requested. Open the upstream sign-in link when it appears.",
    );
    void request("mcp_catalog/login", { sessionId, name: source.name })
      .then(async (response) => {
        applyRuntime(response);
        await readMcp();
        setNotice("MCP sign-in completed.");
      })
      .catch((cause) => {
        const message = getErrorMessage(cause);
        setError(message);
        onError?.(message);
      });
  };

  const logoutMcp = async (source: AnyRecord) => {
    await runAction(
      "logout:" + source.name,
      async () => {
        const response = await request("mcp_catalog/logout", {
          sessionId,
          name: source.name,
        });
        applyRuntime(response);
        await readMcp();
        return response;
      },
      "MCP sign-in removed.",
    );
  };

  const applyMutationResult = (result: McpMutationResult) => {
    setMcpSnapshot({
      servers: result.servers,
      revision: result.revision,
      targetLayer: result.targetLayer,
      targets: mcpSnapshot?.targets ?? [],
    });
  };

  const reportMutationResult = (result: McpMutationResult, verb: string) => {
    applyMutationResult(result);
    if (result.outcome === "applied-verified" || result.outcome === "pending-reload") {
      setNotice(result.message);
      void readMcp();
    } else {
      setError(result.message);
      onError?.(result.message);
    }
    return result;
  };

  const removeStdioServer = async (name: string) => {
    if (!name || !sessionId) return;
    setError("");
    setNotice("");
    setBusy("remove-stdio:" + name);
    try {
      const result = await mutateMcpLayer(sessionId, {
        op: "remove",
        name,
        expectedRevision: mcpSnapshot?.revision ?? null,
      });
      reportMutationResult(result, "remove");
      setPendingStdioRemove(null);
    } catch (cause) {
      const message = getErrorMessage(cause);
      setError(message);
      onError?.(message);
    } finally {
      setBusy("");
    }
  };

  const refreshSkillsAndUpdates = async () => {
    await readSkills();
    await readSkillUpdates();
  };

  const toggleSkill = async (skill: AnyRecord) => {
    const enabled = skill.enabled === false;
    await runAction(
      "skill:" + skill.name,
      async () => {
        const response = await request("skills/setEnabled", {
          sessionId,
          name: skill.name,
          enabled,
        });
        applyRuntime(response);
        await readSkills();
        return response;
      },
      (enabled ? "Enabled " : "Disabled ") + skill.name + ".",
    );
  };

  const loadSkillCatalog = async () => {
    const result = await runAction(
      "skill-catalog",
      async () => {
        const response = await request("skills/catalog", { sessionId });
        setSkillCatalog(listFrom(response, "skills"));
        setCatalogMeta({
          loaded: response?.loaded,
          authenticated: response?.authenticated,
          projectAvailable:
            response?.projectAvailable ?? response?.project_available,
          updates: isRecord(response?.updates) ? response.updates : {},
        });
        return response;
      },
      "Registry catalog loaded.",
    );
    return result;
  };

  const showSkillDetail = async (skill: AnyRecord) => {
    setSelectedSkill(skill);
    setSkillDetail(null);
    if (!skill.skill_id) return;
    await runAction("skill-detail:" + skill.skill_id, async () => {
      const response = await request("skills/detail", {
        sessionId,
        skillId: skill.skill_id,
        version: finiteNumber(skill.latest_version) || undefined,
      });
      setSkillDetail(isRecord(response) ? response : null);
      return response;
    });
  };

  const reloadPlugins = async () => {
    await runAction(
      "plugin-reload",
      async () => {
        await request("plugin/reload", { sessionId });
        const [catalogResponse, infoResponse, runtimeResponse] =
          await Promise.all([
            request("plugin_catalog/read", { sessionId }),
            request("plugin/info", { sessionId }),
            request("runtime/read", { sessionId }),
          ]);
        const state =
          isRecord(catalogResponse) && isRecord(catalogResponse.plugins)
            ? catalogResponse.plugins
            : catalogResponse;
        setPlugins(listFrom(state, "plugins"));
        setDroppedPlugins(listFrom(state, "dropped"));
        setPluginInfo(cleanPluginInfo(infoResponse));
        applyRuntime(runtimeResponse);
        return catalogResponse;
      },
      "Plugin discovery reloaded.",
    );
  };

  const saveProvider = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = providerName.trim();
    const base = providerBase.trim();
    if (!name || !validApiBase(base) || !providerLayer) {
      setError(
        "Enter a provider name, a safe HTTPS API base (or loopback HTTP) without credentials or query parameters, and a writable Vibe config layer.",
      );
      return;
    }
    if (
      config.providers.some(
        (provider: AnyRecord) =>
          provider.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
      )
    ) {
      setError("A provider with that name is already configured.");
      return;
    }
    const result = await runAction(
      "provider-add",
      async () => {
        const response = await request("config/write", {
          sessionId,
          ops: [
            {
              op: "set",
              path: "/providers/-",
              value: { name, api_base: base },
              targetLayer: providerLayer,
            },
          ],
          reason: "Add provider from Resources workspace",
          reloadRuntime: true,
        });
        if (apiKey.trim()) {
          try {
            const credential = await request("setup/store-credential", {
              provider: name,
              apiKey,
            });
            if (!isRecord(credential) || credential.outcome !== "completed") {
              const reason =
                isRecord(credential) && credential.outcome === "env_var_error"
                  ? "Vibe could not derive a valid environment-variable name for this provider."
                  : "Vibe could not persist the credential to its secure credential store.";
              throw new Error(reason);
            }
          } catch (cause) {
            throw new Error(
              "Provider configuration was saved, but secure credential storage failed: " +
                getErrorMessage(cause),
            );
          }
        }
        await readProviderConfig();
        await refreshRuntimeAfterWrite();
        return response;
      },
      apiKey.trim()
        ? "Provider and credential saved to Vibe."
        : "Provider saved to Vibe.",
    );
    setApiKey("");
    if (result !== undefined) {
      if (isRecord(result) && result.status === "pending") {
        setNotice(
          "Provider configuration is saved and will apply after the active turn completes.",
        );
      }
      setAddProviderOpen(false);
      setProviderName("");
      setProviderBase("");
      setShowKey(false);
    }
  };

  const saveModel = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = modelName.trim();
    const alias = modelAlias.trim();
    const provider = modelProvider.trim();
    if (!name || !alias || !provider) {
      setError(
        "Enter the API model ID, a unique Vibe alias, and a configured provider.",
      );
      return;
    }
    if (
      configuredModels.some(
        (model) =>
          model.alias.toLocaleLowerCase() === alias.toLocaleLowerCase(),
      )
    ) {
      setError("That model alias is already configured.");
      return;
    }
    const pointer = alias.replace(/~/g, "~0").replace(/\//g, "~1");
    const result = await runAction(
      "model-add",
      async () => {
        const response = await request("config/write", {
          sessionId,
          ops: [
            {
              op: "set",
              path: "/models/" + pointer,
              value: { name, provider, alias },
              targetLayer: configFields.targets[0],
            },
          ],
          reason: "Add model from Resources workspace",
          reloadRuntime: true,
        });
        await readProviderConfig();
        await refreshRuntimeAfterWrite();
        return response;
      },
      "Model saved to Vibe. It will appear as selectable only if the runtime exposes it.",
    );
    if (result !== undefined) {
      if (isRecord(result) && result.status === "pending") {
        setNotice(
          "Model configuration is saved and will apply after the active turn completes.",
        );
      }
      setAddModelOpen(false);
      setModelName("");
      setModelAlias("");
    }
  };

  const updateProviderBase = async (
    provider: AnyRecord,
    layer: string,
    index: number,
    value: string,
  ) => {
    if (!validApiBase(value)) {
      setError(
        "API base must use HTTPS, except HTTP is allowed for loopback services; credentials and query parameters are not accepted.",
      );
      return;
    }
    const result = await runAction(
      "provider-edit:" + provider.name,
      async () => {
        const response = await request("config/write", {
          sessionId,
          ops: [
            {
              op: "set",
              path: "/providers/" + index + "/api_base",
              value: value.trim(),
              targetLayer: layer,
            },
          ],
          reason: "Update provider API base",
          reloadRuntime: true,
        });
        await readProviderConfig();
        await refreshRuntimeAfterWrite();
        return response;
      },
      "Provider API base updated.",
    );
    if (isRecord(result) && result.status === "pending") {
      setNotice(
        "Provider API base is saved and will apply after the active turn completes.",
      );
    }
  };

  const loadAccount = async () => {
    await runAction(
      "account-read",
      async () => {
        const response = await request("account/read", { sessionId });
        setAccount(
          isRecord(response)
            ? isRecord(response.account)
              ? response.account
              : response
            : null,
        );
        return response;
      },
      "Account status checked.",
    );
  };

  const refreshCatalogs = async () => {
    if (!sessionId) return;
    await request("mcp_catalog/refresh", { sessionId });
    const connectorResult = await request("connector_catalog/refresh", {
      sessionId,
    });
    applyRuntime(connectorResult);
    await readMcp();
  };

  const pickProviderLayer = (providerNameValue: string) => {
    for (const layer of writableProviderLayers) {
      const index = layer.providers.findIndex(
        (provider) => provider.name === providerNameValue,
      );
      if (index >= 0) return { layer: layer.layer, index };
    }
    return undefined;
  };

  const openDialog = (setter: (open: boolean) => void) => {
    previousFocus.current = document.activeElement as HTMLElement | null;
    setter(true);
  };
  const closeDialog = (setter: (open: boolean) => void) => {
    setter(false);
    const restore = previousFocus.current;
    window.requestAnimationFrame(() => {
      if (restore?.isConnected) restore.focus();
    });
  };
  const dialogKeyDown = (
    event: React.KeyboardEvent<HTMLElement>,
    close: () => void,
  ) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const dialog = event.currentTarget;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex="0"]',
      ),
    ).filter((element) => element.getClientRects().length > 0);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) {
      event.preventDefault();
      dialog.focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const refreshAll = () => void readAll();

  return (
    <section
      className="resources-workspace"
      aria-label="Vibe resources and configuration"
    >
      <header className="rw-header">
        <div>
          <p className="rw-eyebrow">Vibe session</p>
          <h1>Resources</h1>
          <p>
            Manage the integrations and configuration exposed by this running
            Vibe session.
          </p>
        </div>
        <button
          className="rw-button rw-secondary"
          type="button"
          onClick={refreshAll}
          disabled={!sessionId || !!busy}
        >
          {busy === "load" ? (
            <LoaderCircle size={14} className="rw-spin" />
          ) : (
            <RefreshCw size={14} />
          )}
          Refresh view
        </button>
      </header>

      <div className="rw-tabs" role="tablist" aria-label="Resource sections">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={"rw-tab-" + id}
            aria-controls="rw-panel"
            aria-selected={tab === id}
            tabIndex={tab === id ? 0 : -1}
            className={tab === id ? "rw-tab is-active" : "rw-tab"}
            onClick={() => {
              setTab(id);
              setError("");
              setNotice("");
            }}
            onKeyDown={(event) => {
              if (
                !["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)
              )
                return;
              event.preventDefault();
              const current = TABS.findIndex((entry) => entry.id === tab);
              const index =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? TABS.length - 1
                    : (current +
                        (event.key === "ArrowRight" ? 1 : TABS.length - 1)) %
                      TABS.length;
              setTab(TABS[index].id);
              document.getElementById("rw-tab-" + TABS[index].id)?.focus();
            }}
          >
            <Icon size={14} aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>

      {(error || notice) && (
        <div
          className={error ? "rw-message is-error" : "rw-message"}
          role={error ? "alert" : "status"}
        >
          {error ? (
            <AlertTriangle size={14} aria-hidden="true" />
          ) : (
            <Check size={14} aria-hidden="true" />
          )}
          <span>{error || notice}</span>
          {error && (
            <button
              type="button"
              aria-label="Dismiss error"
              onClick={() => setError("")}
            >
              <X size={14} />
            </button>
          )}
        </div>
      )}

      {!sessionId ? (
        <EmptyState
          title="Open a Vibe session"
          detail="Resource configuration is scoped to an active Vibe session. Open or select a session to read its real runtime state."
        />
      ) : !loaded && busy === "load" ? (
        <div className="rw-loading" role="status">
          <LoaderCircle className="rw-spin" size={18} />
          Reading the active Vibe session…
        </div>
      ) : (
        <>
          {authLinks.length > 0 && (
            <section className="rw-auth-links" aria-label="Pending MCP sign-in">
              <div className="rw-auth-icon">
                <LockKeyhole size={15} />
              </div>
              <div className="rw-auth-copy">
                <strong>Sign-in required</strong>
                <span>
                  Vibe requested authorization from an MCP provider. Open the
                  upstream sign-in link when you are ready.
                </span>
              </div>
              <div className="rw-auth-actions">
                {authLinks.map((link) => (
                  <button
                    key={link.id}
                    type="button"
                    className="rw-button rw-secondary"
                    onClick={() => void openAuth(link)}
                    disabled={busyOrDisabled}
                  >
                    <ExternalLink size={13} /> Open {link.name || "sign-in"}
                  </button>
                ))}
              </div>
            </section>
          )}

          <div
            id="rw-panel"
            role="tabpanel"
            aria-labelledby={"rw-tab-" + tab}
            className="rw-panel"
          >
            {tab === "mcp" && (
              <section className="rw-section">
                <div className="rw-section-heading">
                  <div>
                    <h2>MCP servers & connectors</h2>
                    <p>Live sources and tools reported by this session.</p>
                  </div>
                  <div className="rw-actions">
                    <button
                      type="button"
                      className="rw-button rw-secondary"
                      onClick={() => doRefresh("mcp-refresh", refreshCatalogs)}
                      disabled={busyOrDisabled}
                    >
                      {busy === "mcp-refresh" ? (
                        <LoaderCircle className="rw-spin" size={14} />
                      ) : (
                        <RefreshCw size={14} />
                      )}{" "}
                      Refresh catalog
                    </button>
                    <button
                      type="button"
                      className="rw-button rw-primary"
                      onClick={() => openDialog(setAddMcpOpen)}
                      disabled={busyOrDisabled}
                    >
                      <Plus size={14} /> Add HTTP server
                    </button>
                    <button
                      type="button"
                      className="rw-button rw-secondary"
                      onClick={() => {
                        setStdioEditingName(null);
                        openDialog(setStdioOpen);
                      }}
                      disabled={busyOrDisabled}
                    >
                      <Plus size={14} /> Add stdio server
                    </button>
                  </div>
                </div>
                <label className="rw-search">
                  <Search size={14} aria-hidden="true" />
                  <input
                    type="search"
                    aria-label="Search MCP sources and tools"
                    placeholder="Search sources or tools"
                    value={mcpFilter}
                    onChange={(event) => setMcpFilter(event.target.value)}
                  />
                </label>
                {Object.keys(
                  isRecord(effectiveSources.discovery_errors)
                    ? effectiveSources.discovery_errors
                    : {},
                ).length > 0 && (
                  <div className="rw-inline-warning">
                    <AlertTriangle size={14} />
                    <div>
                      <strong>Discovery reported issues</strong>
                      {Object.entries(effectiveSources.discovery_errors).map(
                        ([name, message]) => (
                          <p key={name}>
                            <b>{name}</b>: {safeError(message)}
                          </p>
                        ),
                      )}
                    </div>
                  </div>
                )}
                {effectiveSources.connector_error && (
                  <div className="rw-inline-warning">
                    <AlertTriangle size={14} />
                    <span>{safeError(effectiveSources.connector_error)}</span>
                  </div>
                )}
                {visibleSources.length ? (
                  <div className="rw-card-list">
                    {visibleSources.map((source, sourceIndex) => {
                      const connector = source.kind === "connector";
                      const sourceBusy = busy === "toggle:" + source.name;
                      const canManage = !source.plugin_name;
                      const usesOAuth =
                        Array.isArray(config.mcp_servers) &&
                        config.mcp_servers.some(
                          (server: AnyRecord) =>
                            server.name === source.name &&
                            server.auth?.type === "oauth",
                        );
                      const status = String(
                        source.status || "unknown",
                      ).toLowerCase();
                      return (
                        <article
                          className="rw-card rw-mcp-card"
                          key={source.name || sourceIndex}
                        >
                          <div className="rw-card-heading">
                            <span className="rw-kind-icon">
                              {connector ? (
                                <Plug size={15} />
                              ) : (
                                <Server size={15} />
                              )}
                            </span>
                            <div className="rw-card-title">
                              <strong>
                                {source.display_name ||
                                  source.name ||
                                  "Unnamed source"}
                              </strong>
                              <small>
                                {source.name} ·{" "}
                                {titleCase(source.transport || source.kind)}
                              </small>
                            </div>
                            <span className={"rw-status rw-status-" + status}>
                              {titleCase(status)}
                            </span>
                          </div>
                          {source.plugin_name && (
                            <p className="rw-note">
                              Managed by plugin {source.plugin_name}. Use
                              Plugins to inspect or reload it.
                            </p>
                          )}
                          {source.error && (
                            <p className="rw-error-text">
                              {safeError(source.error)}
                            </p>
                          )}
                          <div className="rw-tool-list">
                            {Array.isArray(source.tools) &&
                            source.tools.length > 0 ? (
                              source.tools.map((tool: AnyRecord) => (
                                <div className="rw-tool-row" key={tool.name}>
                                  <span>
                                    <Wrench size={12} aria-hidden="true" />
                                    <span>
                                      <strong>{tool.name}</strong>
                                      {tool.description && (
                                        <small>{tool.description}</small>
                                      )}
                                    </span>
                                  </span>
                                  <button
                                    type="button"
                                    className={
                                      tool.enabled === false
                                        ? "rw-switch is-off"
                                        : "rw-switch"
                                    }
                                    role="switch"
                                    aria-checked={tool.enabled !== false}
                                    aria-label={
                                      (tool.enabled === false
                                        ? "Enable "
                                        : "Disable ") + tool.name
                                    }
                                    disabled={busyOrDisabled || !canManage}
                                    onClick={() =>
                                      void toggleTool(source, tool)
                                    }
                                  >
                                    <i />
                                  </button>
                                </div>
                              ))
                            ) : (
                              <p className="rw-note">
                                No tools are currently reported for this source.
                              </p>
                            )}
                          </div>
                          <footer className="rw-card-footer">
                            {connector ? (
                              <>
                                <button
                                  className="rw-button rw-secondary"
                                  type="button"
                                  disabled={busyOrDisabled || !canManage}
                                  onClick={() => void toggleSource(source)}
                                >
                                  {sourceBusy ? (
                                    <LoaderCircle
                                      size={13}
                                      className="rw-spin"
                                    />
                                  ) : null}
                                  {status === "disabled"
                                    ? "Enable connector"
                                    : "Disable connector"}
                                </button>
                                {["needs_auth", "needs_setup"].includes(
                                  status,
                                ) && (
                                  <button
                                    className="rw-button rw-secondary"
                                    type="button"
                                    disabled={busyOrDisabled}
                                    onClick={() => void loginMcp(source)}
                                  >
                                    Sign in
                                  </button>
                                )}
                              </>
                            ) : (
                              <>
                                <button
                                  className="rw-button rw-secondary"
                                  type="button"
                                  disabled={busyOrDisabled || !canManage}
                                  onClick={() => void toggleSource(source)}
                                >
                                  {sourceBusy ? (
                                    <LoaderCircle
                                      size={13}
                                      className="rw-spin"
                                    />
                                  ) : null}
                                  {status === "disabled"
                                    ? "Enable server"
                                    : "Disable server"}
                                </button>
                                {status === "needs_auth" ? (
                                  <button
                                    className="rw-button rw-secondary"
                                    type="button"
                                    disabled={busyOrDisabled}
                                    onClick={() => void loginMcp(source)}
                                  >
                                    Sign in
                                  </button>
                                ) : usesOAuth &&
                                  ["connected", "enabled"].includes(status) ? (
                                  <button
                                    className="rw-text-button"
                                    type="button"
                                    disabled={busyOrDisabled}
                                    onClick={() => void logoutMcp(source)}
                                  >
                                    Sign out
                                  </button>
                                ) : null}
                                <button
                                  className="rw-icon-button rw-danger"
                                  type="button"
                                  aria-label={
                                    "Remove " +
                                    (source.display_name || source.name)
                                  }
                                  title="Remove server"
                                  disabled={busyOrDisabled || !canManage}
                                  onClick={() => setConfirmRemove(source)}
                                >
                                  <Trash2 size={14} />
                                </button>
                              </>
                            )}
                          </footer>
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <EmptyState
                    title={
                      runtimeSources.length
                        ? "No matching sources"
                        : "No MCP sources reported"
                    }
                    detail={
                      runtimeSources.length
                        ? "Try a different search."
                        : "Add an HTTPS streamable HTTP server or configure a server through Vibe."
                    }
                  />
                )}
                <div className="rw-caption">
                  Catalog reads show the session’s cached/current state. The
                  catalog is refreshed only when you choose “Refresh catalog.”
                  Configured means declared; Enabled means allowed; Connected means verified;
                  Usable means tools are actually announced — these states are not the same.
                </div>
                <LayerInspector
                  targets={mcpSnapshot?.targets ?? configFields.targets}
                  fields={[
                    {
                      name: "mcp_servers",
                      layerValues:
                        mcpSnapshot && mcpSnapshot.targetLayer
                          ? [{ layer: mcpSnapshot.targetLayer, value: mcpSnapshot.servers }]
                          : [],
                    },
                  ]}
                />
                {(mcpSnapshot?.servers ?? []).filter(
                  (server) => server.transport === "stdio" || server.command,
                ).length > 0 && (
                  <section className="rw-stdio-list" aria-label="Local stdio servers">
                    <h3 className="rw-subheading">
                      Local stdio servers{" "}
                      <span>
                        {
                          (mcpSnapshot?.servers ?? []).filter(
                            (server) => server.transport === "stdio" || server.command,
                          ).length
                        }
                      </span>
                    </h3>
                    <p className="rw-note">
                      Managed through the official config/mcp_servers layer ({mcpSnapshot?.targetLayer || "unknown"}).
                      Editing never executes the command — validation is syntactic; connection follows on refresh.
                      Only changed fields are written; everything else is preserved and verified.
                    </p>
                    <div className="rw-card-list">
                      {(mcpSnapshot?.servers ?? [])
                        .filter((server) => server.transport === "stdio" || server.command)
                        .map((server) => (
                          <article className="rw-card" key={String(server.name)}>
                            <div className="rw-card-heading">
                              <strong>{String(server.name)}</strong>
                              <span className={"rw-status rw-status-" + (server.disabled ? "disabled" : "connected")}>
                                {server.disabled ? "Disabled" : "Enabled"}
                              </span>
                            </div>
                            <small className="rw-note">
                              {typeof server.command === "string" ? server.command : ""}{" "}
                              {Array.isArray(server.args) ? server.args.join(" ") : ""}
                              {typeof server.cwd === "string" ? ` · cwd ${server.cwd}` : ""}
                              {server.envConfigured ? ` · ${server.envKeys.length} env var(s) configured` : ""}
                            </small>
                            <footer className="rw-card-footer">
                              <button
                                type="button"
                                className="rw-button rw-secondary rw-small"
                                disabled={busyOrDisabled}
                                onClick={() => {
                                  setStdioEditingName(String(server.name));
                                  openDialog(setStdioOpen);
                                }}
                              >
                                Edit stdio server
                              </button>
                              {pendingStdioRemove === String(server.name) ? (
                                <>
                                  <button
                                    type="button"
                                    className="rw-button rw-danger rw-small"
                                    disabled={busyOrDisabled}
                                    onClick={() => void removeStdioServer(String(server.name))}
                                  >
                                    Confirm remove
                                  </button>
                                  <button
                                    type="button"
                                    className="rw-button rw-secondary rw-small"
                                    disabled={busyOrDisabled}
                                    onClick={() => setPendingStdioRemove(null)}
                                  >
                                    Keep
                                  </button>
                                </>
                              ) : (
                                <button
                                  type="button"
                                  className="rw-button rw-secondary rw-small"
                                  disabled={busyOrDisabled}
                                  onClick={() => setPendingStdioRemove(String(server.name))}
                                >
                                  Remove stdio server
                                </button>
                              )}
                            </footer>
                          </article>
                        ))}
                    </div>
                  </section>
                )}
              </section>
            )}

            {tab === "skills" && (
              <section className="rw-section">
                <div className="rw-section-heading">
                  <div>
                    <h2>Skills</h2>
                    <p>Installed skills and the upstream registry catalog.</p>
                  </div>
                  <div className="rw-actions">
                    <button
                      type="button"
                      className="rw-button rw-secondary"
                      onClick={() => doRefresh("skills-refresh", readSkills)}
                      disabled={busyOrDisabled}
                    >
                      <RefreshCw size={14} /> Reload installed
                    </button>
                    <button
                      type="button"
                      className="rw-button rw-secondary"
                      onClick={() => void loadSkillCatalog()}
                      disabled={busyOrDisabled}
                    >
                      <Search size={14} />{" "}
                      {skillCatalog ? "Reload registry" : "Browse registry"}
                    </button>
                  </div>
                </div>
                <label className="rw-search">
                  <Search size={14} aria-hidden="true" />
                  <input
                    type="search"
                    aria-label="Search skills"
                    placeholder="Search installed and registry skills"
                    value={skillFilter}
                    onChange={(event) => setSkillFilter(event.target.value)}
                  />
                </label>
                <h3 className="rw-subheading">
                  Installed in this session <span>{visibleSkills.length}</span>
                </h3>
                {visibleSkills.length ? (
                  <div className="rw-card-list">
                    {visibleSkills.map((skill) => {
                      const locked =
                        skill.locked === true ||
                        skill.source === "builtin" ||
                        skill.scope === "builtin";
                      return (
                        <article
                          className="rw-card rw-skill-card"
                          key={skill.name}
                        >
                          <div className="rw-card-heading">
                            <span className="rw-kind-icon">
                              <Wrench size={15} />
                            </span>
                            <div className="rw-card-title">
                              <strong>{skill.name}</strong>
                              <small>
                                {titleCase(skill.source)} ·{" "}
                                {titleCase(skill.scope)}
                                {skill.registry?.version
                                  ? " · v" + skill.registry.version
                                  : ""}
                              </small>
                            </div>
                            {locked && (
                              <span className="rw-locked">
                                <LockKeyhole size={11} /> Built-in
                              </span>
                            )}
                            <button
                              type="button"
                              className={
                                skill.enabled === false
                                  ? "rw-switch is-off"
                                  : "rw-switch"
                              }
                              role="switch"
                              aria-checked={skill.enabled !== false}
                              aria-label={
                                (skill.enabled === false
                                  ? "Enable "
                                  : "Disable ") + skill.name
                              }
                              disabled={busyOrDisabled || locked}
                              onClick={() => void toggleSkill(skill)}
                            >
                              <i />
                            </button>
                          </div>
                          {skill.description && <p>{skill.description}</p>}
                          {skill.prompt && (
                            <details className="rw-disclosure">
                              <summary>View installed instructions</summary>
                              <pre>{skill.prompt}</pre>
                            </details>
                          )}
                          <footer className="rw-card-footer">
                            {skillUpdates?.[skill.name] !== undefined && (
                              <span className="rw-status rw-status-needs_auth">
                                Update available
                              </span>
                            )}
                            {!locked && (
                              <SkillLifecycle
                                sessionId={sessionId}
                                installedName={String(skill.name)}
                                currentAlias={
                                  typeof skill.alias === "string" ? skill.alias : undefined
                                }
                                request={request}
                                refresh={refreshSkillsAndUpdates}
                                onDone={(message) => setNotice(message)}
                                onError={(message) => {
                                  setError(message);
                                  onError?.(message);
                                }}
                              />
                            )}
                          </footer>
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <EmptyState
                    title={
                      skills.length
                        ? "No matching skills"
                        : "No skills are installed"
                    }
                    detail={
                      skills.length
                        ? "Try a different search."
                        : "Skills added to Vibe will appear here."
                    }
                  />
                )}

                {skillCatalog && (
                  <div className="rw-registry">
                    <div className="rw-subheading-row">
                      <h3 className="rw-subheading">
                        Registry catalog{" "}
                        <span>{visibleSkillCatalog.length}</span>
                      </h3>
                      <small>
                        {catalogMeta.authenticated === true
                          ? "Signed in"
                          : catalogMeta.authenticated === false
                            ? "Public catalog"
                            : ""}
                      </small>
                    </div>
                    {visibleSkillCatalog.length ? (
                      <div className="rw-catalog-list">
                        {visibleSkillCatalog.map((skill) => (
                          <button
                            key={skill.skill_id}
                            type="button"
                            className={
                              selectedSkill?.skill_id === skill.skill_id
                                ? "rw-catalog-item is-selected"
                                : "rw-catalog-item"
                            }
                            onClick={() => void showSkillDetail(skill)}
                          >
                            <span>
                              <strong>{skill.name}</strong>
                              <small>{skill.description}</small>
                            </span>
                            <span className="rw-catalog-meta">
                              v{skill.latest_version || "—"}
                              <ChevronDown size={13} />
                            </span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="rw-note">
                        No registry skills match this search.
                      </p>
                    )}
                    {selectedSkill && (
                      <section className="rw-detail" aria-live="polite">
                        <header>
                          <div>
                            <p className="rw-eyebrow">Registry detail</p>
                            <h3>
                              {skillDetail?.detail?.name || selectedSkill.name}
                            </h3>
                          </div>
                          <button
                            type="button"
                            className="rw-icon-button"
                            aria-label="Close skill details"
                            onClick={() => {
                              setSelectedSkill(null);
                              setSkillDetail(null);
                            }}
                          >
                            <X size={14} />
                          </button>
                        </header>
                        <p>
                          {skillDetail?.detail?.description ||
                            selectedSkill.description}
                        </p>
                        <small>
                          Version{" "}
                          {skillDetail?.detail?.version ||
                            selectedSkill.latest_version ||
                            "Not reported"}{" "}
                          ·{" "}
                          {skillDetail?.detail?.sharing_scope ||
                            selectedSkill.sharing_scope ||
                            "Sharing scope not reported"}
                        </small>
                        {skillDetail?.body && (
                          <pre className="rw-detail-body">
                            {skillDetail.body}
                          </pre>
                        )}
                        {!skillDetail?.detail && !skillDetail?.body && (
                          <p className="rw-note">
                            Vibe returned no further detail for this entry. Local and plugin
                            skills expose their instructions from the installed list above.
                          </p>
                        )}
                        {selectedSkill.skill_id && (
                          <SkillImport
                            sessionId={sessionId}
                            skillId={String(selectedSkill.skill_id)}
                            request={request}
                            refresh={refreshSkillsAndUpdates}
                            onDone={(message) => setNotice(message)}
                            onError={(message) => {
                              setError(message);
                              onError?.(message);
                            }}
                          />
                        )}
                        <p className="rw-note">
                          Importing never executes skill commands. Removal and updates
                          happen from the installed list with explicit confirmation.
                        </p>
                      </section>
                    )}
                  </div>
                )}
              </section>
            )}

            {tab === "plugins" && (
              <section className="rw-section">
                <div className="rw-section-heading">
                  <div>
                    <h2>Plugins</h2>
                    <p>Plugins discovered by the active Vibe session.</p>
                  </div>
                  <button
                    type="button"
                    className="rw-button rw-secondary"
                    onClick={() => void reloadPlugins()}
                    disabled={busyOrDisabled}
                  >
                    {busy === "plugin-reload" ? (
                      <LoaderCircle size={14} className="rw-spin" />
                    ) : (
                      <RefreshCw size={14} />
                    )}{" "}
                    Reload discovery
                  </button>
                </div>
                {visiblePlugins.length ? (
                  <div className="rw-card-list">
                    {visiblePlugins.map((plugin) => {
                      const components = Array.isArray(plugin.components)
                        ? plugin.components.filter(isRecord)
                        : [];
                      const counts = components.reduce(
                        (
                          result: Record<string, number>,
                          component: AnyRecord,
                        ) => {
                          const key = String(component.kind || "unknown");
                          result[key] = (result[key] || 0) + 1;
                          return result;
                        },
                        {},
                      );
                      return (
                        <article className="rw-card" key={plugin.name}>
                          <div className="rw-card-heading">
                            <span className="rw-kind-icon">
                              <Layers size={15} />
                            </span>
                            <div className="rw-card-title">
                              <strong>{plugin.name}</strong>
                              <small>
                                {titleCase(plugin.scope)} ·{" "}
                                {titleCase(plugin.source_format)}
                                {plugin.version ? " · v" + plugin.version : ""}
                              </small>
                            </div>
                            {plugin.drifted ? (
                              <span className="rw-status rw-status-needs_auth">
                                Drifted
                              </span>
                            ) : (
                              <span className="rw-status rw-status-connected">
                                No drift detected
                              </span>
                            )}
                          </div>
                          {plugin.description && <p>{plugin.description}</p>}
                          <div className="rw-chip-row">
                            {Object.entries(counts).map(([kind, count]) => (
                              <span className="rw-chip" key={kind}>
                                {titleCase(kind)} · {count}
                              </span>
                            ))}
                          </div>
                          {plugin.manifest_digest && (
                            <small className="rw-digest">
                              Manifest{" "}
                              {String(plugin.manifest_digest).slice(0, 18)}…
                            </small>
                          )}
                          <p className="rw-note">
                            Install and removal are not exposed by the official
                            methods this desktop host enables.
                          </p>
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <EmptyState
                    title={
                      plugins.length
                        ? "No matching plugins"
                        : "No plugins discovered"
                    }
                    detail={
                      plugins.length
                        ? "Try a different search."
                        : "The active Vibe session did not report installed plugins."
                    }
                  />
                )}
                {plugins.length > 0 && (
                  <details className="rw-disclosure rw-plugin-info">
                    <summary>
                      Session plugin components{" "}
                      <span>{pluginInfo.components?.length || 0}</span>
                    </summary>
                    <p>
                      Names and kinds are shown from plugin/info. Component
                      configuration, source paths and raw plugin metadata are
                      intentionally omitted.
                    </p>
                    <div className="rw-chip-row">
                      {(pluginInfo.components || []).map(
                        (component: AnyRecord, index: number) => (
                          <span
                            className="rw-chip"
                            key={component.kind + component.name + index}
                          >
                            {titleCase(component.kind)} · {component.name}
                          </span>
                        ),
                      )}
                    </div>
                  </details>
                )}
                {droppedPlugins.length > 0 && (
                  <div className="rw-inline-warning">
                    <AlertTriangle size={14} />
                    <div>
                      <strong>Skipped plugin descriptors</strong>
                      {droppedPlugins.map((item, index) => (
                        <p key={index}>
                          {String(item.file || "Descriptor")}:{" "}
                          {safeError(item.message || "Not loaded")}
                        </p>
                      ))}
                    </div>
                  </div>
                )}
              </section>
            )}

            {tab === "providers" && (
              <section className="rw-section">
                <div className="rw-section-heading">
                  <div>
                    <h2>Providers & models</h2>
                    <p>
                      Configuration reported by Vibe, alongside models
                      selectable in this session.
                    </p>
                  </div>
                  <div className="rw-actions">
                    <button
                      type="button"
                      className="rw-button rw-secondary"
                      onClick={() =>
                        doRefresh("config-refresh", readProviderConfig)
                      }
                      disabled={busyOrDisabled}
                    >
                      <RefreshCw size={14} /> Reload config
                    </button>
                    <button
                      type="button"
                      className="rw-button rw-secondary"
                      onClick={() => {
                        setProviderLayer(
                          writableProviderLayers[0]?.layer || "",
                        );
                        openDialog(setAddProviderOpen);
                      }}
                      disabled={
                        busyOrDisabled || !writableProviderLayers.length
                      }
                    >
                      <Plus size={14} /> Add provider
                    </button>
                    <button
                      type="button"
                      className="rw-button rw-primary"
                      onClick={() => {
                        setModelProvider(config.providers[0]?.name || "");
                        openDialog(setAddModelOpen);
                      }}
                      disabled={
                        busyOrDisabled ||
                        !configFields.targets.length ||
                        !config.providers.length
                      }
                    >
                      <Plus size={14} /> Add model
                    </button>
                  </div>
                </div>
                {configFields.targets.length > 0 && (
                  <p className="rw-note">
                    Writable config layers are supplied by Vibe:{" "}
                    {configFields.targets.map((target) => (
                      <span className="rw-chip" key={target}>
                        {target}
                      </span>
                    ))}
                  </p>
                )}
                <h3 className="rw-subheading">
                  Configured providers <span>{config.providers.length}</span>
                </h3>
                {config.providers.length ? (
                  <div className="rw-card-list">
                    {config.providers.map((provider: AnyRecord) => {
                      const edit = pickProviderLayer(provider.name);
                      const setupStatus = undefined;
                      return (
                        <article className="rw-card" key={provider.name}>
                          <div className="rw-card-heading">
                            <span className="rw-kind-icon">
                              <Plug size={15} />
                            </span>
                            <div className="rw-card-title">
                              <strong>{provider.name}</strong>
                              <small>
                                {provider.backend
                                  ? titleCase(provider.backend)
                                  : "Provider"}
                                {provider.apiStyle
                                  ? " · " + titleCase(provider.apiStyle)
                                  : ""}
                              </small>
                            </div>
                            <span className="rw-status rw-status-configured">
                              Configured
                            </span>
                          </div>
                          <dl className="rw-facts">
                            <div>
                              <dt>API base</dt>
                              <dd>
                                {provider.apiBase ||
                                  "Hidden because this URL cannot be safely edited here"}
                              </dd>
                            </div>
                            <div>
                              <dt>Credential variable</dt>
                              <dd>
                                {provider.apiKeyEnvVar ||
                                  "Managed by Vibe or not configured"}
                              </dd>
                            </div>
                          </dl>
                          {edit && provider.apiBase && (
                            <form
                              className="rw-inline-form"
                              onSubmit={(event) => {
                                event.preventDefault();
                                const value = new FormData(
                                  event.currentTarget,
                                ).get("apiBase");
                                if (typeof value === "string")
                                  void updateProviderBase(
                                    provider,
                                    edit.layer,
                                    edit.index,
                                    value,
                                  );
                              }}
                            >
                              <label>
                                Change API base in {edit.layer}
                                <input
                                  name="apiBase"
                                  type="url"
                                  defaultValue={provider.apiBase || ""}
                                  placeholder="https://api.example.com/v1"
                                  required
                                />
                              </label>
                              <button
                                type="submit"
                                className="rw-button rw-secondary"
                                disabled={busyOrDisabled}
                              >
                                Save API base
                              </button>
                            </form>
                          )}
                          {(!edit || !provider.apiBase) && (
                            <p className="rw-note">
                              {provider.apiBase
                                ? "No writable layer value for this provider was exposed; existing provider settings are read-only here."
                                : "The API base includes URL components this editor will not rewrite. It remains unchanged."}
                            </p>
                          )}
                          {setupStatus && <span>{setupStatus}</span>}
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <EmptyState
                    title="No providers reported"
                    detail="Add a provider to the active Vibe config only when a writable layer is available."
                  />
                )}

                <h3 className="rw-subheading rw-spaced">
                  Selectable in this runtime <span>{runtimeModels.length}</span>
                </h3>
                {runtimeModels.length ? (
                  <div className="rw-model-grid">
                    {runtimeModels.map((model: AnyRecord) => (
                      <article className="rw-model-card" key={model.alias}>
                        <div>
                          <strong>
                            {model.displayName ||
                              model.display_name ||
                              model.alias}
                          </strong>
                          {model.alias === currentAlias && (
                            <span className="rw-current-badge">Current</span>
                          )}
                        </div>
                        <code>{model.alias}</code>
                        <small>
                          {model.provider || "Provider not reported"} · API ID{" "}
                          {model.name || model.apiId || "Not reported"}
                        </small>
                        <div className="rw-chip-row">
                          {finiteNumber(
                            model.maxContextLength ?? model.max_context_length,
                          ) && (
                            <span className="rw-chip">
                              {formatCount(
                                model.maxContextLength ??
                                  model.max_context_length,
                              )}{" "}
                              context
                            </span>
                          )}
                          {(model.supportsImages ?? model.supports_images) ===
                            true && <span className="rw-chip">Images</span>}
                          {Array.isArray(
                            model.thinkingLevels || model.thinking_levels,
                          ) &&
                            (model.thinkingLevels || model.thinking_levels).map(
                              (level: unknown) => (
                                <span className="rw-chip" key={String(level)}>
                                  Thinking · {String(level)}
                                </span>
                              ),
                            )}
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    title="No selectable models"
                    detail="The runtime has not exposed a model list for this session."
                  />
                )}
                {configuredModels.some(
                  (model) => !selectableAliases.has(model.alias),
                ) && (
                  <>
                    <h3 className="rw-subheading rw-spaced">
                      Configured, not currently selectable
                    </h3>
                    <div className="rw-chip-row">
                      {configuredModels
                        .filter((model) => !selectableAliases.has(model.alias))
                        .map((model) => (
                          <span className="rw-chip" key={model.alias}>
                            {model.alias} · configured only
                          </span>
                        ))}
                    </div>
                  </>
                )}
                <div className="rw-inline-info">
                  <ShieldCheck size={14} />
                  <span>
                    Selectable means this session’s runtime listed the model.
                    API reachability is not inferred from configuration, and no
                    default pricing is shown.
                  </span>
                </div>
              </section>
            )}

            {tab === "diagnostics" && (
              <section className="rw-section">
                <div className="rw-section-heading">
                  <div>
                    <h2>Diagnostics</h2>
                    <p>
                      Measured session activity and issues reported by Vibe.
                    </p>
                  </div>
                  <button
                    type="button"
                    className="rw-button rw-secondary"
                    onClick={() =>
                      doRefresh("diagnostics-refresh", readDiagnostics)
                    }
                    disabled={busyOrDisabled}
                  >
                    <RefreshCw size={14} /> Refresh diagnostics
                  </button>
                </div>
                <div className="rw-stat-grid">
                  <StatCard
                    label="Model calls"
                    value={
                      modelCalls === null || modelCalls === undefined
                        ? "Not reported"
                        : formatCount(modelCalls)
                    }
                  />
                  <StatCard
                    label="Prompt tokens"
                    value={formatCount(sessionPrompt)}
                  />
                  <StatCard
                    label="Completion tokens"
                    value={formatCount(sessionCompletion)}
                  />
                  <StatCard
                    label="Cached tokens"
                    value={formatReportedCount(cachedTokens)}
                  />
                  <StatCard
                    label="Current context"
                    value={formatReportedCount(contextTokens)}
                    hint={
                      contextWindow
                        ? "of " + formatCount(contextWindow)
                        : "Window not reported"
                    }
                  />
                  <StatCard
                    label="Last turn duration"
                    value={formatDuration(lastTurnDuration)}
                  />
                  {estimatedApiCost !== undefined && (
                    <StatCard
                      label="Estimated API token cost"
                      value={currency(estimatedApiCost)}
                      hint="Based on Vibe's configured per-token rates"
                    />
                  )}
                  <StatCard
                    label="Hook checks"
                    value={formatCount(
                      diagnostics?.hooksCount ?? diagnostics?.hooks_count,
                    )}
                  />
                </div>
                {inputRate !== undefined &&
                  inputRate > 0 &&
                  outputRate !== undefined &&
                  outputRate > 0 && (
                    <div className="rw-price-rates">
                      <span>Configured price metadata</span>
                      <span>Input {currency(inputRate)} / 1M tokens</span>
                      {cachedRateNumber !== undefined &&
                        cachedRateNumber > 0 && (
                          <span>
                            Cached input {currency(cachedRateNumber)} / 1M
                          </span>
                        )}
                      <span>Output {currency(outputRate)} / 1M tokens</span>
                      <small>
                        Token-rate estimate only; it does not represent a
                        subscription fee, quota, or actual invoice amount.
                      </small>
                    </div>
                  )}
                <div className="rw-inline-info">
                  <Activity size={14} />
                  <span>
                    Session counters and context values come from runtime/read.
                    Cached tokens and duration are marked “Not reported” when
                    the runtime supplies only zero defaults.
                  </span>
                </div>
                <h3 className="rw-subheading rw-spaced">
                  Reported issues <span>{issueList.length}</span>
                </h3>
                {issueList.length ? (
                  <div className="rw-issue-list">
                    {issueList.map((issue: AnyRecord, index: number) => (
                      <article
                        className="rw-issue"
                        key={String(issue.file || issue.source || index)}
                      >
                        <AlertTriangle size={14} aria-hidden="true" />
                        <div>
                          <strong>
                            {issue.file || issue.source || "Vibe issue"}
                          </strong>
                          <p>
                            {safeError(
                              issue.message ||
                                issue.description ||
                                "No details were supplied.",
                            )}
                          </p>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="rw-note">
                    Vibe reported no diagnostics issues for this session.
                  </p>
                )}
                <ToolsInspector runtime={runtime} />
                <AcpPanel />
              </section>
            )}

            {tab === "usage" && (
              <section className="rw-section">
                <div className="rw-section-heading">
                  <div>
                    <h2>Quota & usage</h2>
                    <p>
                      Plan status is available from Vibe. Live quota windows are
                      managed by Mistral’s official dashboards.
                    </p>
                  </div>
                  <button
                    type="button"
                    className="rw-button rw-secondary"
                    onClick={() => void loadAccount()}
                    disabled={busyOrDisabled}
                  >
                    {busy === "account-read" ? (
                      <LoaderCircle size={14} className="rw-spin" />
                    ) : (
                      <RefreshCw size={14} />
                    )}{" "}
                    Check account status
                  </button>
                </div>
                {account ? (
                  <div className="rw-account-card">
                    <div className="rw-account-badge">
                      <ShieldCheck size={17} />
                    </div>
                    <div className="rw-account-copy">
                      <p className="rw-eyebrow">Vibe account status</p>
                      <h3>
                        {account.plan?.title ||
                          (account.plan?.name
                            ? titleCase(account.plan.name)
                            : titleCase(account.status))}
                      </h3>
                      <p>
                        Status: {titleCase(account.status)}
                        {account.plan?.kind
                          ? " · " + titleCase(account.plan.kind)
                          : ""}
                      </p>
                      {account.apiKey?.scope && (
                        <p>
                          Verified key scope: {titleCase(account.apiKey.scope)}
                          {account.apiKey.accessScope
                            ? " · " + titleCase(account.apiKey.accessScope)
                            : ""}
                        </p>
                      )}
                    </div>
                  </div>
                ) : (
                  <EmptyState
                    title="Account status has not been checked"
                    detail="Vibe can report the plan attached to the configured Mistral credential. This read does not return live quota windows."
                  />
                )}
                <div className="rw-inline-info">
                  <ShieldCheck size={14} />
                  <span>
                    The public app-server account/read method reports plan and
                    key scope. It does not expose numerical request or token
                    quota windows. This view leaves unavailable limits blank
                    instead of estimating them.
                  </span>
                </div>
                <div className="rw-dashboard-grid">
                  <article>
                    <div className="rw-kind-icon">
                      <Layers size={15} />
                    </div>
                    <div>
                      <strong>Vibe quota</strong>
                      <p>
                        Open the official Vibe quota dashboard in its isolated
                        browser window.
                      </p>
                    </div>
                    <button
                      type="button"
                      className="rw-button rw-secondary"
                      onClick={() => void openDashboard("vibe")}
                    >
                      <ExternalLink size={13} /> Open
                    </button>
                  </article>
                  <article>
                    <div className="rw-kind-icon">
                      <Activity size={15} />
                    </div>
                    <div>
                      <strong>API usage</strong>
                      <p>
                        Inspect usage and current billing data on the official
                        Mistral platform.
                      </p>
                    </div>
                    <button
                      type="button"
                      className="rw-button rw-secondary"
                      onClick={() => void openDashboard("usage")}
                    >
                      <ExternalLink size={13} /> Open
                    </button>
                  </article>
                  <article>
                    <div className="rw-kind-icon">
                      <ShieldCheck size={15} />
                    </div>
                    <div>
                      <strong>API limits</strong>
                      <p>
                        Review limits exposed to the current API key on the
                        official platform.
                      </p>
                    </div>
                    <button
                      type="button"
                      className="rw-button rw-secondary"
                      onClick={() => void openDashboard("limits")}
                    >
                      <ExternalLink size={13} /> Open
                    </button>
                  </article>
                </div>
                <div className="rw-caption">
                  The dashboard window uses the official Mistral site with
                  isolated browser storage. No API credential is copied into the
                  page.
                </div>
              </section>
            )}
          </div>
        </>
      )}

      <aside className="rw-acp-card">
        <div className="rw-acp-mark">
          <Layers size={17} />
        </div>
        <div className="rw-acp-copy">
          <p className="rw-eyebrow">Agent Client Protocol</p>
          <strong>ACP editor integration</strong>
          <p>
            Compatible editors can launch the upstream vibe-acp command with
            Vibe configuration and credentials. This desktop uses the app-server
            protocol; ACP remains an editor integration managed by Vibe.
          </p>
        </div>
        <button
          type="button"
          className="rw-button rw-secondary"
          onClick={() => setTab("providers")}
          disabled={!sessionId}
        >
          View config <ArrowUpRight size={13} />
        </button>
      </aside>

      {addMcpOpen && (
        <div
          className="rw-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget)
              closeDialog(setAddMcpOpen);
          }}
        >
          <section
            className="rw-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rw-add-mcp-title"
            tabIndex={-1}
            onKeyDown={(event) =>
              dialogKeyDown(event, () => closeDialog(setAddMcpOpen))
            }
          >
            <header>
              <div>
                <p className="rw-eyebrow">MCP catalog</p>
                <h2 id="rw-add-mcp-title">Add HTTP server</h2>
              </div>
              <button
                type="button"
                className="rw-icon-button"
                aria-label="Close dialog"
                onClick={() => closeDialog(setAddMcpOpen)}
              >
                <X size={15} />
              </button>
            </header>
            <p>
              Vibe accepts HTTPS streamable HTTP endpoints here. Local stdio
              servers are configured through the official config/mcp_servers
              layer via “Add stdio server” in the MCP tab.
            </p>
            <form onSubmit={(event) => void saveMcpServer(event)}>
              <label>
                Server URL
                <input
                  type="url"
                  autoFocus
                  value={mcpUrl}
                  onChange={(event) => setMcpUrl(event.target.value)}
                  placeholder="https://example.com/mcp"
                  required
                />
              </label>
              <label>
                Display name <span className="rw-optional">(optional)</span>
                <input
                  value={mcpName}
                  onChange={(event) => setMcpName(event.target.value)}
                  placeholder="Team tools"
                />
              </label>
              <footer>
                <button
                  type="button"
                  className="rw-button rw-secondary"
                  onClick={() => closeDialog(setAddMcpOpen)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rw-button rw-primary"
                  disabled={busyOrDisabled}
                >
                  {busy === "add-mcp" ? "Adding…" : "Add server"}
                </button>
              </footer>
            </form>
          </section>
        </div>
      )}

      {confirmRemove && (
        <div
          className="rw-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setConfirmRemove(null);
          }}
        >
          <section
            className="rw-modal rw-confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rw-remove-title"
            tabIndex={-1}
            onKeyDown={(event) =>
              dialogKeyDown(event, () => setConfirmRemove(null))
            }
          >
            <header>
              <div>
                <p className="rw-eyebrow">Remove MCP server</p>
                <h2 id="rw-remove-title">
                  Remove {confirmRemove.display_name || confirmRemove.name}?
                </h2>
              </div>
              <button
                type="button"
                className="rw-icon-button"
                aria-label="Close dialog"
                onClick={() => setConfirmRemove(null)}
              >
                <X size={15} />
              </button>
            </header>
            <p>
              This removes the server from the Vibe configuration used by this
              session. Its tools will no longer be available after Vibe updates
              the runtime.
            </p>
            <footer>
              <button
                type="button"
                className="rw-button rw-secondary"
                onClick={() => setConfirmRemove(null)}
              >
                Keep server
              </button>
              <button
                type="button"
                className="rw-button rw-danger-button"
                disabled={busyOrDisabled}
                onClick={() => void deleteMcp()}
              >
                {busy === "remove:" + confirmRemove.name
                  ? "Removing…"
                  : "Remove server"}
              </button>
            </footer>
          </section>
        </div>
      )}

      {stdioOpen && (
        <div
          className="rw-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeDialog(setStdioOpen);
          }}
        >
          <section
            className="rw-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rw-stdio-title"
            tabIndex={-1}
            onKeyDown={(event) => dialogKeyDown(event, () => closeDialog(setStdioOpen))}
          >
            <StdioMcpDialog
              sessionId={sessionId}
              snapshot={mcpSnapshot}
              existingName={stdioEditingName}
              onClose={() => closeDialog(setStdioOpen)}
              onDone={(result) => {
                if (result.outcome === "applied-verified" || result.outcome === "pending-reload") {
                  reportMutationResult(result, "save");
                  closeDialog(setStdioOpen);
                  setStdioEditingName(null);
                } else {
                  // Refresh the baseline (conflict carries the fresh
                  // snapshot) and keep the dialog open for review + retry.
                  applyMutationResult(result);
                  setError(result.message);
                  onError?.(result.message);
                }
              }}
              onError={(message) => {
                setError(message);
                onError?.(message);
              }}
            />
          </section>
        </div>
      )}

      {addProviderOpen && (
        <div
          className="rw-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget)
              closeDialog(setAddProviderOpen);
          }}
        >
          <section
            className="rw-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rw-add-provider-title"
            tabIndex={-1}
            onKeyDown={(event) =>
              dialogKeyDown(event, () => closeDialog(setAddProviderOpen))
            }
          >
            <header>
              <div>
                <p className="rw-eyebrow">Vibe config</p>
                <h2 id="rw-add-provider-title">Add provider</h2>
              </div>
              <button
                type="button"
                className="rw-icon-button"
                aria-label="Close dialog"
                onClick={() => closeDialog(setAddProviderOpen)}
              >
                <X size={15} />
              </button>
            </header>
            <p>
              The provider is written as one new config entry in a Vibe-reported
              writable layer. Credentials are stored through Vibe’s secure
              credential method.
            </p>
            <form onSubmit={(event) => void saveProvider(event)}>
              <label>
                Provider name
                <input
                  autoFocus
                  value={providerName}
                  onChange={(event) => setProviderName(event.target.value)}
                  placeholder="my-provider"
                  required
                />
              </label>
              <label>
                API base URL
                <input
                  type="url"
                  value={providerBase}
                  onChange={(event) => setProviderBase(event.target.value)}
                  placeholder="https://api.example.com/v1"
                  required
                />
              </label>
              <label>
                Writable layer
                <select
                  value={providerLayer}
                  onChange={(event) => setProviderLayer(event.target.value)}
                  required
                >
                  {writableProviderLayers.map((layer) => (
                    <option value={layer.layer} key={layer.layer}>
                      {layer.layer}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                API key{" "}
                <span className="rw-optional">
                  (optional; sent to Vibe’s secure credential store)
                </span>
                <span className="rw-secret-entry">
                  <input
                    type={showKey ? "text" : "password"}
                    autoComplete="new-password"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder="Leave blank to configure later"
                  />
                  <button
                    className="rw-icon-button"
                    type="button"
                    aria-label={showKey ? "Hide API key" : "Show API key"}
                    onClick={() => setShowKey((value) => !value)}
                  >
                    {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </span>
              </label>
              <footer>
                <button
                  type="button"
                  className="rw-button rw-secondary"
                  onClick={() => {
                    setApiKey("");
                    closeDialog(setAddProviderOpen);
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rw-button rw-primary"
                  disabled={
                    busyOrDisabled ||
                    !writableProviderLayers.some(
                      (layer) => layer.layer === providerLayer,
                    )
                  }
                >
                  {busy === "provider-add" ? "Saving…" : "Save provider"}
                </button>
              </footer>
            </form>
          </section>
        </div>
      )}

      {addModelOpen && (
        <div
          className="rw-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget)
              closeDialog(setAddModelOpen);
          }}
        >
          <section
            className="rw-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rw-add-model-title"
            tabIndex={-1}
            onKeyDown={(event) =>
              dialogKeyDown(event, () => closeDialog(setAddModelOpen))
            }
          >
            <header>
              <div>
                <p className="rw-eyebrow">Vibe config</p>
                <h2 id="rw-add-model-title">Add model</h2>
              </div>
              <button
                type="button"
                className="rw-icon-button"
                aria-label="Close dialog"
                onClick={() => closeDialog(setAddModelOpen)}
              >
                <X size={15} />
              </button>
            </header>
            <p>
              Enter the model API ID and a Vibe alias. Provider defaults and
              runtime availability are determined by Vibe.
            </p>
            <form onSubmit={(event) => void saveModel(event)}>
              <label>
                API model ID
                <input
                  autoFocus
                  value={modelName}
                  onChange={(event) => setModelName(event.target.value)}
                  placeholder="model-id-from-provider"
                  required
                />
              </label>
              <label>
                Vibe alias
                <input
                  value={modelAlias}
                  onChange={(event) => setModelAlias(event.target.value)}
                  placeholder="my-model"
                  required
                />
              </label>
              <label>
                Provider
                <select
                  aria-label="Provider"
                  value={modelProvider}
                  onChange={(event) => setModelProvider(event.target.value)}
                  required
                >
                  {config.providers.map((provider: AnyRecord) => (
                    <option key={provider.name} value={provider.name}>
                      {provider.name}
                    </option>
                  ))}
                </select>
              </label>
              <footer>
                <button
                  type="button"
                  className="rw-button rw-secondary"
                  onClick={() => closeDialog(setAddModelOpen)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rw-button rw-primary"
                  disabled={busyOrDisabled || !configFields.targets.length}
                >
                  {busy === "model-add" ? "Saving…" : "Save model"}
                </button>
              </footer>
            </form>
          </section>
        </div>
      )}
    </section>
  );
}
