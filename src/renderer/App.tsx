import { useCallback, useEffect, useRef, useState } from "react";
import { Mark, Entry, CallbackCard } from "./components";
import {
  ArrowUp,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleHelp,
  Code2,
  Command,
  Folder,
  FolderOpen,
  GitBranch,
  LoaderCircle,
  MessageSquare,
  Moon,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Square,
  Sun,
  Terminal,
  Workflow,
  X,
} from "lucide-react";
import type {
  HistoryEntry,
  Preferences,
  RpcEvent,
  Runtime,
  Session,
  SessionState,
  Setup,
  Status,
} from "./types";
import { reduceEvent } from "./projection.ts";

const bridge = window.vibe;
const basename = (path: string) =>
  path
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .at(-1) || path;
const pretty = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);
const text = (entry: HistoryEntry) =>
  entry.text ||
  entry.content
    ?.filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n\n") ||
  "";

export function App() {
  const [status, setStatus] = useState<Status>({ state: "connecting" });
  const [version, setVersion] = useState("");
  const [setup, setSetup] = useState<Setup | null>(null);
  const [preferences, setPreferences] = useState<Preferences>({
    theme: "light",
    recentProjects: [],
  });
  const [project, setProject] = useState("");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [state, setState] = useState<SessionState | null>(null);
  const stateRef = useRef<SessionState | null>(null);
  const resyncing = useRef(false);
  const bufferedEvents = useRef<RpcEvent[]>([]);
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [pendingCallbacks, setPendingCallbacks] = useState<HistoryEntry[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [working, setWorking] = useState(false);
  const [settings, setSettings] = useState(false);
  const [key, setKey] = useState("");
  const [mode, setMode] = useState("");
  const [panel, setPanel] = useState<"activity" | "changes" | "environment">(
    "activity",
  );
  const [panelOpen, setPanelOpen] = useState(true);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [shellDraft, setShellDraft] = useState("");
  const [review, setReview] = useState<any>({ files: [] });
  const [diff, setDiff] = useState<{
    path: string;
    baseline: string;
    current: string;
  } | null>(null);
  const [worktrees, setWorktrees] = useState<any[]>([]);
  const [trust, setTrust] = useState<any>(null);
  const pendingOpen = useRef<{ cwd: string; sessionId?: string } | null>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const settingsModal = useRef<HTMLElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const turn = state?.turns?.at(-1);
  const running = turn?.status === "in_progress";
  const lastStatus = turn?.status;
  const adopt = useCallback((next: SessionState | null) => {
    stateRef.current = next;
    setState(next);
    setPendingCallbacks(next?.activeCallbacks || []);
  }, []);

  const request = useCallback(
    async <T,>(
      method: string,
      params: Record<string, unknown> = {},
    ): Promise<T> => {
      if (!bridge)
        throw new Error("Open Vibe Desktop to connect to the local engine.");
      return bridge.request<T>(method, params);
    },
    [],
  );
  const protect = async (action: () => Promise<void>) => {
    setError("");
    setWorking(true);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  };
  const listSessions = useCallback(async () => {
    const result = await request<{ items: Session[] }>("session/list", {
      limit: 100,
    });
    setSessions(result.items || []);
  }, [request]);
  const refreshRuntime = useCallback(
    async (sessionId: string) => {
      const result = await request<{ runtime: Runtime }>("runtime/read", {
        sessionId,
      });
      if (stateRef.current?.session.id === sessionId)
        setRuntime(result.runtime);
    },
    [request],
  );
  const loadReview = useCallback(
    async (sessionId: string) => {
      try {
        const result = await request<any>("review/state", { sessionId });
        if (stateRef.current?.session.id === sessionId) setReview(result);
      } catch (error) {
        if (stateRef.current?.session.id !== sessionId) return;
        const message = error instanceof Error ? error.message : String(error);
        setReview({
          files: [],
          unavailable: /method[_ ]not[_ ]found|not[_ ]implemented/i.test(
            message,
          )
            ? "This Vibe engine does not support change review yet. File operations are visible in Activity."
            : `Could not load changes: ${message}`,
        });
        setDiff(null);
      }
    },
    [request],
  );
  const reload = useCallback(async () => {
    const current = stateRef.current;
    if (!current || resyncing.current) return;
    resyncing.current = true;
    try {
      const result = await request<{ state: SessionState }>("session/read", {
        sessionId: current.session.id,
      });
      if (stateRef.current?.session.id !== current.session.id) return;
      let next = result.state;
      for (const event of bufferedEvents.current)
        next = reduceEvent(next, event);
      adopt(next);
      setNotice("Session refreshed from Vibe.");
    } catch (e) {
      setError(
        `Session refresh failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      resyncing.current = false;
      bufferedEvents.current = [];
    }
  }, [request, adopt]);

  useEffect(() => {
    if (!bridge) {
      setStatus({
        state: "disconnected",
        message: "Desktop runtime unavailable in browser preview.",
      });
      return;
    }
    const offStatus = bridge.onStatus((next) => {
      setStatus(next);
      if (
        (next.state === "disconnected" || next.state === "error") &&
        stateRef.current
      ) {
        adopt(null);
        setRuntime(null);
        bufferedEvents.current = [];
        setNotice(
          "Connection closed. Select a saved session to continue. Your draft is preserved.",
        );
      }
    });
    const offEvents = bridge.onEvent((event) => {
      if (event.method === "callback/call") {
        const callback = event.params.callback;
        setPendingCallbacks((previous) => [
          ...previous.filter((item) => item.callbackId !== callback.callbackId),
          callback,
        ]);
        return;
      }
      if (event.method === "server/error") {
        setError(
          event.params.error?.message ||
            event.params.message ||
            "Vibe reported an error.",
        );
        return;
      }
      if (!stateRef.current) return;
      if (resyncing.current) {
        bufferedEvents.current.push(event);
        return;
      }
      try {
        const next = reduceEvent(stateRef.current, event);
        if (next !== stateRef.current) adopt(next);
      } catch {
        bufferedEvents.current.push(event);
        void reload();
      }
    });
    (async () => {
      const stored = await bridge.readPreferences();
      setPreferences(stored);
      const result = await bridge.connect();
      setVersion(result.serverInfo.version);
      setSetup(result.setup);
      setStatus({ state: "ready" });
      await listSessions();
    })().catch((e) => {
      setStatus({ state: "error", message: e.message });
      setError(e.message);
    });
    return () => {
      offStatus();
      offEvents();
    };
  }, [adopt, listSessions, reload]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () =>
      (document.documentElement.dataset.theme =
        preferences.theme === "system"
          ? media.matches
            ? "dark"
            : "light"
          : preferences.theme);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [preferences.theme]);
  useEffect(() => {
    if (!settings || !settingsModal.current) return;
    const modal = settingsModal.current;
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () =>
      Array.from(
        modal.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex="0"]',
        ),
      ).filter((element) => element.offsetParent !== null);
    (focusable()[0] || modal).focus();
    const keepFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const elements = focusable();
      const first = elements[0];
      const last = elements.at(-1);
      if (!first || !last) {
        event.preventDefault();
        modal.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    modal.addEventListener("keydown", keepFocus);
    return () => {
      modal.removeEventListener("keydown", keepFocus);
      if (previous?.isConnected) previous.focus();
    };
  }, [settings]);
  useEffect(() => {
    if (atBottom.current && transcript.current)
      transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [state?.eventId, pendingCallbacks]);
  useEffect(() => {
    if (state && !running && lastStatus) {
      void refreshRuntime(state.session.id).catch(() => {});
      void listSessions().catch(() => {});
      void loadReview(state.session.id);
    }
  }, [
    lastStatus,
    state?.session.id,
    refreshRuntime,
    listSessions,
    loadReview,
    request,
    running,
  ]);

  const savePreferences = async (next: Preferences) => {
    setPreferences(next);
    if (bridge) await bridge.savePreferences(next);
  };
  const openSession = async (
    cwd: string,
    sessionId?: string,
    credentialsAvailable = setup?.hasApiKey,
  ) => {
    if (running)
      throw new Error("Stop the current turn before switching sessions.");
    if (status.state !== "ready")
      throw new Error("Connect the Vibe engine first.");
    pendingOpen.current = { cwd, sessionId };
    setProject(cwd);
    if (!credentialsAvailable) {
      setSettings(true);
      return;
    }
    if (stateRef.current)
      await request("session/stop", { sessionId: stateRef.current.session.id });
    adopt(null);
    setRuntime(null);
    setReview({ files: [] });
    setDiff(null);
    setNotice("");
    const trustResult = await request<any>("workspace/trust/status", { cwd });
    setTrust(trustResult);
    const result = await request<{ state: SessionState }>(
      sessionId ? "session/resume" : "session/start",
      sessionId
        ? { sessionId, agentConfig: { cwd } }
        : { agentConfig: { cwd, ...(mode ? { agent: mode } : {}) } },
    );
    if (!trustResult.details) pendingOpen.current = null;
    adopt(result.state);
    await refreshRuntime(result.state.session.id);
    await listSessions();
    request<any>("workspace/git/worktrees/list", { cwd, includeDetails: true })
      .then((result) => setWorktrees(result.items || result.worktrees || []))
      .catch(() => setWorktrees([]));
    composer.current?.focus();
  };
  const chooseProject = () =>
    protect(async () => {
      if (!bridge) throw new Error("Launch the desktop app to open a folder.");
      const cwd = await bridge.chooseProject();
      if (!cwd) return;
      await savePreferences({
        ...preferences,
        recentProjects: [
          cwd,
          ...preferences.recentProjects.filter((path) => path !== cwd),
        ].slice(0, 12),
      });
      await openSession(cwd);
    });
  const send = () =>
    protect(async () => {
      const current = stateRef.current;
      if (
        !current ||
        !draft.trim() ||
        trust?.details ||
        status.state !== "ready"
      )
        return;
      const prompt = draft;
      if (running) {
        await request("turn/steer", {
          sessionId: current.session.id,
          expectedTurnId: turn!.id,
          message: [{ type: "text", text: prompt }],
          idempotencyKey: crypto.randomUUID(),
        });
      } else {
        await request("turn/start", {
          sessionId: current.session.id,
          message: [{ type: "text", text: prompt }],
          idempotencyKey: crypto.randomUUID(),
        });
      }
      setDraft("");
      setNotice("");
    });
  const interrupt = () =>
    protect(async () => {
      if (state && turn && running)
        await request("turn/interrupt", {
          sessionId: state.session.id,
          expectedTurnId: turn.id,
        });
    });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        if (!working && !settings) void chooseProject();
      } else if (event.ctrlKey && event.key === "Enter") {
        event.preventDefault();
        if (!working && !settings) void send();
      } else if (event.key === "Escape") {
        if (settings) setSettings(false);
        else if (running) void interrupt();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const operations =
    state?.history?.filter((entry) => entry.type === "effect") || [];
  const callbacks = pendingCallbacks.filter(
    (entry, index, all) =>
      all.findIndex((item) => item.callbackId === entry.callbackId) === index,
  );
  const isDark =
    preferences.theme === "dark" ||
    (preferences.theme === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  const renderStatus =
    status.state === "ready"
      ? running
        ? "Working"
        : callbacks.length
          ? "Waiting for you"
          : "Ready"
      : status.state === "connecting"
        ? "Connecting"
        : "Disconnected";

  return (
    <div className={`app ${panelOpen ? "with-panel" : ""}`}>
      <aside className="rail">
        <div className="brand">
          <Mark />
          <strong>Vibe Desktop</strong>
        </div>
        <div className="community-label">
          COMMUNITY <span>WINDOWS</span>
        </div>
        <button
          className="open-project"
          onClick={() => void chooseProject()}
          disabled={working || running}
        >
          <Plus size={16} />
          Open project<kbd>Ctrl O</kbd>
        </button>
        <div className="rail-label">Your projects</div>
        <nav className="projects" aria-label="Projects and sessions">
          {preferences.recentProjects.length === 0 && (
            <p className="rail-empty">Your local work starts here.</p>
          )}
          {preferences.recentProjects.map((cwd) => (
            <section key={cwd} className="project-group">
              <button
                className={`project-row ${project === cwd ? "selected" : ""}`}
                title={cwd}
                onClick={() => void protect(() => openSession(cwd))}
                disabled={working || running}
              >
                <Folder size={15} />
                <span>{basename(cwd)}</span>
                <ChevronDown size={13} />
              </button>
              {sessions
                .filter(
                  (session) =>
                    session.cwd?.replaceAll("\\", "/").toLowerCase() ===
                    cwd.replaceAll("\\", "/").toLowerCase(),
                )
                .map((session) => (
                  <button
                    className={`session-row ${state?.session.id === session.id ? "active" : ""}`}
                    data-session-id={session.id}
                    key={session.id}
                    title={
                      session.title || session.preview || "Untitled session"
                    }
                    onClick={() =>
                      void protect(() => openSession(cwd, session.id))
                    }
                    disabled={working || running}
                  >
                    <MessageSquare size={13} />
                    <span>
                      {session.title || session.preview || "Untitled session"}
                    </span>
                  </button>
                ))}
              {project === cwd && (
                <button
                  className="new-session"
                  onClick={() => void protect(() => openSession(cwd))}
                  disabled={working || running}
                >
                  <Plus size={12} />
                  New session
                </button>
              )}
            </section>
          ))}
        </nav>
        <footer className="rail-footer">
          <button onClick={() => setSettings(true)}>
            <Settings2 size={16} />
            Settings
          </button>
          <div className="engine-status">
            <span className={`status-dot ${status.state}`} />
            <span>Vibe engine {version && <small>{version}</small>}</span>
          </div>
        </footer>
      </aside>
      <header className="workspace-header">
        <div>
          <div className="breadcrumbs">
            <Code2 size={15} />
            {project ? basename(project) : "Workspace"}
            {state && (
              <>
                <ChevronRight size={12} />
                <span>{state.session.title || "New session"}</span>
              </>
            )}
          </div>
          <small title={project}>
            {project || "Choose a local project to begin"}
          </small>
        </div>
        <div className="header-actions">
          <button
            className="icon-button"
            aria-label="Toggle theme"
            onClick={() =>
              void savePreferences({
                ...preferences,
                theme:
                  document.documentElement.dataset.theme === "dark"
                    ? "light"
                    : "dark",
              })
            }
          >
            {isDark ? <Sun size={17} /> : <Moon size={17} />}
          </button>
          <button
            className={`icon-button ${terminalOpen ? "selected" : ""}`}
            aria-label="Toggle shell"
            onClick={() => setTerminalOpen(!terminalOpen)}
          >
            <Terminal size={17} />
          </button>
          <button
            className="icon-button"
            aria-label="Toggle context panel"
            onClick={() => setPanelOpen(!panelOpen)}
          >
            {panelOpen ? (
              <PanelRightClose size={17} />
            ) : (
              <PanelRightOpen size={17} />
            )}
          </button>
        </div>
      </header>
      <main className="workspace" data-session-id={state?.session.id}>
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button aria-label="Dismiss error" onClick={() => setError("")}>
              <X size={14} />
            </button>
          </div>
        )}
        {trust?.details && (
          <section className="trust-card">
            <ShieldCheck />
            <div>
              <strong>Review this project's Vibe configuration</strong>
              <p>
                Vibe found local configuration. Trust it to load the project's
                tools, skills and settings.
              </p>
              <ul>
                {(trust.details.detectedFiles || []).map((file: string) => (
                  <li key={file}>{file}</li>
                ))}
              </ul>
              <div className="button-row">
                {(trust.details.availableDecisions || []).map(
                  (decision: string) => (
                    <button
                      key={decision}
                      className={
                        decision === "trust_cwd" ? "primary" : "secondary"
                      }
                      disabled={working || !state || status.state !== "ready"}
                      onClick={() =>
                        void protect(async () => {
                          const current = stateRef.current;
                          if (!current) return;
                          await request("workspace/trust/decision", {
                            sessionId: current.session.id,
                            cwd: current.session.cwd,
                            decision,
                          });
                          setTrust(null);
                          if (decision === "decline") {
                            pendingOpen.current = null;
                            setNotice(
                              "Continuing without project configuration.",
                            );
                          } else {
                            // Vibe 2.26.1 caches project trust when its config layer starts.
                            // Resume existing history; a new empty session has no journal yet.
                            await openSession(
                              current.session.cwd || project,
                              pendingOpen.current?.sessionId,
                            );
                          }
                          composer.current?.focus();
                        })
                      }
                    >
                      {decision === "trust_cwd"
                        ? "Trust this project"
                        : decision === "trust_repo"
                          ? "Trust this repository"
                          : decision === "decline"
                            ? "Continue without project config"
                            : decision}
                    </button>
                  ),
                )}
                <button
                  className="secondary"
                  disabled={working}
                  onClick={() =>
                    void protect(async () => {
                      if (stateRef.current)
                        await request("session/stop", {
                          sessionId: stateRef.current.session.id,
                        });
                      setTrust(null);
                      pendingOpen.current = null;
                      setProject("");
                      setWorktrees([]);
                    })
                  }
                >
                  Close project
                </button>
              </div>
            </div>
          </section>
        )}
        <div
          className="transcript"
          ref={transcript}
          onScroll={() => {
            if (transcript.current)
              atBottom.current =
                transcript.current.scrollHeight -
                  transcript.current.scrollTop -
                  transcript.current.clientHeight <
                80;
          }}
        >
          {!state?.history?.length ? (
            <section className="welcome">
              <Mark large />
              <p className="eyebrow">Your code. Your workspace.</p>
              <h1>
                {state ? "What are we building?" : "Make room for good code."}
              </h1>
              <p>
                {state
                  ? "Describe the outcome. Vibe will work in your local project."
                  : "Your local projects. Mistral's coding engine. One focused workspace."}
              </p>
              {!state && (
                <>
                  <button
                    className="primary"
                    disabled={working || status.state !== "ready"}
                    onClick={() => void chooseProject()}
                  >
                    <FolderOpen size={16} />
                    Open a project
                    <ArrowUpRight size={15} />
                  </button>
                  <small>Ctrl+O · Open project</small>
                </>
              )}
              <div className="welcome-ideas">
                <div>
                  <Code2 size={18} />
                  <span>
                    Build something
                    <br />
                    <small>From idea to working code</small>
                  </span>
                </div>
                <div>
                  <Workflow size={18} />
                  <span>
                    Explore a codebase
                    <br />
                    <small>Find the shape of your project</small>
                  </span>
                </div>
                <div>
                  <GitBranch size={18} />
                  <span>
                    Review a change
                    <br />
                    <small>See what needs attention</small>
                  </span>
                </div>
              </div>
            </section>
          ) : (
            <div className="conversation">
              {state.historyBeforeCursor && (
                <button
                  className="history-more"
                  disabled={working || running}
                  onClick={() =>
                    void protect(async () => {
                      const sessionId = state.session.id;
                      const response = await request<any>(
                        "session/history/list",
                        {
                          sessionId: state.session.id,
                          page: {
                            cursor: state.historyBeforeCursor,
                            limit: 100,
                            direction: "backward",
                          },
                        },
                      );
                      const current = stateRef.current;
                      if (current?.session.id !== sessionId) return;
                      const entries: HistoryEntry[] = [
                        ...(response.items || response.entries || []),
                        ...(current.history || []),
                      ];
                      adopt({
                        ...current,
                        history: entries.filter(
                          (entry, index) =>
                            entries.findIndex(
                              (item) => item.id === entry.id,
                            ) === index,
                        ),
                        historyBeforeCursor: response.previousCursor || null,
                      });
                    })
                  }
                >
                  Load earlier messages
                </button>
              )}
              {state.history.map((entry) => (
                <Entry key={entry.id} entry={entry} />
              ))}
            </div>
          )}
        </div>
        <div className="composer-area">
          {callbacks.map((entry) => (
            <CallbackCard
              key={entry.callbackId}
              entry={entry}
              onAnswer={async (output) => {
                await request("callback/result", {
                  sessionId: entry.sessionId,
                  result: { callbackId: entry.callbackId, output },
                });
                setPendingCallbacks((previous) =>
                  previous.filter(
                    (item) => item.callbackId !== entry.callbackId,
                  ),
                );
              }}
            />
          ))}
          {notice && (
            <p className="notice" role="status">
              {notice}
            </p>
          )}
          {turn?.error && <p className="error-text">{turn.error.message}</p>}
          <div className={`composer ${running ? "running" : ""}`}>
            <textarea
              ref={composer}
              aria-label="Prompt"
              placeholder={
                state
                  ? "Describe what you want to build, explore or fix…"
                  : "Open a project to start working…"
              }
              value={draft}
              disabled={
                !state ||
                working ||
                !!trust?.details ||
                status.state !== "ready"
              }
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.ctrlKey
                ) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            <div className="composer-toolbar">
              <label className="mode-picker">
                <ShieldCheck size={13} />
                <select
                  aria-label="Agent mode"
                  value={runtime?.activeAgent.name || mode}
                  disabled={working || running}
                  onChange={(event) => {
                    const agentName = event.target.value;
                    setMode(agentName);
                    if (state)
                      void protect(async () => {
                        const result = await request<any>(
                          "session/agent/update",
                          { sessionId: state.session.id, agentName },
                        );
                        setRuntime(result.runtime);
                      });
                  }}
                >
                  {(
                    runtime?.agents.filter(
                      (agent) => agent.agentType !== "subagent",
                    ) || [
                      { name: "" },
                      { name: "ask" },
                      { name: "plan" },
                      { name: "accept-edits" },
                    ]
                  ).map((agent) => (
                    <option key={agent.name} value={agent.name}>
                      {agent.name === ""
                        ? "Default from Vibe"
                        : agent.name === "ask"
                          ? "Ask before tools"
                          : agent.name === "plan"
                            ? "Plan"
                            : agent.name === "accept-edits"
                              ? "Accept edits"
                              : agent.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="model-picker">
                <select
                  aria-label="Model"
                  value={runtime?.config.activeModel.alias || ""}
                  disabled={!state || working || running}
                  onChange={(event) =>
                    void protect(async () => {
                      const result = await request<any>("config/model/write", {
                        sessionId: state!.session.id,
                        modelAlias: event.target.value,
                      });
                      setRuntime(result.runtime);
                    })
                  }
                >
                  {runtime?.config.models.map((model) => (
                    <option key={model.alias} value={model.alias}>
                      {model.displayName || model.alias}
                    </option>
                  )) || <option value="">Model from Vibe</option>}
                </select>
              </label>
              <span className="composer-spacer" />
              {running && (
                <button
                  className="icon-button stop-button"
                  aria-label="Stop turn"
                  title="Stop · Escape"
                  onClick={() => void interrupt()}
                >
                  <Square size={14} />
                </button>
              )}
              <button
                className="send-button"
                aria-label={running ? "Steer turn" : "Send prompt"}
                title={running ? "Steer the current turn" : "Send · Ctrl+Enter"}
                disabled={
                  !state || !draft.trim() || working || status.state !== "ready"
                }
                onClick={() => void send()}
              >
                <ArrowUp size={19} />
              </button>
            </div>
          </div>
          <div className="composer-meta">
            <span>
              <span
                className={`status-dot ${running ? "working" : status.state}`}
              />
              {renderStatus}
            </span>
            <span>
              {state?.session.tokenUsage
                ? `${state.session.tokenUsage.totalTokens.toLocaleString()} tokens`
                : "Powered by Mistral Vibe"}
              <span className="meta-divider">·</span>Enter to send
              <span className="meta-divider">·</span>Shift+Enter for a new line
            </span>
          </div>
        </div>
        {terminalOpen && (
          <section className="shell-panel">
            <header>
              <span>
                <Terminal size={14} />
                Project shell
              </span>
              <button
                className="icon-button"
                aria-label="Close shell"
                onClick={() => setTerminalOpen(false)}
              >
                <X size={14} />
              </button>
            </header>
            <div className="shell-output">
              {operations
                .filter((entry) =>
                  ["shell", "process"].includes(entry.detail?.kind),
                )
                .map((entry) => (
                  <div key={entry.id}>
                    <strong>{entry.title}</strong>
                    <pre>
                      {entry.state?.outputText ||
                        entry.state?.error?.message ||
                        entry.state?.status}
                    </pre>
                  </div>
                ))}
              {!operations.length && (
                <p>Commands run in your session through Vibe.</p>
              )}
            </div>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void protect(async () => {
                  await request("session/shellCommand", {
                    sessionId: state!.session.id,
                    command: shellDraft,
                    action: "run",
                    timeoutSeconds: 30,
                  });
                  setShellDraft("");
                });
              }}
            >
              <span>›</span>
              <input
                aria-label="Shell command"
                placeholder="Run a command in this project…"
                disabled={!state || running || working}
                value={shellDraft}
                onChange={(event) => setShellDraft(event.target.value)}
              />
              <button
                disabled={!state || !shellDraft.trim() || running || working}
              >
                <ArrowUp size={15} />
              </button>
            </form>
          </section>
        )}
      </main>
      {panelOpen && (
        <aside className="context-panel">
          <div
            className="panel-tabs"
            role="tablist"
            aria-label="Workspace context"
          >
            {(["activity", "changes", "environment"] as const).map((tab) => (
              <button
                key={tab}
                role="tab"
                aria-selected={panel === tab}
                className={panel === tab ? "active" : ""}
                onClick={() => {
                  setPanel(tab);
                  if (tab === "changes" && state)
                    void protect(() => loadReview(state.session.id));
                }}
              >
                {tab === "activity"
                  ? "Activity"
                  : tab === "changes"
                    ? "Changes"
                    : "Environment"}
              </button>
            ))}
          </div>
          {panel === "activity" && (
            <div className="panel-content">
              <div className="panel-section-title">
                Agent activity <span>{operations.length || ""}</span>
              </div>
              {!operations.length && (
                <div className="panel-empty">
                  <Workflow size={24} />
                  <p>A clear view of the work.</p>
                  <small>
                    Tool calls and agent operations appear here as Vibe runs.
                  </small>
                </div>
              )}
              {operations.map((entry) => (
                <div className="activity-row" key={entry.id}>
                  <span
                    className={`status-dot ${entry.state?.status === "completed" ? "ready" : "working"}`}
                  />
                  <div>
                    <strong>{entry.title || entry.detail?.toolName}</strong>
                    <small>
                      {entry.state?.status}
                      {entry.state?.durationMs
                        ? ` · ${(entry.state.durationMs / 1000).toFixed(1)}s`
                        : ""}
                    </small>
                  </div>
                </div>
              ))}
              {state?.childSessions.length ? (
                <>
                  <div className="panel-section-title">Subagents</div>
                  {state.childSessions.map((child) => (
                    <div className="activity-row" key={child.id}>
                      <Workflow size={14} />
                      <div>
                        <strong>{child.name}</strong>
                        <small>
                          {child.agentType} · {child.status.type}
                        </small>
                      </div>
                    </div>
                  ))}
                </>
              ) : null}
              <div className="engine-note">
                <Mark />
                <strong>One engine. Your workspace.</strong>
                <p>Sessions, tools and permissions run through Mistral Vibe.</p>
              </div>
            </div>
          )}
          {panel === "changes" && (
            <div className="panel-content">
              <div className="panel-section-title">
                Session changes <span>{review.files?.length || ""}</span>
              </div>
              {!review.files?.length && (
                <div className="panel-empty">
                  <GitBranch size={24} />
                  <p>
                    {review.unavailable
                      ? "Change review is unavailable."
                      : "No session changes yet."}
                  </p>
                  <small>
                    {review.unavailable ||
                      "Vibe's review tracks file changes made in this session."}
                  </small>
                </div>
              )}
              {review.files?.map((file: any) => (
                <button
                  className="change-row"
                  key={file.path}
                  disabled={!file.regions?.[0]?.owner}
                  title={
                    file.regions?.[0]?.owner
                      ? file.path
                      : "No review owner is available for this file"
                  }
                  onClick={() =>
                    void protect(async () => {
                      const result = await request<any>("review/turnDiff", {
                        sessionId: state!.session.id,
                        path: file.path,
                        owner: file.regions[0].owner,
                      });
                      setDiff({ path: file.path, ...result });
                    })
                  }
                >
                  <Code2 size={14} />
                  <span>{file.path}</span>
                  <small>{file.status}</small>
                </button>
              ))}
              {diff && (
                <div className="diff-preview">
                  <h3>{diff.path}</h3>
                  <details open>
                    <summary>Before</summary>
                    <pre>{diff.baseline}</pre>
                  </details>
                  <details open>
                    <summary>After</summary>
                    <pre>{diff.current}</pre>
                  </details>
                  <button
                    className="secondary"
                    onClick={() =>
                      void protect(async () => {
                        await request("review/approve", {
                          sessionId: state!.session.id,
                          target: { kind: "file", path: diff.path },
                        });
                        setReview(
                          await request("review/state", {
                            sessionId: state!.session.id,
                          }),
                        );
                        setDiff(null);
                      })
                    }
                  >
                    Keep this change
                  </button>
                </div>
              )}
            </div>
          )}
          {panel === "environment" && (
            <div className="panel-content">
              <div className="panel-section-title">Session environment</div>
              <dl>
                <dt>Engine</dt>
                <dd>Mistral Vibe {version || "—"}</dd>
                <dt>Runtime</dt>
                <dd>{state ? "Unified Harness" : "No active session"}</dd>
                <dt>Project</dt>
                <dd className="break-word">{project || "—"}</dd>
                <dt>Tools</dt>
                <dd>{runtime?.tools.length ?? "—"}</dd>
                <dt>Skills</dt>
                <dd>{runtime?.skills.length ?? "—"}</dd>
              </dl>
              {runtime?.skills.map((skill) => (
                <details key={skill.name}>
                  <summary>{skill.name}</summary>
                  <p>{skill.description}</p>
                </details>
              ))}
              {runtime?.issues?.map((issue, index) => (
                <p className="error-text" key={index}>
                  {issue.message}
                </p>
              ))}
              {worktrees.length > 0 && (
                <>
                  <div className="panel-section-title">Worktrees</div>
                  {worktrees.map((tree: any, index) => (
                    <div key={tree.path || index} className="activity-row">
                      <GitBranch size={14} />
                      <div>
                        <strong>{tree.branch || tree.name}</strong>
                        <small>{tree.path}</small>
                      </div>
                    </div>
                  ))}
                </>
              )}
              <button
                className="secondary"
                disabled={!state || working}
                onClick={() => void protect(reload)}
              >
                <RefreshCw size={13} />
                Refresh session
              </button>
            </div>
          )}
        </aside>
      )}
      {settings && (
        <div className="modal-backdrop">
          <section
            ref={settingsModal}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
            className="settings-modal"
          >
            <header>
              <div>
                <p className="eyebrow">Your workspace</p>
                <h2 id="settings-title">Settings</h2>
              </div>
              <button
                className="icon-button"
                aria-label="Close settings"
                onClick={() => setSettings(false)}
              >
                <X size={18} />
              </button>
            </header>
            <section>
              <h3>Vibe engine</h3>
              <div className="connection-summary">
                <span className={`status-dot ${status.state}`} />
                <strong>
                  {status.state === "ready"
                    ? `Connected · ${version}`
                    : status.state === "connecting"
                      ? "Connecting…"
                      : "Engine unavailable"}
                </strong>
              </div>
              {status.message && <p>{status.message}</p>}
              <p>
                Vibe Desktop uses the official app server. The Windows package
                includes its runtime.
              </p>
              {status.state !== "ready" && (
                <>
                  <button
                    className="secondary"
                    disabled={working || status.state === "connecting"}
                    onClick={() =>
                      void protect(async () => {
                        if (!bridge) return;
                        const result = await bridge.connect();
                        setVersion(result.serverInfo.version);
                        setSetup(result.setup);
                        await listSessions();
                      })
                    }
                  >
                    <RefreshCw size={14} />
                    Reconnect
                  </button>
                </>
              )}
            </section>
            <section>
              <h3>Mistral access</h3>
              <p>
                {setup?.hasApiKey
                  ? "Credentials are available to Vibe."
                  : "Add your Mistral API key or use credentials configured with the Vibe CLI."}
              </p>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void protect(async () => {
                    const result = await request<any>(
                      "setup/store-credential",
                      {
                        provider: setup?.provider.name || "mistral",
                        apiKey: key,
                      },
                    );
                    setKey("");
                    if (result.outcome !== "completed")
                      throw new Error(
                        `Vibe could not store the key: ${result.outcome}`,
                      );
                    const next = await request<Setup>("setup/status");
                    setSetup(next);
                    setNotice("Credentials stored by Vibe.");
                    if (project) {
                      setSettings(false);
                      await openSession(
                        project,
                        pendingOpen.current?.sessionId,
                        next.hasApiKey,
                      );
                    }
                  });
                }}
              >
                <label htmlFor="api-key">API key</label>
                <div className="key-entry">
                  <input
                    id="api-key"
                    type="password"
                    autoComplete="off"
                    value={key}
                    placeholder="Your Mistral API key"
                    onChange={(event) => setKey(event.target.value)}
                  />
                  <button
                    className="primary"
                    disabled={
                      !key.trim() || working || status.state !== "ready"
                    }
                  >
                    Save with Vibe
                  </button>
                </div>
              </form>
              <small>
                The key goes to Vibe's credential store. This app does not
                retain it.
              </small>
              <button
                className="text-button"
                onClick={() =>
                  void bridge?.openExternal("https://console.mistral.ai/")
                }
              >
                Open Mistral Studio
                <ArrowUpRight size={13} />
              </button>
            </section>
            <section>
              <h3>Appearance</h3>
              <div className="theme-options">
                {(["light", "dark", "system"] as const).map((theme) => (
                  <button
                    key={theme}
                    className={preferences.theme === theme ? "selected" : ""}
                    onClick={() =>
                      void savePreferences({ ...preferences, theme })
                    }
                  >
                    {theme === "light" ? (
                      <Sun size={15} />
                    ) : theme === "dark" ? (
                      <Moon size={15} />
                    ) : (
                      <Settings2 size={15} />
                    )}
                    <span>{theme}</span>
                  </button>
                ))}
              </div>
            </section>
            <section className="about">
              <Mark />
              <div>
                <strong>Vibe Desktop · Community edition</strong>
                <p>
                  Free and open source. An independent project for Mistral Vibe,
                  unaffiliated with Mistral AI.
                </p>
                <button
                  className="text-button"
                  onClick={() =>
                    void bridge?.openExternal(
                      "https://github.com/maikolsiragusaa/mistral-vibe-desktop",
                    )
                  }
                >
                  Source and documentation
                  <ArrowUpRight size={13} />
                </button>
              </div>
            </section>
            {error && (
              <p className="error-text" role="alert">
                {error}
              </p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
