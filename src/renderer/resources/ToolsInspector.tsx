import { useMemo } from "react";
import type { Runtime } from "../types";

interface ToolsInspectorProps {
  runtime: Runtime | null;
}

interface ToolRow {
  name: string;
  source: string;
  state: string;
  description?: string;
  builtin: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function ToolsInspector({ runtime }: ToolsInspectorProps) {
  const rows = useMemo<ToolRow[]>(() => {
    if (!runtime) return [];
    const out: ToolRow[] = [];
    const seen = new Set<string>();
    const runtimeAny = runtime as unknown as Record<string, unknown>;
    const builtin = runtimeAny["tools"];
    if (Array.isArray(builtin)) {
      for (const entry of builtin) {
        if (!isRecord(entry) || typeof entry["name"] !== "string") continue;
        const name = entry["name"] as string;
        if (seen.has(`builtin:${name}`)) continue;
        seen.add(`builtin:${name}`);
        out.push({ name, source: "built-in", state: "observed in runtime/read", builtin: true });
      }
    }
    const mcp = runtimeAny["mcp"];
    const sources = isRecord(mcp) && Array.isArray(mcp["sources"]) ? (mcp["sources"] as unknown[]) : [];
    for (const source of sources) {
      if (!isRecord(source) || typeof source["name"] !== "string") continue;
      const serverName = source["name"] as string;
      const status = typeof source["status"] === "string" ? (source["status"] as string) : "unknown";
      const tools = Array.isArray(source["tools"]) ? (source["tools"] as unknown[]) : [];
      for (const tool of tools) {
        if (!isRecord(tool) || typeof tool["name"] !== "string") continue;
        const toolName = tool["name"] as string;
        const key = `${serverName}:${toolName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const enabled = tool["enabled"];
        out.push({
          name: toolName,
          source: serverName,
          state:
            status === "disabled"
              ? "disabled with server"
              : enabled === false
                ? "disabled"
                : status === "connected" || status === "ready"
                  ? "available via connected server"
                  : status === "needs_auth"
                    ? "awaits authentication"
                    : "configured, connection not verified",
          description: typeof tool["description"] === "string" ? (tool["description"] as string) : undefined,
          builtin: false,
        });
      }
    }
    const agents = runtimeAny["agents"];
    if (Array.isArray(agents)) {
      for (const agent of agents) {
        if (!isRecord(agent) || typeof agent["name"] !== "string") continue;
        const name = `agent:${agent["name"] as string}`;
        if (seen.has(name)) continue;
        seen.add(name);
        out.push({
          name: agent["name"] as string,
          source: "agent",
          state: "observed in runtime/read",
          description: typeof agent["description"] === "string" ? (agent["description"] as string) : undefined,
          builtin: true,
        });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }, [runtime]);

  const agents = useMemo(() => {
    const runtimeAny = (runtime ?? {}) as unknown as Record<string, unknown>;
    const raw = runtimeAny["agents"];
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((entry): Array<{ name: string; description?: string }> => {
      if (!isRecord(entry) || typeof entry["name"] !== "string") return [];
      return [
        {
          name: entry["name"] as string,
          description: typeof entry["description"] === "string" ? (entry["description"] as string) : undefined,
        },
      ];
    });
  }, [runtime]);

  const skills = useMemo(() => {
    const runtimeAny = (runtime ?? {}) as unknown as Record<string, unknown>;
    const raw = runtimeAny["skills"];
    if (!Array.isArray(raw)) return 0;
    return raw.length;
  }, [runtime]);

  if (!runtime) {
    return <p className="rw-note">Open a session to inspect agent capabilities.</p>;
  }

  return (
    <section className="rw-tools" aria-label="Agent tools and capabilities">
      <h3 className="rw-subheading">
        Tools known to this session <span>{rows.length}</span>
      </h3>
      <p className="rw-note">
        Source: official runtime/read only (tools/list is method_not_found on Unified 2.26.1).
        A tool is reported available only when its server is connected; anything else is
        configured or not verifiable — never guessed. Tools cannot be executed from this list.
      </p>
      <p className="rw-note">
        Agents: {agents.map((a) => a.name).join(", ") || "not reported"} · Skills observed: {skills} ·
        Active agent:{" "}
        {(() => {
          const active = (runtime as unknown as Record<string, unknown>)["activeAgent"];
          return isRecord(active) && typeof active["name"] === "string"
            ? (active["name"] as string)
            : "not reported";
        })()}
      </p>
      {rows.length ? (
        <ul className="rw-tool-list">
          {rows.map((row) => (
            <li key={`${row.source}:${row.name}`} className="rw-tool-row">
              <strong>{row.name}</strong>
              <small>
                {row.builtin ? "built-in" : `via ${row.source}`} · {row.state}
              </small>
              {row.description && <span className="rw-tool-desc">{row.description.slice(0, 220)}</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="rw-note">No tools were reported by the runtime.</p>
      )}
    </section>
  );
}
