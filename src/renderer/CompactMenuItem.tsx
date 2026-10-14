import { useEffect, useState } from "react";
import {
  getCapability,
  isUnsupportedError,
  markExplicitSuccess,
  markExplicitUnsupported,
} from "./capabilities";

interface Props {
  sessionId: string;
  disabled?: boolean;
  request: <T = unknown>(
    method: string,
    params?: Record<string, unknown>,
  ) => Promise<T>;
  onDone: () => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}

/** Compaction is never probed: session/compact is mutative, so mounting or
 * opening the menu must not invoke it. Unknown means "not yet tried via an
 * explicit user action". Only an explicit click calls the engine; a
 * method_not_found answer then gates the item as unsupported. */
export function CompactMenuItem({
  sessionId,
  disabled,
  request,
  onDone,
  onNotice,
  onError,
}: Props) {
  const [state, setState] = useState<"unknown" | "verified" | "unsupported">(
    () => getCapability(sessionId, "session/compact"),
  );
  const [working, setWorking] = useState(false);

  // Sync cached verdicts across sessions with no side effects: a pure cache
  // read, never an RPC. Mutative methods verify only on explicit action.
  useEffect(() => {
    setState(getCapability(sessionId, "session/compact"));
  }, [sessionId]);

  if (state === "unsupported") {
    return (
      <button
        role="menuitem"
        disabled
        title="This Vibe engine reports session/compact as not implemented. History stays as-is."
      >
        Compact history (unsupported by engine)
      </button>
    );
  }

  return (
    <button
      role="menuitem"
      disabled={disabled || working}
      title={
        state === "unknown"
          ? "Availability is checked only when you request compaction — opening this menu never compacts."
          : "Summarize history to free context."
      }
      onClick={() => {
        setWorking(true);
        onError("");
        request("session/compact", { sessionId })
          .then(() => {
            markExplicitSuccess(sessionId, "session/compact");
            setState("verified");
            onDone();
            onNotice("Session compaction requested.");
          })
          .catch((e: unknown) => {
            const message = e instanceof Error ? e.message : String(e);
            if (isUnsupportedError(message)) {
              markExplicitUnsupported(sessionId, "session/compact", message);
              setState("unsupported");
              onError(
                "This Vibe engine does not implement session/compact. History stays as-is.",
              );
            } else {
              onError(message);
            }
          })
          .finally(() => setWorking(false));
      }}
    >
      Compact history
    </button>
  );
}
