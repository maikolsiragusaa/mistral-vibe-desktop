export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Preferences {
  theme: "light" | "dark" | "system";
  recentProjects: string[];
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
  }[];
  turnQueue?: { items: { id: string }[]; paused: boolean };
  retrying?: { detail: string } | null;
}
export interface Runtime {
  config: {
    activeModel: { alias: string; displayName: string; thinking: string };
    models: { alias: string; displayName: string }[];
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
  readPreferences(): Promise<Preferences>;
  savePreferences(preferences: Preferences): Promise<Preferences>;
  onEvent(listener: (event: RpcEvent) => void): () => void;
  onStatus(listener: (status: Status) => void): () => void;
  openExternal(url: string): Promise<void>;
}
declare global {
  interface Window {
    vibe?: VibeBridge;
  }
}
