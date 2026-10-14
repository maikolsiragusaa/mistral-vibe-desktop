export type McpMutationOutcome =
  | "applied-verified"
  | "rejected"
  | "conflict"
  | "pending-reload"
  | "readback-failed"
  | "unknown";

export interface RedactedMcpServer {
  name: string;
  transport?: string;
  url?: string;
  command?: string;
  args?: string[];
  cwd?: string | null;
  prompt?: string | null;
  startup_timeout_sec?: number;
  tool_timeout_sec?: number;
  sampling_enabled?: boolean;
  disabled?: boolean;
  disabled_tools?: string[];
  envKeys: string[];
  envConfigured: boolean;
  [key: string]: unknown;
}

export interface McpLayerSnapshot {
  servers: RedactedMcpServer[];
  revision: string;
  targetLayer: string;
  targets: string[];
}

export interface McpScalarChanges {
  transport?: string;
  url?: string;
  command?: string;
  args?: string[];
  cwd?: string | null;
  prompt?: string | null;
  startup_timeout_sec?: number;
  tool_timeout_sec?: number;
  sampling_enabled?: boolean;
  disabled?: boolean;
  disabled_tools?: string[];
}

export interface McpEnvChange {
  keep: string[];
  set: Record<string, string>;
  remove: string[];
}

export type McpMutationIntent =
  | {
      op: "add";
      name: string;
      expectedRevision: string | null;
      targetLayer?: string | null;
      entry: McpScalarChanges & { env?: Record<string, string> };
    }
  | {
      op: "set";
      name: string;
      expectedRevision: string | null;
      fields: McpScalarChanges;
      unset?: string[];
      env?: McpEnvChange | null;
    }
  | { op: "enable"; name: string; expectedRevision: string | null; disabled: boolean }
  | { op: "remove"; name: string; expectedRevision: string | null };

export interface McpMutationResult {
  outcome: McpMutationOutcome;
  message: string;
  servers: RedactedMcpServer[];
  revision: string;
  targetLayer: string;
}
