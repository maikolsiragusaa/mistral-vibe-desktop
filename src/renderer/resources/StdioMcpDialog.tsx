import { useMemo, useState } from "react";
import {
  parseArgsText,
  parseEnvText,
  validMcpName,
  validStdioCommand,
  validStdioCwd,
} from "./validation";
import { getErrorMessage } from "./adapters";
import type {
  McpLayerSnapshot,
  McpMutationResult,
  RedactedMcpServer,
} from "./mcp-mutation-types";
import {
  buildAddIntent,
  buildEditIntent,
  buildEnvChange,
  diffScalars,
  scalarsFromSnapshot,
  isEmptyEdit,
  type EnvFormState,
  type StdioFormState,
} from "./mcp-intent";
import { mutateMcpLayer } from "./mcp-config-client";

interface StdioMcpDialogProps {
  sessionId: string | undefined;
  snapshot: McpLayerSnapshot | null;
  existingName: string | null;
  onClose: () => void;
  onDone: (result: McpMutationResult) => void;
  onError: (message: string) => void;
}

function formFromSnapshot(entry: RedactedMcpServer | null): StdioFormState {
  return {
    command: typeof entry?.command === "string" ? entry.command : "",
    args: Array.isArray(entry?.args)
      ? entry.args.filter((a): a is string => typeof a === "string")
      : [],
    cwd: typeof entry?.cwd === "string" ? entry.cwd : "",
    prompt: typeof entry?.prompt === "string" ? entry.prompt : "",
    startupTimeout:
      typeof entry?.startup_timeout_sec === "number" ? String(entry.startup_timeout_sec) : "",
    toolTimeout:
      typeof entry?.tool_timeout_sec === "number" ? String(entry.tool_timeout_sec) : "",
    samplingEnabled: entry?.sampling_enabled === true,
    disabled: entry?.disabled === true,
    disabledTools: Array.isArray(entry?.disabled_tools)
      ? entry.disabled_tools.filter((a): a is string => typeof a === "string")
      : [],
  };
}

