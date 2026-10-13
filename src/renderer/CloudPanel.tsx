import { useCallback, useEffect, useState } from "react";
import { ArrowUpRight, RefreshCw, X } from "lucide-react";

const bridge = window.vibe;

interface Props {
  sessionId: string | null;
  projectPath: string;
  activeModel: string | null;
  hasApiKey: boolean;
  disabled?: boolean;
  onClose: () => void;
}

/** Cloud Code through official Mistral infrastructure only.
 *
 * Uses projectLinks/* and vibeCode/* when operational. Teleport is one-way
 * local -> cloud, requires a Git repo, a Mistral model and an eligible
 * account, and always lands on Medium 3.5 in the cloud. No bidirectional sync
 * is promised; limits are shown before transfer.
 */
export function CloudPanel({ sessionId, projectPath, activeModel, hasApiKey, disabled, onClose }: Props) {
  const [links, setLinks] = useState<any[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!bridge) return;
    setLoading(true);
    setError("");
    try {
      const result = await bridge.request<{ links?: any[]; items?: any[] }>(
        "projectLinks/list",
        {},
      );
      setLinks(result.links ?? result.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openPicker = async (purpose: "configure" | "teleport") => {
    if (!sessionId || !bridge) return;
    setError("");
    setNotice("");
    try {
      const result = await bridge.request<any>("vibeCode/projects/open", {
        sessionId,
        purpose,
      });
      setNotice(
        result?.pickerUrl || result?.url
          ? `Cloud picker ready: ${result.pickerUrl ?? result.url}`
          : "Cloud picker opened by Vibe. Follow the session prompt to choose a project.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const isMistralModel =
    !activeModel || /mistral|medium|devstral|small|large|ministral/i.test(activeModel);
  const canTeleport = Boolean(sessionId && projectPath && hasApiKey && isMistralModel);

  return (
    <section className="cloud-panel" aria-label="Cloud code">
      <header>
        <div>
          <p className="eyebrow">Code · Cloud</p>
          <h2>Vibe Code Web</h2>
          <small>Mistral-hosted sandboxes. No local cloud is built here.</small>
        </div>
        <button className="icon-button" aria-label="Close cloud panel" onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice-text" role="status">
          {notice}
        </p>
      )}
      <section>
        <h3>Linked projects</h3>
        <div className="button-row">
          <button className="secondary" disabled={loading} onClick={() => void refresh()}>
            <RefreshCw size={13} /> Refresh links
          </button>
          <button
            className="secondary"
            disabled={disabled || !sessionId}
            onClick={() => void openPicker("configure")}
          >
            Configure cloud project
          </button>
        </div>
        {loading && <p role="status">Loading links…</p>}
        {!loading && !links.length && <p>No linked cloud projects reported by Vibe.</p>}
        {links.map((link: any, index: number) => (
          <div className="loop-row" key={String(link.projectId ?? link.id ?? index)}>
            <div>
              <strong>{String(link.projectName ?? link.name ?? "Cloud project")}</strong>
              <small className="break-word">{String(link.projectId ?? link.id ?? "")}</small>
            </div>
          </div>
        ))}
      </section>
      <section>
        <h3>Teleport this session</h3>
        <ul className="teleport-checks">
          <li>Account key: {hasApiKey ? "available to Vibe" : "missing — sign in first"}</li>
          <li>Git repository: {projectPath ? "selected" : "select a repo first"}</li>
          <li>
            Model: {activeModel ?? "inherited"}
            {isMistralModel ? " — eligible" : " — third-party models cannot teleport"}
          </li>
        </ul>
        <p>
          Teleport is <strong>one-way</strong>. The cloud continues on Mistral
          Medium 3.5 for up to 24h (3h idle timeout, 30s per command). You cannot
          pull it back locally; continue from Vibe Code Web.
        </p>
        <div className="button-row">
          <button
            className="primary"
            disabled={disabled || !canTeleport}
            title={
              canTeleport
                ? "Move this session to Vibe Code Web"
                : "Teleport needs a session, Git repo, API key and Mistral model"
            }
            onClick={() => void openPicker("teleport")}
          >
            Teleport to cloud
          </button>
          <button
            className="text-button"
            onClick={() =>
              void bridge?.openExternal("https://docs.mistral.ai/vibe/code/cli/teleport-cli-web")
            }
          >
            Teleport docs <ArrowUpRight size={13} />
          </button>
        </div>
      </section>
    </section>
  );
}
