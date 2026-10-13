import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Mark, Entry, CallbackCard } from "./components";
import { PixelCompanion, type CompanionState } from "./PixelCompanion";
import { ModelPicker } from "./components/ModelPicker";
import { ContextUsage } from "./ContextUsage";
import { PanelBoundary } from "./components/PanelBoundary";
import { McpStatus } from "./components/McpStatus";
import { ReasoningPicker } from "./components/ReasoningPicker";
import { ModePicker } from "./components/ModePicker";
import { SubagentView } from "./SubagentView";
import { LoopsPanel } from "./LoopsPanel";
import { CloudPanel } from "./CloudPanel";
import { WorkPanel } from "./WorkPanel";
import {
  clearStoredDrafts,
  hasStoredDrafts,
  isDraftPersistenceEnabled,
  loadDurableDrafts,
  loadLegacyDrafts,
  saveDurableDrafts,
  setDraftPersistenceEnabled,
} from "./drafts";
import { CompactMenuItem } from "./CompactMenuItem";
import {
  adoptDiscoveredCapabilities,
  forgetSession,
  getCapability,
  isUnsupportedError,
  noteSessionRuntime,
  setCapability,
  setRuntimeIdentity,
} from "./capabilities";
import "./desktop.css";
import {
  ArrowUp,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleHelp,
  Cloud,
  Code2,
  Command,
  Briefcase,
  Copy,
  Folder,
  FolderOpen,
  GitBranch,
  GitFork,
  History,
  LoaderCircle,
  MessageSquare,
  Moon,
  PanelRightClose,
  PanelRightOpen,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Square,
  Sun,
  Terminal,
  Timer,
  Trash2,
  Workflow,
  X,
  Search,
  Pin,
  Archive,
  Paperclip,
  Layers,
  Eye,
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
import {
  connectionLimitExplanation,
  describeSessionTab,
  emptyTabUiState,
  type TabUiState,
} from "./session-tabs";
import { NoticeDeduper, buildNotice } from "./notifications";

const bridge = window.vibe;
const GitWorkspace = lazy(() =>
  import("./GitWorkspace").then((module) => ({ default: module.GitWorkspace })),
);
const ResourceWindow = lazy(() =>
  import("./ResourceWindow").then((module) => ({
    default: module.ResourceWindow,
  })),
);
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
type Attachment = {
  id: string;
  name: string;
  mime: string;
  kind: "image" | "text";
  content: string;
  size: number;
};

export function App() {
  const [status, setStatus] = useState<Status>({ state: "connecting" });
  const [version, setVersion] = useState("");
  const versionRef = useRef("");
  const [setup, setSetup] = useState<Setup | null>(null);
  const [preferences, setPreferences] = useState<Preferences>({
    theme: "light",
    recentProjects: [],
  });
  const [project, setProject] = useState("");
  const projectRef = useRef("");
  projectRef.current = project;
  const [sessions, setSessions] = useState<Session[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const includeArchived = useRef(false);
  const gitBaselines = useRef(new Map<string, string[]>());
  const sessionCache = useRef(new Map<string, SessionState>());
  const sessionDrafts = useRef(new Map<string, string>());
  const promptHistory = useRef(new Map<string, string[]>());
  const tabUi = useRef(new Map<string, TabUiState>());
  const noticeDeduper = useRef(new NoticeDeduper());
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;
  const openSessionRef = useRef<((cwd: string, sessionId?: string) => Promise<void>) | null>(null);
  const [sessionQuery, setSessionQuery] = useState("");
  const [view, setView] = useState<"chat" | "git">("chat");
  const [area, setArea] = useState<"code" | "work">("code");
  const [codeScope, setCodeScope] = useState<"local" | "cloud">("local");
  const [loopsOpen, setLoopsOpen] = useState(false);
  const [subagentNav, setSubagentNav] = useState<{
    parentId: string;
    parentTitle: string;
    childId: string;
    childName: string;
    childTask?: string | null;
  } | null>(null);
  const [durableDrafts, setDurableDrafts] = useState(() =>
    isDraftPersistenceEnabled(),
  );
  const [resourcesOpen, setResourcesOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [queueMode, setQueueMode] = useState(false);
  const [configView, setConfigView] = useState<any>(null);
  const [effectiveConfig, setEffectiveConfig] = useState<any>(null);
  const [authState, setAuthState] = useState<any>(null);
  const [authLinks, setAuthLinks] = useState<any[]>([]);
  const [verifiedModels, setVerifiedModels] = useState<string[]>([]);
  const [pendingModel, setPendingModel] = useState<{
    alias: string;
    reasoning?: string;
  } | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [, setBackgroundRevision] = useState(0);
  const [childTranscript, setChildTranscript] = useState<SessionState | null>(
    null,
  );
  const attachmentDrafts = useRef(new Map<string, Attachment[]>());
  const fileInput = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<SessionState | null>(null);
  const stateRef = useRef<SessionState | null>(null);
  const resyncing = useRef(false);
  const bufferedEvents = useRef<RpcEvent[]>([]);
  const backgroundResync = useRef(new Map<string, RpcEvent[]>());
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const resourceSessionId = state?.session.id;
  const acceptResourceRuntime = useCallback(
    (next: Runtime) => {
      if (stateRef.current?.session.id === resourceSessionId) setRuntime(next);
    },
    [resourceSessionId],
  );
  const acceptResourceError = useCallback(
    (message: string) => {
      if (stateRef.current?.session.id === resourceSessionId) setError(message);
    },
    [resourceSessionId],
  );
  const [pendingCallbacks, setPendingCallbacks] = useState<HistoryEntry[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [working, setWorking] = useState(false);
  const actionInFlight = useRef(false);
  const [settings, setSettings] = useState(false);
  const [key, setKey] = useState("");
  const [mode, setMode] = useState("");
  const [panel, setPanel] = useState<"activity" | "changes" | "environment">(
    "activity",
  );
  const [panelOpen, setPanelOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(true);
  const [railWidth, setRailWidth] = useState(238);
  const [panelWidth, setPanelWidth] = useState(290);
  const [draggingSidebar, setDraggingSidebar] = useState(false);
  const sidebarDrag = useRef<{
    side: "left" | "right";
    startX: number;
    startWidth: number;
  } | null>(null);
  const dragSidebar = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = sidebarDrag.current;
    if (!drag) return;
    const delta = event.clientX - drag.startX;
    const raw = drag.startWidth + (drag.side === "left" ? delta : -delta);
    const other =
      drag.side === "left"
        ? panelOpen
          ? panelWidth
          : 0
        : railOpen
          ? railWidth
          : 0;
    const width = Math.max(
      180,
      Math.min(raw, 440, window.innerWidth - other - 380),
    );
    if (drag.side === "left") {
      setRailOpen(raw >= 112);
      if (raw >= 112) setRailWidth(width);
    } else {
      setPanelOpen(raw >= 112);
      if (raw >= 112) setPanelWidth(width);
    }
  };
  const sidebarHandle = (side: "left" | "right") => (
    <div
      className={`sidebar-resizer sidebar-resizer-${side}`}
      role="separator"
      aria-label={
        side === "left" ? "Resize project sidebar" : "Resize context sidebar"
      }
      aria-orientation="vertical"
      tabIndex={0}
      aria-valuemin={0}
      aria-valuemax={440}
      aria-valuenow={
        side === "left"
          ? railOpen
            ? railWidth
            : 0
          : panelOpen
            ? panelWidth
            : 0
      }
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        sidebarDrag.current = {
          side,
          startX: event.clientX,
          startWidth:
            side === "left"
              ? railOpen
                ? railWidth
                : 0
              : panelOpen
                ? panelWidth
                : 0,
        };
        setDraggingSidebar(true);
      }}
      onPointerMove={dragSidebar}
      onPointerUp={(event) => {
        sidebarDrag.current = null;
        setDraggingSidebar(false);
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onLostPointerCapture={() => {
        sidebarDrag.current = null;
        setDraggingSidebar(false);
      }}
      onDoubleClick={() =>
        side === "left" ? setRailOpen(!railOpen) : setPanelOpen(!panelOpen)
      }
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          side === "left" ? setRailOpen(!railOpen) : setPanelOpen(!panelOpen);
        }
        if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
        event.preventDefault();
        const change =
          (event.key === "ArrowRight" ? 20 : -20) * (side === "left" ? 1 : -1);
        if (side === "left") {
          setRailOpen(true);
          setRailWidth((width) => Math.max(180, Math.min(440, width + change)));
        } else {
          setPanelOpen(true);
          setPanelWidth((width) =>
            Math.max(180, Math.min(440, width + change)),
          );
        }
      }}
    />
  );
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
  const commandModal = useRef<HTMLElement>(null);
  const childModal = useRef<HTMLElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const turn = state?.turns?.at(-1);
  const running = turn?.status === "in_progress";
  const lastStatus = turn?.status;
  const adopt = useCallback((next: SessionState | null) => {
    if (next) sessionCache.current.set(next.session.id, next);
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
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setError("");
    setWorking(true);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      actionInFlight.current = false;
      setWorking(false);
    }
  };
  const listSessions = useCallback(async () => {
    const result = await request<{ items: Session[] }>("session/list", {
      limit: 100,
      includeArchived: includeArchived.current,
    });
    let items = result.items || [];
    try {
      const leases = await request<{
        held: { sessionId: string; leaseHolder: Session["leaseHolder"] }[];
      }>("session/lease/subscribe", {});
      const holders = new Map(
        leases.held.map((entry) => [entry.sessionId, entry.leaseHolder]),
      );
      items = items.map((session) => ({
        ...session,
        leaseHolder: holders.get(session.id) || null,
      }));
    } catch {
      /* Saved sessions remain readable when lease watching is unavailable. */
    }
    setSessions(items);
  }, [request]);
  const refreshRuntime = useCallback(
    async (sessionId: string) => {
      const result = await request<{ runtime: Runtime }>("runtime/read", {
        sessionId,
      });
      // Official discovery when the engine advertises it: adopt only
      // verified entries, never unsupported-from-registry.
      try {
        const advertised = (result.runtime as unknown as Record<string, unknown>)
          ?.capabilities;
        const currentVersion = versionRef.current || undefined;
        adoptDiscoveredCapabilities(sessionId, advertised, currentVersion);
        if (currentVersion) noteSessionRuntime(sessionId, currentVersion);
      } catch {
        /* Discovery is opportunistic; unknown stays unknown. */
      }
      if (stateRef.current?.session.id === sessionId)
        setRuntime(result.runtime);
      try {
        const config = await request<any>("config/effective/read", {
          sessionId,
        });
        if (stateRef.current?.session.id === sessionId)
          setEffectiveConfig(config.config || config);
      } catch {
        /* Runtime selection remains available without optional metadata. */
      }
    },
    [request],
  );
  const loadReview = useCallback(
    async (sessionId: string) => {
      // review/* is a family: a cached review/state verdict gates the whole
      // group so sessions on engines without support never fire doomed
      // requests on every open (Unified 2.26.1: method_not_found).
      if (getCapability(sessionId, "review/state") === "unsupported") {
        if (stateRef.current?.session.id === sessionId)
          setReview({
            files: [],
            unavailable:
              "This Vibe engine does not support change review yet. File operations are visible in Activity.",
          });
        return;
      }
      try {
        const result = await request<any>("review/state", { sessionId });
        setCapability(sessionId, "review/state", "verified");
        if (stateRef.current?.session.id === sessionId) setReview(result);
      } catch (error) {
        if (stateRef.current?.session.id !== sessionId) return;
        const message = error instanceof Error ? error.message : String(error);
        const unsupported = isUnsupportedError(message);
        if (unsupported) setCapability(sessionId, "review/state", "unsupported");
        setReview({
          files: [],
          unavailable: unsupported
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
      if (
        (next as any).sessionId &&
        (next as any).sessionId !== stateRef.current?.session.id
      ) {
        if (["disconnected", "error"].includes(next.state)) {
          sessionCache.current.delete((next as any).sessionId);
          setBackgroundRevision((revision) => revision + 1);
        }
        return;
      }
      setStatus(next);
      if (
        (next.state === "disconnected" || next.state === "error") &&
        stateRef.current
      ) {
        sessionCache.current.delete(stateRef.current.session.id);
        adopt(null);
        setRuntime(null);
        bufferedEvents.current = [];
        setNotice(
          "Connection closed. Select a saved session to continue. Your draft is preserved.",
        );
      }
    });
    const offEvents = bridge.onEvent((event) => {
      if (event.method === "session/lease/updated") {
        setSessions((old) =>
          old.map((session) =>
            session.id === event.params.sessionId
              ? { ...session, leaseHolder: event.params.leaseHolder }
              : session,
          ),
        );
        return;
      }
      if (event.method === "session/lease/ended") {
        setSessions((old) =>
          old.map(({ leaseHolder: _holder, ...session }) => session),
        );
        return;
      }
      if (event.params.authLink) {
        setAuthLinks((old) =>
          [
            ...old.filter((link) => link.id !== event.params.authLink.id),
            event.params.authLink,
          ].slice(-10),
        );
        return;
      }
      const notificationsOn = preferencesRef.current.notificationsEnabled !== false;
      const maybeNotify = (kind: "task-done" | "loop-failed" | "approval-waiting" | "backend-error" | "result-available", sessionId: string | null | undefined) => {
        if (!notificationsOn || !sessionId || !bridge?.notify) return;
        const notice = buildNotice(kind, sessionId);
        if (!noticeDeduper.current.shouldShow(notice)) return;
        void bridge.notify(notice).catch(() => {});
      };
      if (event.method === "callback/call") {
        const callback = event.params.callback;
        maybeNotify("approval-waiting", callback.sessionId);
        if (callback.sessionId !== stateRef.current?.session.id) {
          const cached = sessionCache.current.get(callback.sessionId);
          if (cached)
            sessionCache.current.set(callback.sessionId, {
              ...cached,
              activeCallbacks: [
                ...cached.activeCallbacks.filter(
                  (item) => item.callbackId !== callback.callbackId,
                ),
                callback,
              ],
            });
          setBackgroundRevision((revision) => revision + 1);
          return;
        }
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
        maybeNotify("backend-error", event.params.sessionId);
        return;
      }
      if (event.method === "turn/failed") {
        maybeNotify("loop-failed", event.params.sessionId);
      }
      if (event.method === "turn/completed") {
        const sid = event.params.sessionId || event.params.state?.session?.id;
        if (sid && sid !== stateRef.current?.session.id) maybeNotify("task-done", sid);
      }
      const eventSessionId =
        event.params.sessionId || event.params.state?.session?.id;
      if (eventSessionId && eventSessionId !== stateRef.current?.session.id) {
        const cached = sessionCache.current.get(eventSessionId);
        if (cached) {
          const pending = backgroundResync.current.get(eventSessionId);
          if (pending) {
            pending.push(event);
            return;
          }
          try {
            sessionCache.current.set(
              eventSessionId,
              reduceEvent(cached, event),
            );
          } catch {
            const events = [event];
            backgroundResync.current.set(eventSessionId, events);
            void request<any>("session/read", { sessionId: eventSessionId })
              .then((result) => {
                if (!sessionCache.current.has(eventSessionId)) return;
                let next = result.state;
                for (const buffered of events) {
                  try {
                    next = reduceEvent(next, buffered);
                  } catch {
                    break;
                  }
                }
                const current = sessionCache.current.get(eventSessionId);
                if (next.eventId >= (current?.eventId || 0))
                  sessionCache.current.set(eventSessionId, next);
                setBackgroundRevision((revision) => revision + 1);
              })
              .catch(() => {})
              .finally(() => backgroundResync.current.delete(eventSessionId));
          }
        }
        if (event.method === "turn/completed") void listSessions();
        if (["turn/started", "turn/completed"].includes(event.method))
          setBackgroundRevision((revision) => revision + 1);
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
      versionRef.current = result.serverInfo.version ?? "";
      // Bind capability cache to this runtime instance/version.
      setRuntimeIdentity(
        `${result.serverInfo.name ?? "vibe"}@${result.serverInfo.version ?? "unknown"}`,
      );
      setSetup(result.setup);
      setStatus({ state: "ready" });
      await listSessions();
    })().catch((e) => {
      setStatus({ state: "error", message: e.message });
      setError(e.message);
    });
    const offNotice = bridge.onNoticeClick?.((payload) => {
      const sid = payload?.sessionId;
      if (typeof sid === "string" && sessionCache.current.has(sid)) {
        const cached = sessionCache.current.get(sid);
        const opener = openSessionRef.current;
        if (opener) void protect(() => opener(cached?.session.cwd || projectRef.current, sid));
      }
    }) ?? (() => {});
    return () => {
      offStatus();
      offEvents();
      offNotice();
    };
  }, [adopt, listSessions, reload]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const theme =
        preferences.theme === "system"
          ? media.matches
            ? "dark"
            : "light"
          : preferences.theme;
      document.documentElement.dataset.theme = theme;
      void bridge?.setWindowTheme(theme).catch(() => {});
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [preferences.theme]);
  useEffect(() => {
    document.documentElement.dataset.motion =
      preferences.motion === false ? "off" : "on";
  }, [preferences.motion]);
  useEffect(() => {
    // Hydrate durable drafts once; in-memory drafts always work without opt-in.
    // Pre-M1.1 installs may hold legacy drafts with no opt-in record: surface
    // them for this run without silently deleting or re-enabling persistence.
    const durable = loadDurableDrafts();
    for (const [key, value] of durable) sessionDrafts.current.set(key, value);
    if (durable.size === 0) {
      const legacy = loadLegacyDrafts();
      if (legacy.size > 0) {
        for (const [key, value] of legacy) {
          if (!sessionDrafts.current.has(key))
            sessionDrafts.current.set(key, value);
        }
        setNotice(
          `Draft persistence is now opt-in and off. ${legacy.size} previous draft(s) kept for this run only — enable it in Settings to keep them across restarts, or clear stored drafts.`,
        );
      }
    }
  }, []);
  useEffect(() => {
    if (state?.session.id) {
      sessionDrafts.current.set(state.session.id, draft);
      attachmentDrafts.current.set(state.session.id, attachments);
      if (durableDrafts) saveDurableDrafts(sessionDrafts.current);
    }
  }, [draft, attachments, state?.session.id, durableDrafts]);
  useEffect(() => {
    if (!palette || !commandModal.current) return;
    const modal = commandModal.current;
    const previous = document.activeElement as HTMLElement | null;
    modal.querySelector<HTMLInputElement>("input")?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const elements = Array.from(
        modal.querySelectorAll<HTMLElement>("input,button:not([disabled])"),
      );
      const first = elements[0];
      const last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    modal.addEventListener("keydown", trap);
    return () => {
      modal.removeEventListener("keydown", trap);
      if (previous?.isConnected) previous.focus();
    };
  }, [palette]);
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
    if (!childTranscript || !childModal.current) return;
    const modal = childModal.current;
    const previous = document.activeElement as HTMLElement | null;
    const controls = () => [
      ...modal.querySelectorAll<HTMLElement>(
        'button, summary, a[href], [tabindex="0"]',
      ),
    ];
    controls()[0]?.focus();
    const trap = (event: KeyboardEvent) => {
      const items = controls();
      if (event.key === "Tab" && items.length) {
        if (event.shiftKey && document.activeElement === items[0]) {
          event.preventDefault();
          items.at(-1)?.focus();
        } else if (!event.shiftKey && document.activeElement === items.at(-1)) {
          event.preventDefault();
          items[0].focus();
        }
      }
    };
    modal.addEventListener("keydown", trap);
    return () => {
      modal.removeEventListener("keydown", trap);
      if (previous?.isConnected) previous.focus();
    };
  }, [childTranscript?.session.id]);
  useEffect(() => {
    if (atBottom.current && transcript.current)
      transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [state?.eventId, pendingCallbacks]);
  useEffect(() => {
    if (state && !running && lastStatus) {
      void refreshRuntime(state.session.id).catch(() => {});
      if (
        lastStatus === "completed" &&
        state.history?.some((entry) => entry.role === "assistant")
      )
        setVerifiedModels((old) =>
          runtime?.config.activeModel.alias
            ? [...new Set([...old, runtime.config.activeModel.alias])]
            : old,
        );
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
    if (status.state !== "ready")
      throw new Error("Connect the Vibe engine first.");
    // Race guard for rapid tab switches: only the newest openSession may
    // adopt its result. A slower earlier call returns stale without touching
    // the current session, draft, panel or pending state.
    const myOpen = { cwd, sessionId };
    pendingOpen.current = myOpen;
    if (stateRef.current) {
      sessionDrafts.current.set(stateRef.current.session.id, draft);
      attachmentDrafts.current.set(stateRef.current.session.id, attachments);
      if (durableDrafts) saveDurableDrafts(sessionDrafts.current);
      // M3: preserve per-tab visual context (scroll, inspector, worktree).
      // History itself stays with Vibe; only the view state is cached.
      tabUi.current.set(stateRef.current.session.id, {
        scrollTop: transcript.current?.scrollTop ?? 0,
        inspector: panel,
        openFile: null,
        showStagedDiff: false,
        draft,
        worktreePath: stateRef.current.session.cwd ?? null,
      });
      noticeDeduper.current.clearSession(stateRef.current.session.id);
    }
    setProject(cwd);
    setView("chat");
    setSubagentNav(null);
    setArea("code");
    setCodeScope("local");
    if (!gitBaselines.current.has(cwd)) {
      try {
        const status = await bridge?.git<any>("status", { projectPath: cwd });
        if (status)
          gitBaselines.current.set(
            cwd,
            status.files.map((file: any) => file.path),
          );
      } catch {
        /* Git is optional for a selected folder. */
      }
    }
    try {
      const config = await request<any>("config/read", { cwd });
      setConfigView(config.config || config);
    } catch {
      setConfigView(null);
    }
    if (!credentialsAvailable) {
      setSettings(true);
      return;
    }
    adopt(null);
    setRuntime(null);
    setReview({ files: [] });
    setDiff(null);
    setNotice("");
    setEffectiveConfig(null);
    const trustResult = await request<any>("workspace/trust/status", { cwd });
    setTrust(trustResult);
    const result = await request<{ state: SessionState }>(
      sessionId ? "session/resume" : "session/start",
      sessionId
        ? { sessionId, agentConfig: { cwd } }
        : { agentConfig: { cwd, ...(mode ? { agent: mode } : {}) } },
    );
    if (pendingOpen.current !== myOpen) return;
    if (!trustResult.details) pendingOpen.current = null;
    adopt(result.state);
    if (pendingModel) {
      await request("config/model/write", {
        sessionId: result.state.session.id,
        modelAlias: pendingModel.alias,
        ...(pendingModel.reasoning
          ? { reasoningEffort: pendingModel.reasoning }
          : {}),
      });
      setPendingModel(null);
    }
    setDraft(
      sessionDrafts.current.get(result.state.session.id) ||
        sessionDrafts.current.get(`project:${cwd}`) ||
        tabUi.current.get(result.state.session.id)?.draft ||
        "",
    );
    const savedUi = tabUi.current.get(result.state.session.id);
    if (savedUi?.inspector) setPanel(savedUi.inspector as "activity" | "changes" | "environment");
    setAttachments(attachmentDrafts.current.get(result.state.session.id) || []);
    // Restore scroll after the transcript renders.
    requestAnimationFrame(() => {
      if (transcript.current && savedUi) transcript.current.scrollTop = savedUi.scrollTop;
      else transcript.current?.scrollTo?.(0, 0);
    });
    await refreshRuntime(result.state.session.id);
    await listSessions();
    request<any>("workspace/git/worktrees/list", { cwd, includeDetails: true })
      .then((result) => setWorktrees(result.items || result.worktrees || []))
      .catch(() => setWorktrees([]));
    composer.current?.focus();
  };
  openSessionRef.current = openSession;
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
        (!draft.trim() && !attachments.length) ||
        trust?.details ||
        status.state !== "ready"
      )
        return;
      const prompt = draft;
      const message: any[] = [
        ...(prompt.trim() ? [{ type: "text", text: prompt }] : []),
        ...attachments.map((attachment) =>
          attachment.kind === "image"
            ? {
                type: "image",
                attachment: {
                  source: { kind: "inline", data: attachment.content },
                  alias: attachment.name,
                  mimeType: attachment.mime,
                },
              }
            : {
                type: "resource",
                resource: {
                  kind: "text",
                  uri: `urn:vibe-desktop:attachment:${attachment.id}`,
                  mediaType: attachment.mime,
                  text: attachment.content,
                },
              },
        ),
      ];
      if (running && queueMode) {
        const content = [
          ...(prompt.trim() ? [{ type: "text", text: prompt }] : []),
          ...attachments.map((attachment) =>
            attachment.kind === "image"
              ? {
                  type: "image",
                  uri: `data:${attachment.mime};base64,${attachment.content}`,
                  mediaType: attachment.mime,
                  altText: attachment.name,
                }
              : {
                  type: "embedded_resource",
                  uri: `urn:vibe-desktop:attachment:${attachment.id}`,
                  mediaType: attachment.mime,
                  text: attachment.content,
                },
          ),
        ];
        await request("session/turn/enqueue", {
          sessionId: current.session.id,
          entries: [{ role: "user", content }],
          idempotencyKey: crypto.randomUUID(),
        });
        setNotice("Prompt queued by Vibe.");
      } else if (running) {
        await request("turn/steer", {
          sessionId: current.session.id,
          expectedTurnId: turn!.id,
          message,
          idempotencyKey: crypto.randomUUID(),
        });
      } else {
        await request("turn/start", {
          sessionId: current.session.id,
          message,
          idempotencyKey: crypto.randomUUID(),
        });
      }
      if (stateRef.current?.session.id === current.session.id) {
        setDraft("");
        setAttachments([]);
      }
      attachmentDrafts.current.delete(current.session.id);
      sessionDrafts.current.set(current.session.id, "");
      promptHistory.current.set(
        current.session.id,
        [
          ...(promptHistory.current.get(current.session.id) || []),
          prompt,
        ].slice(-30),
      );
      setNotice("");
    });
  const addAttachments = async (files: File[]) => {
    const attachmentSessionId = stateRef.current?.session.id;
    setError("");
    try {
      if (!state)
        throw new Error("Open a project session before attaching files.");
      if (attachments.length + files.length > 6)
        throw new Error("Attach up to six files per prompt.");
      if (
        attachments.reduce((sum, item) => sum + item.size, 0) +
          files.reduce((sum, file) => sum + file.size, 0) >
        8 * 1024 * 1024
      )
        throw new Error("Attachments must total 8 MiB or less.");
      const additions: Attachment[] = [];
      for (const file of files) {
        const image = ["image/png", "image/jpeg", "image/webp"].includes(
          file.type,
        );
        if (image && runtime?.config.activeModel.supportsImages === false)
          throw new Error(
            "The active model does not accept images. Choose an image-capable model.",
          );
        if (
          !image &&
          !file.type.startsWith("text/") &&
          file.type !== "application/json" &&
          !/\.(txt|md|json|csv|log|py|js|jsx|ts|tsx|css|html|yaml|yml|toml|rs|go|java|c|cpp|h)$/i.test(
            file.name,
          )
        )
          throw new Error(
            `Unsupported attachment: ${file.name}. Use text files, PNG, JPEG or WebP.`,
          );
        if (!image && file.size > 256 * 1024)
          throw new Error("Text attachments must be 256 KiB or smaller.");
        const bytes = new Uint8Array(await file.arrayBuffer());
        let content: string;
        if (image) {
          let binary = "";
          for (let index = 0; index < bytes.length; index += 8192)
            binary += String.fromCharCode(
              ...bytes.subarray(index, index + 8192),
            );
          content = btoa(binary);
        } else
          content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        additions.push({
          id: crypto.randomUUID(),
          name: file.name.replace(/[\\/]/g, "_").slice(0, 240),
          mime: image ? file.type : "text/plain",
          kind: image ? "image" : "text",
          content,
          size: file.size,
        });
      }
      if (stateRef.current?.session.id === attachmentSessionId)
        setAttachments((old) => [...old, ...additions]);
      else if (attachmentSessionId)
        attachmentDrafts.current.set(attachmentSessionId, [
          ...(attachmentDrafts.current.get(attachmentSessionId) || []),
          ...additions,
        ]);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };
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
      if (event.isComposing || (event.defaultPrevented && !palette)) return;
      if (resourcesOpen) return;
      if (event.ctrlKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPalette((open) => !open);
        return;
      }
      if (event.ctrlKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        if (!working && !settings) void chooseProject();
      } else if (event.ctrlKey && event.key === "Enter") {
        event.preventDefault();
        if (!working && !settings) void send();
      } else if (event.key === "Escape") {
        if (palette) setPalette(false);
        else if (childTranscript) setChildTranscript(null);
        else if (settings) setSettings(false);
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
  const companionState: CompanionState =
    status.state === "error" || status.state === "disconnected"
      ? "error"
      : callbacks.length
        ? "waiting"
        : running
          ? operations.some((entry) => entry.state?.status === "running")
            ? "working"
            : "thinking"
          : lastStatus === "completed"
            ? "completed"
            : "idle";
  const modelMetadata =
    runtime?.config.models.map((model) => {
      const configuredModels = Array.isArray(effectiveConfig?.models)
        ? effectiveConfig.models
        : Object.values(effectiveConfig?.models || {});
      const configured = configuredModels.find(
        (item: any) => item.alias === model.alias || item.name === model.name,
      );
      return {
        ...configured,
        ...model,
        provider: configured?.provider || model.provider,
      };
    }) || [];
  const commands = [
    {
      title: "Open project",
      detail: "Choose a local folder",
      action: () => void chooseProject(),
    },
    {
      title: "Show conversation",
      detail: "Return to the active chat",
      action: () => setView("chat"),
    },
    {
      title: "Git workspace",
      detail: "Diff, staging and local commits",
      action: () => setView("git"),
    },
    {
      title: "Resources",
      detail: "MCP, skills, providers and diagnostics",
      action: () => setResourcesOpen(true),
    },
    {
      title: "Choose a model",
      detail: "Search the configured Vibe inventory",
      action: () =>
        document
          .querySelector<HTMLButtonElement>(
            '.composer-picker-trigger[aria-label^="Model:"]',
          )
          ?.click(),
    },
    {
      title: "Settings",
      detail: "Access and appearance",
      action: () => setSettings(true),
    },
    {
      title: "Code workspace",
      detail: "Local sessions and cloud sandboxes",
      action: () => {
        setArea("code");
        setCodeScope("local");
        setView("chat");
      },
    },
    {
      title: "Cloud workspace",
      detail: "Vibe Code Web and Teleport",
      action: () => {
        setArea("code");
        setCodeScope("cloud");
      },
    },
    {
      title: "Work workspace",
      detail: "Hosted Mistral Work surface",
      action: () => setArea("work"),
    },
    {
      title: "Scheduled loops",
      detail: "Create and manage loops for this session",
      action: () => setLoopsOpen(true),
    },
    ...(state
      ? [
          {
            title: "Fork this session",
            detail: "Create an attached copy via session/fork",
            action: () =>
              void protect(async () => {
                const result = await request<{ state: SessionState }>(
                  "session/fork",
                  {
                    sourceSessionId: state.session.id,
                    attach: true,
                    idempotencyKey: crypto.randomUUID(),
                  },
                );
                adopt(result.state);
                await refreshRuntime(result.state.session.id);
                await listSessions();
              }),
          },
          {
            title: "Mark session as seen",
            detail: "Clear attention state",
            action: () =>
              void protect(async () => {
                await request("session/markAsSeen", {
                  sessionId: state.session.id,
                });
                await listSessions();
              }),
          },
        ]
      : []),
    ...sessions
      .filter((session) => session.cwd)
      .slice(0, 30)
      .map((session) => ({
        title: session.title || session.preview || "Untitled session",
        detail: basename(session.cwd!),
        action: () => void protect(() => openSession(session.cwd!, session.id)),
      })),
  ].filter((command) =>
    `${command.title} ${command.detail}`
      .toLowerCase()
      .includes(paletteQuery.toLowerCase()),
  );
  const isDark =
    preferences.theme === "dark" ||
    (preferences.theme === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  const liveOperation = [...operations]
    .reverse()
    .find((entry) => ["running", "pending"].includes(entry.state?.status));
  const isResponding = state?.history?.some(
    (entry) =>
      entry.type === "message" &&
      entry.role === "assistant" &&
      entry.generationStatus === "in_progress",
  );
  const renderStatus =
    status.state === "ready"
      ? callbacks.length
        ? "Waiting for you"
        : running
          ? liveOperation?.detail?.display?.statusText ||
            liveOperation?.title ||
            (isResponding ? "Responding" : "Thinking")
          : "Ready"
      : status.state === "connecting"
        ? "Connecting"
        : "Disconnected";

  return (
    <div
      className={`app ${panelOpen ? "with-panel" : ""} ${draggingSidebar ? "is-resizing" : ""}`}
      style={
        {
          "--left-sidebar-width": `${railOpen ? railWidth : 0}px`,
          "--right-sidebar-width": `${panelOpen ? panelWidth : 0}px`,
        } as CSSProperties
      }
    >
      <div className="desktop-titlebar">
        <div className="titlebar-safe">
          <span className="titlebar-brand">
            <Mark />
            Vibe Desktop
          </span>
          <button
            className="icon-button sidebar-toggle"
            aria-label={
              railOpen ? "Collapse project sidebar" : "Expand project sidebar"
            }
            aria-expanded={railOpen}
            onClick={() => setRailOpen((open) => !open)}
          >
            {railOpen ? (
              <PanelLeftClose size={15} />
            ) : (
              <PanelLeftOpen size={15} />
            )}
          </button>
          <span className="titlebar-project">
            {project ? basename(project) : "Local workspace"}
          </span>
          <div className="titlebar-modes" role="tablist" aria-label="Code or Work">
            <button
              role="tab"
              aria-selected={area === "code"}
              className={area === "code" ? "active" : ""}
              onClick={() => setArea("code")}
              title="Code: local projects, cloud sandboxes, sessions and automations"
            >
              <Code2 size={13} /> Code
            </button>
            <button
              role="tab"
              aria-selected={area === "work"}
              className={area === "work" ? "active" : ""}
              onClick={() => setArea("work")}
              title="Work: hosted Mistral Work surface (no local replica)"
            >
              <Briefcase size={13} /> Work
            </button>
          </div>
          <McpStatus
            runtime={runtime}
            onManage={() => setResourcesOpen(true)}
          />
          <button className="titlebar-command" onClick={() => setPalette(true)}>
            <Search size={13} />
            Search and commands<kbd>Ctrl K</kbd>
          </button>
        </div>
      </div>
      <aside className="rail" hidden={!railOpen}>
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
          disabled={working}
        >
          <Plus size={16} />
          Open project<kbd>Ctrl O</kbd>
        </button>
        <div className="rail-label">Your projects</div>
        <label className="session-search">
          <Search size={13} />
          <input
            aria-label="Search sessions"
            placeholder="Find a conversation"
            value={sessionQuery}
            onChange={(event) => setSessionQuery(event.target.value)}
          />
        </label>
        <button
          className="archive-filter"
          aria-pressed={showArchived}
          onClick={() => {
            includeArchived.current = !showArchived;
            setShowArchived(!showArchived);
            void listSessions().catch((error) => setError(error.message));
          }}
        >
          <Archive size={12} /> {showArchived ? "Hide archive" : "Show archive"}
        </button>
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
                disabled={working}
              >
                <Folder size={15} />
                <span>{basename(cwd)}</span>
                <ChevronDown size={13} />
              </button>
              {sessions
                .filter(
                  (session) =>
                    session.cwd?.replaceAll("\\", "/").toLowerCase() ===
                      cwd.replaceAll("\\", "/").toLowerCase() &&
                    (!sessionQuery ||
                      `${session.title || ""} ${session.preview || ""}`
                        .toLowerCase()
                        .includes(sessionQuery.toLowerCase())),
                )
                .sort(
                  (a, b) =>
                    (b.pinnedAt || 0) - (a.pinnedAt || 0) ||
                    b.updatedAt - a.updatedAt,
                )
                .map((session) => (
                  <div className="session-shelf-row" key={session.id}>
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
                      disabled={
                        working ||
                        Boolean(
                          session.leaseHolder &&
                          !sessionCache.current.has(session.id),
                        )
                      }
                    >
                      <MessageSquare size={13} />
                      <span>
                        {session.pinnedAt ? <Pin size={10} /> : null}
                        {session.title || session.preview || "Untitled session"}
                        {session.leaseHolder &&
                        !sessionCache.current.has(session.id) ? (
                          <small>
                            In use by another client
                            {session.leaseHolder.processId
                              ? ` · PID ${session.leaseHolder.processId}`
                              : ""}
                          </small>
                        ) : null}
                        {session.archivedAt ? <small>Archived</small> : null}
                      </span>
                    </button>
                    <div className="session-shelf-actions">
                      <button
                        aria-label={`${session.pinnedAt ? "Unpin" : "Pin"} session ${session.title || "Untitled session"}`}
                        disabled={working}
                        onClick={() =>
                          void protect(async () => {
                            await request("session/pin", {
                              sessionId: session.id,
                              pinned: !session.pinnedAt,
                            });
                            await listSessions();
                          })
                        }
                      >
                        <Pin size={12} />
                      </button>
                      <button
                        aria-label={`${session.archivedAt ? "Restore" : "Archive"} session ${session.title || "Untitled session"}`}
                        disabled={
                          working ||
                          Boolean(
                            session.leaseHolder &&
                            !sessionCache.current.has(session.id),
                          ) ||
                          sessionCache.current.get(session.id)?.turns?.at(-1)
                            ?.status === "in_progress"
                        }
                        onClick={() =>
                          void protect(async () => {
                            await request("session/archive", {
                              sessionId: session.id,
                              archived: !session.archivedAt,
                            });
                            if (
                              !session.archivedAt &&
                              sessionCache.current.has(session.id)
                            ) {
                              await request("session/stop", {
                                sessionId: session.id,
                              });
                              sessionCache.current.delete(session.id);
                              if (stateRef.current?.session.id === session.id) {
                                adopt(null);
                                setRuntime(null);
                              }
                            }
                            await listSessions();
                          })
                        }
                      >
                        <Archive size={12} />
                      </button>
                    </div>
                  </div>
                ))}
              {project === cwd && (
                <button
                  className="new-session"
                  onClick={() => void protect(() => openSession(cwd))}
                  disabled={working}
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
      {sidebarHandle("left")}
      {sidebarHandle("right")}
      <header className="workspace-header">
        <div>
          <div className="breadcrumbs">
            {area === "work" ? <Briefcase size={15} /> : <Code2 size={15} />}
            <button
              className="breadcrumb-root"
              title={project || "Workspace"}
              onClick={() => {
                setSubagentNav(null);
                setArea("code");
                setCodeScope("local");
                setView("chat");
              }}
            >
              {project ? basename(project) : "Workspace"}
            </button>
            {state && area === "code" && (
              <>
                <ChevronRight size={12} />
                <span>{state.session.title || "New session"}</span>
              </>
            )}
            {subagentNav && (
              <>
                <ChevronRight size={12} />
                <button
                  className="breadcrumb-parent"
                  onClick={() => setSubagentNav(null)}
                  title={`Back to ${subagentNav.parentTitle}`}
                >
                  {subagentNav.parentTitle}
                </button>
                <ChevronRight size={12} />
                <span aria-current="page">{subagentNav.childName}</span>
              </>
            )}
            {area === "work" && (
              <>
                <ChevronRight size={12} />
                <span>Work</span>
              </>
            )}
          </div>
          <small title={project}>
            {subagentNav
              ? `Subagent ${subagentNav.childId} · read-only · parent keeps working`
              : project || "Choose a local project to begin"}
          </small>
        </div>
        <div className="header-actions">
          {area === "code" && (
            <>
              <div className="workspace-modes" role="tablist" aria-label="Local or Cloud">
                <button
                  role="tab"
                  aria-selected={codeScope === "local"}
                  className={codeScope === "local" ? "active" : ""}
                  onClick={() => {
                    setCodeScope("local");
                    setView("chat");
                  }}
                >
                  Local
                </button>
                <button
                  role="tab"
                  aria-selected={codeScope === "cloud"}
                  className={codeScope === "cloud" ? "active" : ""}
                  onClick={() => setCodeScope("cloud")}
                >
                  <Cloud size={13} /> Cloud
                </button>
              </div>
              <button
                className={`workspace-tab ${loopsOpen ? "selected" : ""}`}
                aria-pressed={loopsOpen}
                disabled={!state}
                title="Scheduled loops for this session (loops/*)"
                onClick={() => setLoopsOpen((open) => !open)}
              >
                <Timer size={14} />
                Loops
              </button>
            </>
          )}
          <button
            className={`workspace-tab ${view === "git" ? "selected" : ""}`}
            aria-pressed={view === "git"}
            onClick={() =>
              setView((current) => (current === "git" ? "chat" : "git"))
            }
          >
            <GitBranch size={14} />
            Git
          </button>
          <button
            className={`workspace-tab ${resourcesOpen ? "selected" : ""}`}
            onClick={() => setResourcesOpen(true)}
          >
            <Layers size={14} />
            Resources
          </button>
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
          {state && (
            <details className="session-menu">
              <summary aria-label="Session actions">···</summary>
              <div className="session-menu-items" role="menu">
                <button
                  role="menuitem"
                  disabled={working || running}
                  onClick={() =>
                    void protect(async () => {
                      const title = window.prompt(
                        "Rename session",
                        state.session.title || "",
                      );
                      if (!title || !title.trim()) return;
                      await request("session/rename", {
                        sessionId: state.session.id,
                        title: title.trim().slice(0, 200),
                      });
                      await request("session/markAsSeen", {
                        sessionId: state.session.id,
                      }).catch(() => {});
                      await reload();
                      await listSessions();
                    })
                  }
                >
                  Rename
                </button>
                <button
                  role="menuitem"
                  disabled={working || running}
                  onClick={() =>
                    void protect(async () => {
                      const result = await request<{ state: SessionState }>(
                        "session/fork",
                        {
                          sourceSessionId: state.session.id,
                          attach: true,
                          idempotencyKey: crypto.randomUUID(),
                        },
                      );
                      adopt(result.state);
                      setDraft(
                        sessionDrafts.current.get(result.state.session.id) || "",
                      );
                      await refreshRuntime(result.state.session.id);
                      await listSessions();
                      setNotice("Session forked by Vibe.");
                    })
                  }
                >
                  <GitFork size={13} /> Fork session
                </button>
                <button
                  role="menuitem"
                  disabled={working || running || !state.history?.length}
                  onClick={() =>
                    void protect(async () => {
                      const firstId = state.history?.[0]?.id;
                      const entryId = window.prompt(
                        "Rewind to entry id (first entry prefilled). In-place is destructive; fork-rewind is safer.",
                        firstId || "",
                      );
                      if (!entryId) return;
                      const fork = window.confirm(
                        "OK = fork-rewind (new session, keeps history). Cancel = in-place rewind (destructive).",
                      );
                      const result = await request<{ state: SessionState }>(
                        "session/rewind",
                        {
                          sessionId: state.session.id,
                          entryId,
                          inplace: !fork,
                        },
                      );
                      if (result.state) {
                        if (!fork) {
                          sessionCache.current.delete(state.session.id);
                        }
                        adopt(result.state);
                        await refreshRuntime(result.state.session.id);
                        await listSessions();
                      }
                    })
                  }
                >
                  <History size={13} /> Rewind…
                </button>
                <button
                  role="menuitem"
                  disabled={working}
                  onClick={() =>
                    void protect(async () => {
                      await request("session/markAsSeen", {
                        sessionId: state.session.id,
                      });
                      await listSessions();
                      setNotice("Session marked as seen.");
                    })
                  }
                >
                  <Eye size={13} /> Mark as seen
                </button>
                <CompactMenuItem
                  disabled={working || running}
                  sessionId={state.session.id}
                  request={request}
                  onDone={() => void reload()}
                  onNotice={setNotice}
                  onError={setError}
                />
                <button
                  role="menuitem"
                  disabled={working || running}
                  onClick={() =>
                    void protect(async () => {
                      if (
                        !window.confirm(
                          "Stop this session? The transcript stays saved; running work ends.",
                        )
                      )
                        return;
                      await request("session/stop", {
                        sessionId: state.session.id,
                      });
                      sessionCache.current.delete(state.session.id);
                      forgetSession(state.session.id);
                      adopt(null);
                      setRuntime(null);
                      await listSessions();
                    })
                  }
                >
                  Stop session
                </button>
                <button
                  role="menuitem"
                  disabled={working || running}
                  onClick={() =>
                    void protect(async () => {
                      if (
                        !window.confirm(
                          "Delete this saved session? This removes it from Vibe storage. Stop it first if attached.",
                        )
                      )
                        return;
                      const id = state.session.id;
                      try {
                        await request("session/stop", { sessionId: id });
                      } catch {
                        /* Already detached: delete the stored session. */
                      }
                      sessionCache.current.delete(id);
                      await request("session/delete", { sessionId: id });
                      forgetSession(id);
                      adopt(null);
                      setRuntime(null);
                      await listSessions();
                    })
                  }
                >
                  <Trash2 size={13} /> Delete saved session
                </button>
                <button
                  role="menuitem"
                  disabled={!draft && !state.history?.length}
                  onClick={() => {
                    const blob = new Blob(
                      [
                        (state.history || [])
                          .map((e) => `## ${e.type} ${e.id}\n${text(e)}`)
                          .join("\n\n"),
                      ],
                      { type: "text/markdown" },
                    );
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `vibe-session-${state.session.id.slice(0, 8)}.md`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                >
                  <Copy size={13} /> Export transcript
                </button>
              </div>
            </details>
          )}
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
        {sessionCache.current.size > 0 && (
          <nav className="session-tabs" aria-label="Open sessions">
            {[...sessionCache.current.values()].map((cached) => {
              const tab = describeSessionTab({
                id: cached.session.id,
                title: cached.session.title,
                cwd: cached.session.cwd,
                branch: null,
                model: cached.session.model ?? runtime?.config.activeModel.alias ?? null,
                hasActiveTurn: cached.turns?.at(-1)?.status === "in_progress",
                hasPendingCallbacks: cached.activeCallbacks.length > 0,
                attached: true,
                leaseHeld: Boolean(cached.session.leaseHolder),
                terminated: false,
                childRunning: (cached.childSessions ?? []).filter((c) => c.status.type !== "idle").length,
                childWaiting: 0,
                detached: false,
                draftLength: (sessionDrafts.current.get(cached.session.id) ?? "").length,
              });
              return (
              <div
                className={
                  cached.session.id === state?.session.id ? "active" : ""
                }
                key={cached.session.id}
                data-tab-state={tab.state}
              >
                <button
                  title={tab.tooltip}
                  aria-label={`Switch to session ${tab.title} (${tab.state})`}
                  disabled={working}
                  onClick={() =>
                    void protect(() =>
                      openSession(
                        cached.session.cwd || project,
                        cached.session.id,
                      ),
                    )
                  }
                >
                  <span
                    className={`status-dot ${cached.turns?.at(-1)?.status === "in_progress" ? "working" : cached.activeCallbacks.length ? "error" : "ready"}`}
                  />
                  <span>{tab.title}</span>
                  {tab.shortCwd && <small className="tab-cwd">{tab.shortCwd}</small>}
                  {tab.model && <small className="tab-model">{tab.model}</small>}
                  {(cached.childSessions ?? []).length > 0 && (
                    <small className="tab-agents" title={`${(cached.childSessions ?? []).length} subagent(s)`}>
                      ×{(cached.childSessions ?? []).length}
                    </small>
                  )}
                  {cached.activeCallbacks.length > 0 && (
                    <small className="tab-badge" title="Waits for approval">approval</small>
                  )}
                  {cached.session.leaseHolder && (
                    <small className="tab-badge" title="Held by another client — read-only here">external</small>
                  )}
                </button>
                <button
                  aria-label={`Close session ${cached.session.title || "New session"} (keeps session running)`}
                  title="Close tab — the session keeps running and stays in the project list. Use Stop to end it."
                  disabled={working}
                  onClick={() =>
                    void protect(async () => {
                      const live =
                        sessionCache.current.get(cached.session.id) ?? cached;
                      if (live.turns?.at(-1)?.status === "in_progress")
                        throw new Error(
                          "Stop this turn before closing its tab. Closing never interrupts silently.",
                        );
                      if (stateRef.current?.session.id === cached.session.id) {
                        sessionDrafts.current.set(cached.session.id, draft);
                        if (durableDrafts) saveDurableDrafts(sessionDrafts.current);
                      }
                      const isEmpty =
                        !(live.history?.length || 0) &&
                        !(live.activeCallbacks?.length || 0);
                      sessionCache.current.delete(cached.session.id);
                      setBackgroundRevision((revision) => revision + 1);
                      if (stateRef.current?.session.id === cached.session.id)
                        adopt(null);
                      if (isEmpty) {
                        // An empty tab holds no work: stop it so crash-recovery
                        // checks see a single owner. Non-empty tabs stay running.
                        try {
                          await request("session/stop", {
                            sessionId: cached.session.id,
                          });
                        } catch {
                          /* Already detached: nothing to stop. */
                        }
                        setNotice("Empty tab closed.");
                      } else {
                        setNotice(
                          "Tab closed. The session keeps running — reopen it from the project list or stop it explicitly.",
                        );
                      }
                    })
                  }
                >
                  <X size={12} />
                </button>
              </div>
              );
            })}
          </nav>
        )}
        {sessionCache.current.size >= 4 && (
          <p className="notice-text" role="status" title={connectionLimitExplanation(sessionCache.current.size, 4)}>
            {connectionLimitExplanation(sessionCache.current.size, 4)}
          </p>
        )}
        {authLinks.length > 0 && (
          <div className="notice auth-notice" role="status">
            {authLinks.map((link) => (
              <div key={link.id}>
                <span>
                  {link.name || "MCP"} sign-in · {link.host}
                </span>
                <button
                  className="secondary"
                  onClick={() =>
                    void protect(async () => {
                      await bridge?.openAuthLink(link.id);
                      setAuthLinks((old) =>
                        old.filter((item) => item.id !== link.id),
                      );
                    })
                  }
                >
                  Open sign-in
                </button>
              </div>
            ))}
          </div>
        )}
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
                            await request("session/stop", {
                              sessionId: current.session.id,
                            });
                            sessionCache.current.delete(current.session.id);
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
        {subagentNav ? (
          <SubagentView
            parentTitle={subagentNav.parentTitle}
            childId={subagentNav.childId}
            childName={subagentNav.childName}
            childTask={subagentNav.childTask}
            onBack={() => setSubagentNav(null)}
          />
        ) : area === "work" ? (
          <WorkPanel onClose={() => setArea("code")} />
        ) : codeScope === "cloud" && area === "code" ? (
          <CloudPanel
            sessionId={state?.session.id ?? null}
            projectPath={project}
            activeModel={runtime?.config.activeModel.alias ?? null}
            models={(modelMetadata ?? []).map((m: any) => ({
              alias: String(m.alias ?? m.name ?? ""),
              provider: typeof m.provider === "string" ? m.provider : null,
            }))}
            hasApiKey={Boolean(setup?.hasApiKey)}
            backendReady={status.state === "ready"}
            disabled={working || running}
            onClose={() => setCodeScope("local")}
          />
        ) : view === "git" ? (
          <PanelBoundary name="Git workspace" onClose={() => setView("chat")}>
            <Suspense
              fallback={
                <div className="workspace-loading" role="status">
                  <LoaderCircle size={18} /> Opening Git workspace…
                </div>
              }
            >
              <GitWorkspace
                projectPath={project}
                onOpenSession={(cwd, sessionId) =>
                  void protect(() => openSession(cwd, sessionId))
                }
                initialPaths={gitBaselines.current.get(project)}
                agentPaths={operations
                  .filter((entry) => entry.detail?.kind === "file_write")
                  .map(
                    (entry) =>
                      entry.detail?.path ||
                      entry.detail?.input?.filePath ||
                      entry.detail?.input?.path ||
                      entry.detail?.input?.file_path,
                  )
                  .filter(Boolean)}
              />
            </Suspense>
          </PanelBoundary>
        ) : (
          <>
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
                  <div className="welcome-pixel-field" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                    <i />
                    <i />
                    <i />
                  </div>
                  {preferences.mascot !== false ? (
                    <PixelCompanion large state={companionState} />
                  ) : (
                    <Mark large />
                  )}
                  <p className="eyebrow">Your code. Your workspace.</p>
                  <h1>
                    {state
                      ? "What are we building?"
                      : "Make room for good code."}
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
                  {!state && preferences.recentProjects.length > 0 && (
                    <div className="recent-project-cards">
                      {preferences.recentProjects.slice(0, 3).map((cwd) => (
                        <button
                          key={cwd}
                          onClick={() => void protect(() => openSession(cwd))}
                        >
                          <Folder size={18} />
                          <strong>{basename(cwd)}</strong>
                          <small>{cwd}</small>
                          <ArrowUpRight size={14} />
                        </button>
                      ))}
                    </div>
                  )}
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
                            historyBeforeCursor:
                              response.previousCursor || null,
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
              {!!state?.turnQueue?.items.length && (
                <section className="prompt-queue" aria-label="Prompt queue">
                  <header>
                    <strong>
                      {state.turnQueue.items.length} queued prompt
                      {state.turnQueue.items.length === 1 ? "" : "s"}
                    </strong>
                    <span>
                      {state.turnQueue.paused
                        ? "Paused"
                        : "Runs after the active turn"}
                    </span>
                    {state.turnQueue.paused && (
                      <button
                        className="secondary"
                        disabled={working}
                        onClick={() =>
                          void protect(async () => {
                            await request("session/turn/queue/resume", {
                              sessionId: state.session.id,
                            });
                            await reload();
                          })
                        }
                      >
                        Resume queue
                      </button>
                    )}
                  </header>
                  {state.turnQueue.items.map((item) => (
                    <div key={item.id}>
                      <p>
                        {item.entries
                          ?.flatMap((entry) =>
                            entry.content
                              .filter((block) => block.type === "text")
                              .map((block) => block.text),
                          )
                          .join(" ") || "Queued attachments"}
                      </p>
                      <button
                        className="icon-button"
                        aria-label={`Remove queued prompt ${item.id}`}
                        disabled={working}
                        onClick={() =>
                          void protect(async () => {
                            await request("session/turn/queue/remove", {
                              sessionId: state.session.id,
                              queueItemId: item.id,
                            });
                            await reload();
                          })
                        }
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </section>
              )}
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
              {turn?.error && (
                <p className="error-text">{turn.error.message}</p>
              )}
              <div className={`composer ${running ? "running" : ""}`}>
                {attachments.length > 0 && (
                  <div className="attachment-list">
                    {attachments.map((attachment) => (
                      <div className="attachment-chip" key={attachment.id}>
                        {attachment.kind === "image" && (
                          <img
                            src={`data:${attachment.mime};base64,${attachment.content}`}
                            alt={attachment.name}
                          />
                        )}
                        <span>
                          {attachment.name}
                          <small>
                            {(attachment.size / 1024).toFixed(1)} KiB
                          </small>
                        </span>
                        <button
                          aria-label={`Remove attachment ${attachment.name}`}
                          onClick={() =>
                            setAttachments((old) =>
                              old.filter((item) => item.id !== attachment.id),
                            )
                          }
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <input
                  className="file-input"
                  ref={fileInput}
                  type="file"
                  multiple
                  aria-label="Attach files"
                  disabled={!state || working}
                  accept="image/png,image/jpeg,image/webp,text/*,.md,.json,.py,.js,.ts,.tsx,.rs,.go,.yaml,.toml"
                  onChange={(event) => {
                    void addAttachments(Array.from(event.target.files || []));
                    event.target.value = "";
                  }}
                />
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
                  onChange={(event) => {
                    setDraft(event.target.value);
                    if (stateRef.current)
                      sessionDrafts.current.set(
                        stateRef.current.session.id,
                        event.target.value,
                      );
                  }}
                  onPaste={(event) => {
                    const files = Array.from(event.clipboardData.files);
                    if (files.length) {
                      event.preventDefault();
                      void addAttachments(files);
                    }
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    void addAttachments(Array.from(event.dataTransfer.files));
                  }}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing || event.keyCode === 229)
                      return;
                    if (event.key === "ArrowUp" && !draft && state) {
                      const lastPrompt = promptHistory.current
                        .get(state.session.id)
                        ?.at(-1);
                      if (lastPrompt) {
                        event.preventDefault();
                        setDraft(lastPrompt);
                      }
                      return;
                    }
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
                  <button
                    className="icon-button"
                    aria-label="Add attachments"
                    disabled={!state || working || !!trust?.details}
                    onClick={() => fileInput.current?.click()}
                  >
                    <Paperclip size={15} />
                  </button>
                  <ModePicker
                    agents={
                      runtime?.agents.filter(
                        (agent) => agent.agentType !== "subagent",
                      ) || [
                        { name: "" },
                        { name: "ask" },
                        { name: "plan" },
                        { name: "accept-edits" },
                      ]
                    }
                    current={runtime?.activeAgent.name || mode}
                    disabled={working || running}
                    onSelect={(agentName) => {
                      setMode(agentName);
                      if (state)
                        return protect(async () => {
                          const result = await request<any>(
                            "session/agent/update",
                            {
                              sessionId: state.session.id,
                              agentName,
                            },
                          );
                          setRuntime(result.runtime);
                        });
                    }}
                  />
                  <ModelPicker
                    models={modelMetadata}
                    activeModel={runtime?.config.activeModel}
                    activeContextWindow={runtime?.contextWindow}
                    verifiedAliases={verifiedModels}
                    disabled={!state || working || running}
                    onSelect={(modelAlias, reasoningEffort) =>
                      protect(async () => {
                        const result = await request<any>(
                          "config/model/write",
                          {
                            sessionId: state!.session.id,
                            modelAlias,
                            ...(reasoningEffort ? { reasoningEffort } : {}),
                          },
                        );
                        setRuntime(result.runtime);
                      })
                    }
                  />
                  <span className="composer-spacer" />
                  {runtime?.config.activeModel.thinkingLevels?.length > 1 && (
                    <ReasoningPicker
                      levels={runtime?.config.activeModel.thinkingLevels || []}
                      current={runtime?.config.activeModel.thinking || "off"}
                      disabled={!state || working || running}
                      onSelect={(reasoningEffort) =>
                        protect(async () => {
                          const result = await request<any>(
                            "config/model/write",
                            {
                              sessionId: state!.session.id,
                              modelAlias: runtime!.config.activeModel.alias,
                              reasoningEffort,
                            },
                          );
                          setRuntime(result.runtime);
                        })
                      }
                    />
                  )}
                  {running && (
                    <button
                      className={`queue-toggle ${queueMode ? "selected" : ""}`}
                      aria-pressed={queueMode}
                      onClick={() => setQueueMode(!queueMode)}
                    >
                      {queueMode ? "Queue next" : "Steer"}
                    </button>
                  )}
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
                    aria-label={
                      running
                        ? queueMode
                          ? "Queue prompt"
                          : "Steer turn"
                        : "Send prompt"
                    }
                    title={
                      running ? "Steer the current turn" : "Send · Ctrl+Enter"
                    }
                    disabled={
                      !state ||
                      (!draft.trim() && !attachments.length) ||
                      working ||
                      status.state !== "ready"
                    }
                    onClick={() => void send()}
                  >
                    <ArrowUp size={19} />
                  </button>
                </div>
              </div>
              <div className="composer-meta">
                <span>
                  {preferences.mascot !== false && (
                    <PixelCompanion state={companionState} />
                  )}
                  <span
                    className={`status-dot ${running ? "working" : status.state}`}
                  />
                  <span
                    className={`activity-status ${running ? "is-active" : ""}`}
                    role="status"
                  >
                    {running && <LoaderCircle size={12} className="spin" />}
                    {renderStatus}
                  </span>
                </span>
                <ContextUsage runtime={runtime} state={state} />
                <span>
                  Enter to send
                  <span className="meta-divider">·</span>Shift+Enter for a new
                  line
                </span>
              </div>
            </div>
          </>
        )}
        {terminalOpen && !subagentNav && (
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
                  if (tab === "changes" && state) setView("git");
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
                  {state.childSessions.map((child) => {
                    const operation = operations.find(
                      (entry) => entry.detail?.childSessionId === child.id,
                    );
                    const task =
                      operation?.detail?.task ||
                      operation?.detail?.input?.task ||
                      operation?.detail?.input?.message ||
                      operation?.detail?.input?.prompt;
                    const completion = operations.find(
                      (entry) =>
                        entry.detail?.toolName === "subagent.wait" &&
                        entry.detail?.input?.agentName === child.name,
                    );
                    const childOutput =
                      operation?.state?.outputText ||
                      completion?.state?.output?.structured_content?.value;
                    const childElapsed =
                      operation?.state?.durationMs > 0
                        ? Number(operation?.state?.durationMs) / 1000
                        : child.status.type === "idle" &&
                            child.createdAt &&
                            child.updatedAt &&
                            child.updatedAt > child.createdAt
                          ? (child.updatedAt - child.createdAt) / 1000
                          : null;
                    return (
                      <div className="activity-row" key={child.id}>
                        <Workflow size={14} />
                        <div>
                          <strong>{child.name}</strong>
                          <small>
                            {child.agentType} · {child.status.type}
                          </small>
                          <small className="break-word">
                            Session {child.id}
                          </small>
                          {task && (
                            <p className="subagent-task">{String(task)}</p>
                          )}
                          {child.tokenUsage && (
                            <small>
                              {child.tokenUsage.inputTokens.toLocaleString()}{" "}
                              input ·{" "}
                              {child.tokenUsage.outputTokens.toLocaleString()}{" "}
                              output ·{" "}
                              {child.tokenUsage.totalTokens.toLocaleString()}{" "}
                              total tokens
                            </small>
                          )}
                          {childElapsed !== null && (
                            <small>{childElapsed.toFixed(1)}s elapsed</small>
                          )}
                          {childOutput && (
                            <details>
                              <summary>Agent output</summary>
                              <pre>
                                {typeof childOutput === "string"
                                  ? childOutput
                                  : JSON.stringify(childOutput, null, 2)}
                              </pre>
                            </details>
                          )}
                          {operation?.state?.error && (
                            <p className="error-text">
                              {operation.state.error.message}
                            </p>
                          )}
                          <div className="button-row">
                            <button
                              className="secondary"
                              aria-label={`Open subagent ${child.name}`}
                              title="Open the live subagent conversation. The parent keeps working."
                              onClick={() => {
                                if (!state) return;
                                setSubagentNav({
                                  parentId: state.session.id,
                                  parentTitle:
                                    state.session.title || "Parent session",
                                  childId: child.id,
                                  childName: child.name,
                                  childTask: task ? String(task) : null,
                                });
                                // Mark parent as seen without taking child control.
                                void request("session/markAsSeen", {
                                  sessionId: state.session.id,
                                }).catch(() => {});
                              }}
                            >
                              Open subagent
                            </button>
                            <button
                              className="secondary"
                              onClick={() =>
                                void protect(async () => {
                                  const result = await request<{
                                    state: SessionState;
                                  }>("session/read", {
                                    sessionId: child.id,
                                    history: { limit: 200 },
                                  });
                                  setChildTranscript(result.state);
                                })
                              }
                            >
                              Inspect subagent
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
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
                      const sessionId = state!.session.id;
                      const result = await request<any>("review/turnDiff", {
                        sessionId,
                        path: file.path,
                        owner: file.regions[0].owner,
                      });
                      if (stateRef.current?.session.id === sessionId)
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
      {palette && (
        <div
          className="modal-backdrop"
          onClick={(event) => {
            if (event.target === event.currentTarget) setPalette(false);
          }}
        >
          <section
            ref={commandModal}
            className="command-palette"
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
          >
            <header>
              <Search size={17} />
              <input
                aria-label="Search commands"
                placeholder="Search projects, sessions and actions…"
                value={paletteQuery}
                onChange={(event) => setPaletteQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && commands[0]) {
                    event.preventDefault();
                    event.stopPropagation();
                    setPalette(false);
                    commands[0].action();
                  }
                }}
              />
              <button
                aria-label="Close command palette"
                onClick={() => setPalette(false)}
              >
                <X size={16} />
              </button>
            </header>
            <div className="command-results">
              {commands.length ? (
                commands.map((command, index) => (
                  <button
                    key={`${command.title}-${index}`}
                    onClick={() => {
                      setPalette(false);
                      setPaletteQuery("");
                      command.action();
                    }}
                  >
                    <span>
                      {command.title}
                      <small>{command.detail}</small>
                    </span>
                    <ArrowUpRight size={14} />
                  </button>
                ))
              ) : (
                <p>No matching commands.</p>
              )}
            </div>
            <footer>
              Enter opens the first result · Tab moves through actions · Escape
              closes
            </footer>
          </section>
        </div>
      )}
      {childTranscript && (
        <div className="modal-backdrop">
          <section
            className="child-transcript-modal"
            ref={childModal}
            role="dialog"
            aria-modal="true"
            aria-label="Subagent history"
          >
            <header>
              <div>
                <p className="eyebrow">Subagent history</p>
                <h2>
                  {childTranscript.session.title ||
                    childTranscript.session.agent?.name ||
                    "Subagent"}
                </h2>
              </div>
              <button
                className="icon-button"
                aria-label="Close subagent history"
                onClick={() => setChildTranscript(null)}
              >
                <X size={18} />
              </button>
            </header>
            <dl className="child-session-details">
              <div>
                <dt>Session</dt>
                <dd>{childTranscript.session.id}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{childTranscript.session.status?.type || "Unknown"}</dd>
              </div>
              <div>
                <dt>Model</dt>
                <dd>{childTranscript.session.model || "Inherited"}</dd>
              </div>
              <div>
                <dt>Tokens</dt>
                <dd>
                  {childTranscript.session.tokenUsage?.totalTokens.toLocaleString() ??
                    "Not reported"}
                </dd>
              </div>
            </dl>
            <div className="conversation">
              {childTranscript.history?.map((entry) => (
                <Entry key={entry.id} entry={entry} />
              ))}
            </div>
          </section>
        </div>
      )}
      {loopsOpen && state && (
        <div className="modal-backdrop">
          <section
            className="loops-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Scheduled loops"
          >
            <LoopsPanel
              sessionId={state.session.id}
              backendActive={status.state === "ready"}
              disabled={working || running}
              onClose={() => setLoopsOpen(false)}
            />
          </section>
        </div>
      )}
      {resourcesOpen && (
        <PanelBoundary
          name="Workspace management"
          modal
          onClose={() => setResourcesOpen(false)}
        >
          <Suspense
            fallback={
              <div className="modal-backdrop" role="status">
                Opening workspace management…
              </div>
            }
          >
            <ResourceWindow
              sessionId={state?.session.id}
              runtime={runtime}
              disabled={!state || working || running}
              onRuntime={acceptResourceRuntime}
              onError={acceptResourceError}
              onClose={() => setResourcesOpen(false)}
            />
          </Suspense>
        </PanelBoundary>
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
              <ModelPicker
                models={
                  modelMetadata.length
                    ? modelMetadata
                    : configView?.models || []
                }
                activeModel={
                  runtime?.config.activeModel || configView?.activeModel
                }
                disabled={working || running}
                onSelect={(modelAlias, reasoningEffort) =>
                  protect(async () => {
                    if (state) {
                      const result = await request<any>("config/model/write", {
                        sessionId: state.session.id,
                        modelAlias,
                        ...(reasoningEffort ? { reasoningEffort } : {}),
                      });
                      setRuntime(result.runtime);
                    } else {
                      setPendingModel({
                        alias: modelAlias,
                        reasoning: reasoningEffort,
                      });
                      setNotice(
                        "This model will be applied when the project session connects.",
                      );
                    }
                  })
                }
              />
              <div className="browser-auth-card">
                <div>
                  <strong>Sign in with Mistral</strong>
                  <p>
                    Connect your account in the browser. Vibe owns the sign-in
                    flow and stores the resulting credential.
                  </p>
                </div>
                {authState?.state === "awaiting_browser" ? (
                  <div className="button-row">
                    <button
                      className="primary"
                      disabled={working}
                      onClick={() =>
                        void protect(async () => {
                          const result = await bridge!.auth(
                            "complete",
                            authState.attemptId,
                          );
                          setAuthState(result);
                          const next = await request<Setup>("setup/status");
                          setSetup(next);
                          setNotice("Signed in with Mistral.");
                          if (project) {
                            setSettings(false);
                            await openSession(
                              project,
                              pendingOpen.current?.sessionId,
                              next.hasApiKey,
                            );
                          }
                        })
                      }
                    >
                      Complete sign-in
                    </button>
                    <button
                      className="secondary"
                      onClick={() =>
                        void protect(async () =>
                          setAuthState(
                            await bridge!.auth("cancel", authState.attemptId),
                          ),
                        )
                      }
                    >
                      Cancel this sign-in
                    </button>
                  </div>
                ) : (
                  <button
                    className="primary"
                    disabled={working || status.state !== "ready"}
                    onClick={() =>
                      void protect(async () =>
                        setAuthState(await bridge!.auth("begin")),
                      )
                    }
                  >
                    <ArrowUpRight size={14} />
                    Continue in browser
                  </button>
                )}
                <small>
                  {authState?.state === "awaiting_browser"
                    ? "Complete the browser step, then return here. This attempt expires automatically."
                    : "API usage and account subscriptions follow your Mistral access; this app does not infer your plan."}
                </small>
              </div>
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
              <div className="appearance-switches">
                <label>
                  <input
                    type="checkbox"
                    checked={preferences.mascot !== false}
                    onChange={(event) =>
                      void savePreferences({
                        ...preferences,
                        mascot: event.target.checked,
                      })
                    }
                  />
                  <span>
                    Pixel companion
                    <small>Ember follows the real session state.</small>
                  </span>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={preferences.motion !== false}
                    onChange={(event) =>
                      void savePreferences({
                        ...preferences,
                        motion: event.target.checked,
                      })
                    }
                  />
                  <span>
                    Decorative motion
                    <small>
                      System reduced-motion preferences always take priority.
                    </small>
                  </span>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={durableDrafts}
                    onChange={(event) => {
                      const enabled = event.target.checked;
                      setDurableDrafts(enabled);
                      setDraftPersistenceEnabled(enabled);
                      if (enabled) saveDurableDrafts(sessionDrafts.current);
                    }}
                  />
                  <span>
                    Keep unsent drafts after restart (off by default)
                    <small>
                      Stores only unsent composer text on this machine (up to
                      50 drafts, 100k chars each). Never history, credentials,
                      diagnostics or remote sync. Turning off deletes stored
                      drafts.
                    </small>
                  </span>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={preferences.notificationsEnabled !== false}
                    onChange={(event) =>
                      void savePreferences({
                        ...preferences,
                        notificationsEnabled: event.target.checked,
                      })
                    }
                  />
                  <span>
                    Desktop notifications
                    <small>
                      Task done, loop failed, approval waiting and backend errors — while the app runs only.
                      No sensitive content; click opens the owning session. Never promises delivery with the app closed.
                    </small>
                  </span>
                </label>
                <div className="button-row">
                  <button
                    className="secondary"
                    disabled={!hasStoredDrafts()}
                    onClick={() => {
                      clearStoredDrafts();
                      setNotice("Stored drafts cleared from this machine.");
                    }}
                  >
                    Clear stored drafts
                  </button>
                </div>
              </div>
            </section>
            <section>
              <h3>Editor handoff</h3>
              <p>
                <small>
                  Open repository folders and files in your editor. This reuses files on disk only —
                  it never attaches the editor to the agent session. For agentic editing, configure the
                  official <code>vibe-acp</code> in that editor.
                </small>
              </p>
              <div className="button-row">
                <button
                  className="secondary"
                  onClick={() =>
                    void protect(async () => {
                      if (!bridge?.chooseEditorPath) throw new Error("Editor picker unavailable.");
                      const picked = await bridge.chooseEditorPath();
                      if (!picked) return;
                      await savePreferences({ ...preferences, customEditorPath: picked });
                      setNotice(`Custom editor set: ${picked}`);
                    })
                  }
                >
                  Choose custom editor…
                </button>
                {preferences.customEditorPath && (
                  <button
                    className="secondary"
                    onClick={() => void savePreferences({ ...preferences, customEditorPath: null })}
                  >
                    Clear custom editor
                  </button>
                )}
                <button
                  className="text-button"
                  onClick={() => void bridge?.openExternal("https://docs.mistral.ai/vibe/code/vs-code-extension/install-authenticate")}
                >
                  Editor setup docs <ArrowUpRight size={13} />
                </button>
              </div>
              {preferences.customEditorPath && (
                <p role="status"><small>Custom editor: <code>{preferences.customEditorPath}</code></small></p>
              )}
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
