import type {
  McpLayerSnapshot,
  McpMutationIntent,
  McpMutationResult,
} from "./mcp-mutation-types";

function bridge() {
  const candidate = window.vibe as unknown as
    | {
        mcpDescribe?: (sessionId: string) => Promise<McpLayerSnapshot>;
        mcpMutate?: (sessionId: string, intent: McpMutationIntent) => Promise<McpMutationResult>;
      }
    | undefined;
  if (!candidate) throw new Error("The Vibe desktop bridge is unavailable.");
  return candidate;
}

export async function describeMcpLayer(sessionId: string): Promise<McpLayerSnapshot> {
  const client = bridge();
  if (typeof client.mcpDescribe !== "function")
    throw new Error("MCP configuration service is unavailable in this build.");
  const snapshot = await client.mcpDescribe(sessionId);
  if (!snapshot || !Array.isArray(snapshot.servers) || typeof snapshot.revision !== "string")
    throw new Error("The MCP configuration service returned an invalid snapshot.");
  return snapshot;
}

export async function mutateMcpLayer(
  sessionId: string,
  intent: McpMutationIntent,
): Promise<McpMutationResult> {
  const client = bridge();
  if (typeof client.mcpMutate !== "function")
    throw new Error("MCP configuration service is unavailable in this build.");
  const result = await client.mcpMutate(sessionId, intent);
  if (!result || typeof result.outcome !== "string" || !Array.isArray(result.servers))
    throw new Error("The MCP configuration service returned an invalid result.");
  return result;
}
