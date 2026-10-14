import { useCallback, useEffect, useState } from "react";
import { getErrorMessage } from "./adapters";

interface AcpState {
  found: boolean;
  exePath: string | null;
}

export function AcpPanel() {
  const [state, setState] = useState<AcpState | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const detect = useCallback(async () => {
    setError("");
    try {
      const bridge = window.vibe as unknown as
        | { editorDetectAcp?: () => Promise<AcpState> }
        | undefined;
      if (typeof bridge?.editorDetectAcp !== "function") {
        setError("ACP detection is unavailable in this build.");
        return;
      }
      setState(await bridge.editorDetectAcp());
    } catch (cause) {
      setError(getErrorMessage(cause));
    }
  }, []);

  useEffect(() => {
    void detect();
  }, [detect]);

  const copySnippet = async () => {
    const snippet = `// The desktop uses the app-server. Editors integrate via the official vibe-acp.\n// Install the editor extension, then point it at your trusted worktree.\n// Opening the same folder in an editor does NOT share the desktop agent session.`;
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
    } catch {
      setError("Copy failed in this context.");
    }
  };

  return (
    <section className="rw-acp" aria-label="Editor integration">
      <h3 className="rw-subheading">Editor integration (official ACP)</h3>
      <p className="rw-note">
        The desktop never runs a second ACP server. Compatible editors use upstream{" "}
        <code>vibe-acp</code>; the desktop only detects its presence and hands off folders.
      </p>
      <p className="rw-note" aria-live="polite">
        {state === null
          ? "Detecting vibe-acp…"
          : state.found
            ? `vibe-acp detected${state.exePath ? ` at ${state.exePath}` : ""}.`
            : "vibe-acp was not found on PATH. Install the official editor integration to use it."}
      </p>
      {error && <p className="rw-error">{error}</p>}
      <div className="rw-actions">
        <button type="button" className="rw-button rw-secondary rw-small" onClick={() => void detect()}>
          Re-detect
        </button>
        <button type="button" className="rw-button rw-secondary rw-small" onClick={() => void copySnippet()}>
          {copied ? "Copied" : "Copy guidance snippet"}
        </button>
      </div>
    </section>
  );
}
