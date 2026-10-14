import type { ConfigField } from "./types";

interface LayerInspectorProps {
  targets: string[];
  fields: ConfigField[];
}

export function LayerInspector({ targets, fields }: LayerInspectorProps) {
  const mcpField = fields.find((field) => field.name === "mcp_servers");
  const layers = mcpField?.layerValues ?? [];
  return (
    <section className="rw-layers" aria-label="Configuration layers">
      <h3 className="rw-subheading">Configuration layers</h3>
      <p className="rw-note">
        Writable layers exposed by Vibe 2.26.1: {targets.length ? targets.join(", ") : "none reported"}.
        A global toggle can be shadowed by another declaration — the readback below shows which
        layer actually carries each server. Plugin-owned entries stay with their plugin.
      </p>
      {layers.length ? (
        <ul className="rw-layer-list">
          {layers.map((layer) => {
            const values = Array.isArray(layer.value) ? (layer.value as unknown[]) : [];
            const names = values.flatMap((entry): string[] => {
              if (entry !== null && typeof entry === "object" && typeof (entry as Record<string, unknown>)["name"] === "string")
                return [(entry as Record<string, unknown>)["name"] as string];
              return [];
            });
            return (
              <li key={layer.layer}>
                <strong>{layer.layer}</strong>
                <small>
                  {names.length ? `${names.length} server(s): ${names.join(", ").slice(0, 240)}` : "no servers"}
                </small>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="rw-note">No per-layer MCP values were exposed.</p>
      )}
    </section>
  );
}
