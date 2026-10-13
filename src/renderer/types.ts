export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Preferences {
  theme: "light" | "dark" | "system";
  recentProjects: string[];
  mascot?: boolean;
  motion?: boolean;
  /** M3: per-repository custom worktree parent dirs (repo canonical path → parent). */
  worktreeRoots?: Record<string, string>;
  /** M3: user-configured editor executable (absolute), or null when unset. */
  customEditorPath?: string | null;
  /** M3: desktop toast preference (default on when unset). */
  notificationsEnabled?: boolean;
}
export interface Status {
  state: "connecting" | "ready" | "disconnected" | "error";
  message?: string;
}
export interface RpcEvent {
  method: string;
  params: Record<string, any>;
}
export interface ContentBlock {
  type: string;
  text?: string;
  uri?: string;
  mediaType?: string;
  altText?: string;
}
export interface Turn {
  id: string;
  sessionId: string;
  status: string;
  error?: { message: string } | null;
}
export interface Agent {
  name: string;
  description?: string;
  agentType?: string;
}
export interface Session {
  id: string;
  title?: string | null;
  preview?: string;
  cwd?: string | null;
  status?: { type: string };
  updatedAt: number;
  pinnedAt?: number | null;
  archivedAt?: number | null;
  leaseHolder?: { processId?: number | null } | null;
  contextUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  } | null;
  model?: string | null;
  agent?: Agent | null;
  worktree?: { branch: string; name: string; path: string } | null;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  } | null;
}
export interface HistoryEntry {
  id: string;
  turnId?: string | null;
  type: string;
  sessionId: string;
  generationStatus: string;
  role?: string;
  content?: ContentBlock[];
  text?: string;
  title?: string;
  detail?: Record<string, any>;
  state?: Record<string, any>;
  callbackId?: string;
}
export interface SessionState {
  format: string;
  eventId: number;
  session: Session;
  history?: HistoryEntry[] | null;
  historyBeforeCursor?: string | null;
  turns?: Turn[] | null;
  activeCallbacks: HistoryEntry[];
  childSessions: {
    id: string;
    name: string;
    status: { type: string };
    agentType: string;
    tokenUsage?: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    };
    contextUsage?: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    } | null;
    createdAt?: number;
    updatedAt?: number;
  }[];
  turnQueue?: {
    items: {
      id: string;
      entries?: { role: string; content: ContentBlock[] }[];
    }[];
    paused: boolean;
  };
  retrying?: { detail: string } | null;
}
export interface Runtime {
  config: {
    activeModel: {
      alias: string;
      displayName: string;
      thinking: string;
      [key: string]: any;
    };
    models: { alias: string; displayName: string; [key: string]: any }[];
  };
  activeAgent: Agent;
  agents: Agent[];
  skills: { name: string; description?: string }[];
  tools: { name: string; description?: string }[];
  stats: Record<string, any>;
  issues: { message: string; source?: string }[];
  contextWindow: number;
  mcp: Record<string, any>;
}
export interface Setup {
  provider: { name: string; apiBase: string };
  hasApiKey: boolean;
  supportsBrowserSignIn: boolean;
}
export interface VibeBridge {
  connect(): Promise<{
    serverInfo: { name: string; version: string };
    setup: Setup;
  }>;
  request<T = any>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T>;
  chooseProject(): Promise<string | null>;
  chooseWorktreeRoot(): Promise<string | null>;
  chooseEditorPath(): Promise<string | null>;
  notify(notice: { title: string; body: string; sessionId?: string | null }): Promise<{ shown: boolean }>;
  onNoticeClick(listener: (payload: { sessionId?: string | null }) => void): () => void;
  editorDetect(): Promise<{ id: string; label: string; exePath: string | null; verified: boolean }[]>;
  editorDetectAcp(): Promise<{ found: boolean; exePath: string | null }>;
  editorOpen(input: { editorExe?: string | null; editorId?: string | null; folder: string; file?: string | null; line?: number | null }): Promise<{ exePath: string; argv: string[] }>;
  editorOpenTerminal(input: { folder: string }): Promise<{ exePath: string; argv: string[] }>;
  readPreferences(): Promise<Preferences>;
  savePreferences(preferences: Preferences): Promise<Preferences>;
  onEvent(listener: (event: RpcEvent) => void): () => void;
  onStatus(listener: (status: Status) => void): () => void;
  openExternal(url: string): Promise<void>;
  git<T = any>(method: string, params: Record<string, unknown>): Promise<T>;
  setWindowTheme(theme: "light" | "dark"): Promise<void>;
  auth<T = any>(
    action: "begin" | "status" | "complete" | "cancel",
    attemptId?: string,
  ): Promise<T>;
  openAuthLink(id: string): Promise<void>;
  openQuotaDashboard(kind: "vibe" | "usage" | "limits"): Promise<void>;
  previewOpen(url: string): Promise<{ url: string }>;
  previewReload(): Promise<{ url: string }>;
  previewClose(): Promise<void>;
}
declare global {
  interface Window {
    vibe?: VibeBridge;
  }
}
