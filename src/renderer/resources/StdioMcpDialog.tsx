import { useMemo, useState } from "react";
import {
  parseArgsText,
  parseEnvText,
  validMcpName,
  validStdioCommand,
  validStdioCwd,
} from "./validation";
import { getErrorMessage } from "./adapters";
import type { McpServerRecord } from "./types";

interface StdioMcpDialogProps {
  sessionId: string | undefined;
  existing: McpServerRecord | null;
  servers: McpServerRecord[];
  targetLayer: string;
  onClose: () => void;
  onSaved: (message: string) => void;
  onError: (message: string) => void;
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  refresh: () => Promise<void>;
}

function recordToText(record: McpServerRecord): {
  argsText: string;
  envText: string;
} {
  return {
    argsText: (record.args ?? []).join("\n"),
    envText: Object.entries(record.env ?? {})
      .map(([key, value]) => `${key}=${value}`)
      .join("\n"),
  };
}

export function StdioMcpDialog({
  sessionId,
  existing,
  servers,
  targetLayer,
  onClose,
  onSaved,
  onError,
  request,
  refresh,
}: StdioMcpDialogProps) {
  const initial = useMemo(() => (existing ? recordToText(existing) : { argsText: "", envText: "" }), [existing]);
  const [name, setName] = useState(existing?.name ?? "");
  const [command, setCommand] = useState(existing?.command ?? "");
  const [argsText, setArgsText] = useState(initial.argsText);
  const [cwd, setCwd] = useState(existing?.cwd ?? "");
  const [envText, setEnvText] = useState(initial.envText);
  const [disabled, setDisabled] = useState(existing?.disabled ?? false);
  const [consent, setConsent] = useState(false);
  const [pending, setPending] = useState(false);
  const editing = existing !== null;

  const problems: string[] = [];
  if (!validMcpName(name)) problems.push("Name must start alphanumerically (letters, digits, dot, underscore, dash).");
  const commandProblem = validStdioCommand(command);
  if (commandProblem) problems.push(commandProblem);
  const { args, error: argsError } = parseArgsText(argsText);
  if (argsError) problems.push(argsError);
  const { entries: envEntries, error: envError } = parseEnvText(envText);
  if (envError) problems.push(envError);
  const cwdProblem = validStdioCwd(cwd);
  if (cwdProblem) problems.push(cwdProblem);
  if (!targetLayer) problems.push("No writable config layer is exposed by Vibe.");
  if (!consent) problems.push("Explicit consent is required: adding a stdio server will execute local software.");

  const save = async () => {
    if (!sessionId) {
      onError("Select or open a Vibe session before configuring MCP servers.");
      return;
    }
    if (problems.length) {
      onError(problems[0]);
      return;
    }
    const cleanName = name.trim();
    const duplicate = servers.some(
      (server) => server.name === cleanName && server.name !== existing?.name,
    );
    if (duplicate && !editing) {
      onError("A server with this name already exists. Edit it instead of duplicating it.");
      return;
    }
    const env: Record<string, string> = {};
    for (const entry of envEntries) env[entry.key] = entry.value;
    const entry: Record<string, unknown> = {
      name: cleanName,
      transport: "stdio",
      command: command.trim(),
      args,
      env,
      disabled,
    };
    if (cwd.trim()) entry.cwd = cwd.trim();
    const next = editing
      ? servers.map((server) =>
          server.name === existing?.name ? (entry as unknown as McpServerRecord) : server,
        )
      : [...servers, entry as unknown as McpServerRecord];
    // Preserve every unmodified entry byte-for-byte from the authoritative
    // layer value; never rebuild from a redacted effective config.
    const serialised = next.map((server) => {
      const out: Record<string, unknown> = { name: server.name };
      if (server.transport) out.transport = server.transport;
      if (server.url) out.url = server.url;
      if (server.command) out.command = server.command;
      if (server.args) out.args = server.args;
      if (server.env) out.env = server.env;
      if (server.cwd) out.cwd = server.cwd;
      if (typeof server.disabled === "boolean") out.disabled = server.disabled;
      if (server.prompt) out.prompt = server.prompt;
      return out;
    });
    setPending(true);
    try {
      await request("config/write", {
        sessionId,
        ops: [{ op: "set", path: "/mcp_servers", value: serialised, targetLayer }],
        reason: editing ? "edit stdio MCP server" : "add stdio MCP server",
        reloadRuntime: true,
      });
      await request("mcp_catalog/refresh", { sessionId }).catch(() => undefined);
      await refresh();
      const readback = await request("config/fields/read", { sessionId });
      const fieldsRaw =
        readback !== null && typeof readback === "object" && Array.isArray((readback as Record<string, unknown>)["fields"])
          ? ((readback as Record<string, unknown>)["fields"] as unknown[])
          : [];
      const field = fieldsRaw.find(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === "object" && (item as Record<string, unknown>)["name"] === "mcp_servers",
      );
      const layers = Array.isArray(field?.["layerValues"]) ? (field["layerValues"] as unknown[]) : [];
      const layer = layers.find(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === "object" && (item as Record<string, unknown>)["layer"] === targetLayer,
      );
      const values = Array.isArray(layer?.["value"]) ? (layer["value"] as unknown[]) : [];
      const found = values.some(
        (item) =>
          item !== null && typeof item === "object" && (item as Record<string, unknown>)["name"] === cleanName,
      );
      if (!found) throw new Error("Vibe did not persist this server. Reload configuration layers to inspect it.");
      onSaved(editing ? `Updated stdio server ${cleanName}.` : `Added stdio server ${cleanName}.`);
      onClose();
    } catch (cause) {
      onError(getErrorMessage(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="rw-dialog" role="dialog" aria-label={editing ? `Edit stdio server ${existing?.name}` : "Add stdio server"}>
      <header>
        <div>
          <p className="rw-eyebrow">Local stdio server via official config</p>
          <h3>{editing ? `Edit ${existing?.name}` : "Add stdio server"}</h3>
        </div>
        <button type="button" className="rw-icon-button" aria-label="Close stdio editor" onClick={onClose} disabled={pending}>
          ✕
        </button>
      </header>
      <p className="rw-note">
        Stdio servers run local executables through the official Vibe harness (no second MCP host).
        Validation here is syntactic only — the connection is verified after saving via catalog refresh and readback.
      </p>
      <label className="rw-field">
        Server name
        <input type="text" aria-label="Stdio server name" value={name} onChange={(event) => setName(event.target.value)} disabled={pending || editing} maxLength={128} />
      </label>
      <label className="rw-field">
        Command (executable path or name, no shell string)
        <input type="text" aria-label="Stdio command" value={command} onChange={(event) => setCommand(event.target.value)} disabled={pending} maxLength={1024} placeholder="C:\tools\server.exe or python" />
      </label>
      <label className="rw-field">
        Arguments (one per line, passed separately — never a shell string)
        <textarea aria-label="Stdio arguments" value={argsText} onChange={(event) => setArgsText(event.target.value)} disabled={pending} rows={4} placeholder={"-V\n--stdio"} />
      </label>
      <label className="rw-field">
        Working directory (optional, absolute only)
        <input type="text" aria-label="Stdio working directory" value={cwd} onChange={(event) => setCwd(event.target.value)} disabled={pending} placeholder="C:\work\server" />
      </label>
      <label className="rw-field">
        Environment (optional, KEY=value per line — values stay with Vibe, never logged)
        <textarea aria-label="Stdio environment" value={envText} onChange={(event) => setEnvText(event.target.value)} disabled={pending} rows={3} placeholder="FOO=bar" />
      </label>
      <label className="rw-check">
        <input type="checkbox" checked={disabled} onChange={(event) => setDisabled(event.target.checked)} disabled={pending} />
        Start disabled
      </label>
      <div className="rw-summary" aria-live="polite">
        <strong>Summary before saving</strong>
        <p>
          {name.trim() || "unnamed"} · {command.trim() || "no command"} · {args.length} args ·{" "}
          {envEntries.length} env vars · {cwd.trim() ? `cwd ${cwd.trim()}` : "default cwd"} ·{" "}
          {disabled ? "disabled" : "enabled"} · layer {targetLayer || "unknown"}
        </p>
        <p className="rw-note">Saving writes only the mcp_servers list in layer {targetLayer || "unknown"} and preserves every other entry.</p>
      </div>
      <label className="rw-check rw-consent">
        <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} disabled={pending} />
        I understand this executes local software via the Vibe harness when the server starts.
      </label>
      {problems.length > 0 && (
        <ul className="rw-problems">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      <div className="rw-actions">
        <button type="button" className="rw-button rw-secondary" onClick={onClose} disabled={pending}>
          Cancel
        </button>
        <button type="button" className="rw-button rw-primary" onClick={() => void save()} disabled={pending || problems.length > 0}>
          {pending ? "Saving…" : editing ? "Save changes" : "Add server"}
        </button>
      </div>
    </div>
  );
}
