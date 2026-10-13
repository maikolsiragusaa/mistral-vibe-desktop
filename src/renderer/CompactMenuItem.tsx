import { useEffect, useState } from "react";
import {
  getCapability,
  isUnsupportedError,
  probeCapability,
  setCapability,
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

/** Compaction is probed, not presumed: Unified 2.26.1 reports not implemented. */
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

  useEffect(() => {
    let cancelled = false;
    setState(getCapability(sessionId, "session/compact"));
    void probeCapability(request, sessionId, "session/compact").then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [request, sessionId]);

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
          ? "Availability not yet verified against this engine."
          : "Summarize history to free context."
      }
      onClick={() => {
        setWorking(true);
        onError("");
        request("session/compact", { sessionId })
          .then(() => {
            onDone();
            onNotice("Session compaction requested.");
          })
          .catch((e: unknown) => {
            const message = e instanceof Error ? e.message : String(e);
            if (isUnsupportedError(message)) {
              setCapability(sessionId, "session/compact", "unsupported");
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
