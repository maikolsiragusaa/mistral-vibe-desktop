import { useId, useRef } from "react";
import { Plug, Settings2 } from "lucide-react";
import type { Runtime } from "../types";

export function McpStatus({
  runtime,
  onManage,
}: {
  runtime: Runtime | null;
  onManage: () => void;
}) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const sources = runtime?.mcp?.sources || [];
  return (
    <>
      <button
        className="icon-button titlebar-mcp"
        aria-label="MCP status"
        title="MCP servers and tools"
        popoverTarget={id}
      >
        <Plug size={15} />
        {sources.length > 0 && <span>{sources.length}</span>}
      </button>
      <div
        id={id}
        ref={panel}
        popover="auto"
        className="mcp-status-popover"
        role="dialog"
        aria-label="MCP status details"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            panel.current?.hidePopover();
          }
        }}
      >
        <header>
          <Plug size={15} />
          <strong>MCP connections</strong>
        </header>
        {sources.length ? (
          sources.map((source: any) => (
            <div className="mcp-status-source" key={source.name}>
              <span>
                <strong>{source.displayName || source.name}</strong>
                <small>{source.tools?.length || 0} tools</small>
              </span>
              <small>
                {String(source.status || "unknown").replace(/_/g, " ")}
              </small>
            </div>
          ))
        ) : (
          <p>
            {runtime
              ? "No MCP servers in this session."
              : "Open a project to inspect its MCP connections."}
          </p>
        )}
        <button
          className="secondary"
          onClick={() => {
            panel.current?.hidePopover();
            onManage();
          }}
        >
          <Settings2 size={13} /> Manage MCP
        </button>
      </div>
    </>
  );
}