export function StdioMcpDialog({
  sessionId,
  snapshot,
  existingName,
  onClose,
  onDone,
  onError,
}: StdioMcpDialogProps) {
  const existing: RedactedMcpServer | null = useMemo(() => {
    if (!existingName || !snapshot) return null;
    return snapshot.servers.find((server) => server.name === existingName) ?? null;
  }, [existingName, snapshot]);
  const editing = existing !== null;
  const existingKeys = useMemo(
    () => (Array.isArray(existing?.envKeys) ? [...existing.envKeys] : []),
    [existing],
  );

  const initialForm = useMemo(() => formFromSnapshot(existing), [existing]);
  const [name, setName] = useState(existing?.name ?? "");
  const [command, setCommand] = useState(initialForm.command);
  const [argsText, setArgsText] = useState(initialForm.args.join("\n"));
  const [cwd, setCwd] = useState(initialForm.cwd);
  const [prompt, setPrompt] = useState(initialForm.prompt);
  const [startupTimeout, setStartupTimeout] = useState(initialForm.startupTimeout);
  const [toolTimeout, setToolTimeout] = useState(initialForm.toolTimeout);
  const [samplingEnabled, setSamplingEnabled] = useState(initialForm.samplingEnabled);
  const [disabled, setDisabled] = useState(initialForm.disabled);
  const [disabledToolsText, setDisabledToolsText] = useState(initialForm.disabledTools.join("\n"));
  // Secret-safe env model: existing values never enter React state. Each
  // known key is keep/remove/replace; only explicitly typed values are held.
  const [kept, setKept] = useState<string[]>(existingKeys);
  const [removed, setRemoved] = useState<string[]>([]);
  const [replaced, setReplaced] = useState<Record<string, string>>({});
  const [replacing, setReplacing] = useState<string[]>([]);
  const [added, setAdded] = useState<Record<string, string>>({});
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [consent, setConsent] = useState(false);
  const [pending, setPending] = useState(false);

  const form: StdioFormState = {
    command,
    args: parseArgsText(argsText).args,
    cwd,
    prompt,
    startupTimeout,
    toolTimeout,
    samplingEnabled,
    disabled,
    disabledTools: disabledToolsText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  };
  const envForm: EnvFormState = { kept, replaced, added, removed };

  const problems: string[] = [];
  if (!editing && !validMcpName(name))
    problems.push("Name must start alphanumerically (letters, digits, dot, underscore, dash).");
  const commandProblem = validStdioCommand(command);
  if (commandProblem) problems.push(commandProblem);
  const argsError = parseArgsText(argsText).error;
  if (argsError) problems.push(argsError);
  const cwdProblem = validStdioCwd(cwd);
  if (cwdProblem) problems.push(cwdProblem);
  if (startupTimeout.trim() && !/^\d+(\.\d+)?$/.test(startupTimeout.trim()))
    problems.push("Startup timeout must be a positive number of seconds.");
  if (toolTimeout.trim() && !/^\d+(\.\d+)?$/.test(toolTimeout.trim()))
    problems.push("Tool timeout must be a positive number of seconds.");
  if (disabledToolsText.split(/\r?\n/).filter((line) => line.trim()).length > 128)
    problems.push("Use at most 128 disabled tools.");
  const newEnvError = (() => {
    const combined = [
      ...Object.entries(replaced).map(([k, v]) => `${k}=${v}`),
      ...Object.entries(added).map(([k, v]) => `${k}=${v}`),
    ].join("\n");
    return parseEnvText(combined).error;
  })();
  if (newEnvError) problems.push(newEnvError);
  if (newKey.trim() || newValue) problems.push("Confirm the pending variable with Add variable, or clear it.");
  if (!snapshot) problems.push("The MCP configuration layer has not loaded yet.");
  else if (!snapshot.targetLayer) problems.push("No writable config layer is exposed by Vibe.");
  if (!consent) problems.push("Explicit consent is required: adding a stdio server will execute local software.");

  const envChange = useMemo(
    () => (editing ? buildEnvChange(existingKeys, envForm) : null),
    [editing, existingKeys, envForm],
  );
  const emptyEdit = useMemo(() => {
    if (!editing || !existing) return false;
    const { fields, unset } = diffScalars(
      scalarsFromSnapshot(existing),
      {
        command: form.command,
        args: form.args,
        cwd: form.cwd,
        prompt: form.prompt,
        startup_timeout_sec: form.startupTimeout.trim() ? Number(form.startupTimeout) : undefined,
        tool_timeout_sec: form.toolTimeout.trim() ? Number(form.toolTimeout) : undefined,
        sampling_enabled: form.samplingEnabled,
        disabled: form.disabled,
        disabled_tools: form.disabledTools,
      },
    );
    return (
      Object.keys(fields).length === 0 && unset.length === 0 && envChange === null
    );
  }, [editing, existing, form, envChange]);

  const save = async () => {
    if (!sessionId) {
      onError("Select or open a Vibe session before configuring MCP servers.");
      return;
    }
    if (!snapshot) {
      onError("The MCP configuration layer has not loaded yet.");
      return;
    }
    if (problems.length) {
      onError(problems[0]);
      return;
    }
    const intent = editing
      ? buildEditIntent(existing!, snapshot.revision, form, envChange)
      : buildAddIntent(
          name,
          snapshot.revision,
          form,
          Object.fromEntries(
            Object.entries(added).map(([key, value]) => [key.trim(), value]),
          ),
          snapshot.targetLayer,
        );
    if (isEmptyEdit(intent)) {
      onError("No changes to save.");
      return;
    }
    setPending(true);
    try {
      const result = await mutateMcpLayer(sessionId, intent);
      onDone(result);
    } catch (cause) {
      onError(getErrorMessage(cause));
    } finally {
      setPending(false);
    }
  };

  const toggleKeep = (key: string, keepIt: boolean) => {
    setKept((prev) => (keepIt ? [...new Set([...prev, key])] : prev.filter((k) => k !== key)));
    setRemoved((prev) => (keepIt ? prev.filter((k) => k !== key) : [...new Set([...prev, key])]));
    if (keepIt) {
      setReplacing((prev) => prev.filter((k) => k !== key));
      setReplaced((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
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
        Only the fields you change are written; every other server and every untouched
        property is preserved and verified. Validation here is syntactic only.
      </p>
      {!editing && (
        <label className="rw-field">
          Server name
          <input type="text" aria-label="Stdio server name" value={name} onChange={(event) => setName(event.target.value)} disabled={pending} maxLength={128} />
        </label>
      )}
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
        Prompt (optional)
        <input type="text" aria-label="Stdio prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} disabled={pending} maxLength={2000} />
      </label>
      <div className="rw-form-row">
        <label>
          Startup timeout, seconds (optional)
          <input type="text" inputMode="decimal" aria-label="Startup timeout seconds" value={startupTimeout} onChange={(event) => setStartupTimeout(event.target.value)} disabled={pending} placeholder="10" />
        </label>
        <label>
          Tool timeout, seconds (optional)
          <input type="text" inputMode="decimal" aria-label="Tool timeout seconds" value={toolTimeout} onChange={(event) => setToolTimeout(event.target.value)} disabled={pending} placeholder="60" />
        </label>
      </div>
      <label className="rw-check">
        <input type="checkbox" checked={samplingEnabled} onChange={(event) => setSamplingEnabled(event.target.checked)} disabled={pending} />
        Sampling enabled
      </label>
      <label className="rw-field">
        Disabled tools (optional, one per line)
        <textarea aria-label="Disabled tools" value={disabledToolsText} onChange={(event) => setDisabledToolsText(event.target.value)} disabled={pending} rows={2} />
      </label>
      <section className="rw-env" aria-label="Environment variables">
        <h4 className="rw-subheading">Environment</h4>
        {editing ? (
          <>
            <p className="rw-note">
              Existing values are never shown. Keep a variable untouched, replace its value
              explicitly, or remove it. Editing other fields never touches the environment.
            </p>
            {existingKeys.length === 0 && Object.keys(added).length === 0 && (
              <p className="rw-note">No variables are configured for this server.</p>
            )}
            <ul className="rw-env-list">
              {existingKeys.map((key) => {
                const isRemoved = removed.includes(key);
                const isReplacing = replacing.includes(key);
                return (
                  <li key={key} className="rw-env-row">
                    <span className="rw-env-key">
                      <code>{key}</code>
                      <small>{isRemoved ? "will be removed" : "configured"}</small>
                    </span>
                    {!isRemoved && !isReplacing && (
                      <div className="rw-actions">
                        <button type="button" className="rw-button rw-secondary rw-small" disabled={pending} onClick={() => setReplacing((prev) => [...prev, key])}>
                          Replace value
                        </button>
                        <button type="button" className="rw-button rw-secondary rw-small" disabled={pending} onClick={() => toggleKeep(key, false)}>
                          Remove
                        </button>
                      </div>
                    )}
                    {!isRemoved && isReplacing && (
                      <div className="rw-env-replace">
                        <input
                          type="password"
                          autoComplete="new-password"
                          aria-label={`New value for ${key}`}
                          placeholder="Enter the new value"
                          value={replaced[key] ?? ""}
                          disabled={pending}
                          onChange={(event) =>
                            setReplaced((prev) => ({ ...prev, [key]: event.target.value }))
                          }
                        />
                        <button type="button" className="rw-button rw-secondary rw-small" disabled={pending} onClick={() => toggleKeep(key, true)}>
                          Keep existing
                        </button>
                      </div>
                    )}
                    {isRemoved && (
                      <button type="button" className="rw-button rw-secondary rw-small" disabled={pending} onClick={() => toggleKeep(key, true)}>
                        Keep
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        ) : (
          <p className="rw-note">Variables you add here are sent once with the new server.</p>
        )}
        {Object.keys(added).map((key) => (
          <div key={key} className="rw-env-row">
            <span className="rw-env-key">
              <code>{key}</code>
              <small>new variable</small>
            </span>
            <span className="rw-note">value provided (hidden)</span>
            <button
              type="button"
              className="rw-button rw-secondary rw-small"
              disabled={pending}
              onClick={() =>
                setAdded((prev) => {
                  const next = { ...prev };
                  delete next[key];
                  return next;
                })
              }
            >
              Discard
            </button>
          </div>
        ))}
        <div className="rw-env-add">
          <input type="text" aria-label="New variable name" placeholder="NAME" value={newKey} disabled={pending} onChange={(event) => setNewKey(event.target.value)} />
          <input type="password" autoComplete="new-password" aria-label="New variable value" placeholder="value (hidden)" value={newValue} disabled={pending} onChange={(event) => setNewValue(event.target.value)} />
          <button
            type="button"
            className="rw-button rw-secondary rw-small"
            disabled={pending}
            onClick={() => {
              const key = newKey.trim();
              if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
                onError("Variable names must start with a letter or underscore.");
                return;
              }
              if (existingKeys.includes(key) || Object.hasOwn(added, key)) {
                onError("That variable already exists. Replace or remove it above.");
                return;
              }
              setAdded((prev) => ({ ...prev, [key]: newValue }));
              setNewKey("");
              setNewValue("");
            }}
          >
            Add variable
          </button>
        </div>
      </section>
      <label className="rw-check">
        <input type="checkbox" checked={disabled} onChange={(event) => setDisabled(event.target.checked)} disabled={pending} />
        Start disabled
      </label>
      <div className="rw-summary" aria-live="polite">
        <strong>Summary before saving</strong>
        <p>
          {(editing ? existing?.name : name.trim()) || "unnamed"} · {command.trim() || "no command"} · layer{" "}
          {snapshot?.targetLayer || "unknown"}
        </p>
        <p className="rw-note">Only changed fields are written as targeted updates; everything else is preserved and verified.</p>
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
        <button
          type="button"
          className="rw-button rw-primary"
          onClick={() => void save()}
          disabled={pending || problems.length > 0 || (editing && emptyEdit)}
        >
          {pending ? "Saving…" : editing ? "Save changes" : "Add server"}
        </button>
      </div>
    </div>
  );
}
