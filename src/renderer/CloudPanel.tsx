import { useCallback, useEffect, useState } from "react";
import { ArrowUpRight, RefreshCw, X } from "lucide-react";
import {
  classifyTeleportReadiness,
  type PreflightState,
} from "./cloud-preflight";

const bridge = window.vibe;

export interface CloudModelInfo {
  alias: string;
  provider?: string | null;
}

interface Props {
  sessionId: string | null;
  projectPath: string;
  activeModel: string | null;
  models: CloudModelInfo[];
  hasApiKey: boolean;
  backendReady: boolean;
  disabled?: boolean;
  onClose: () => void;
}

function StateBadge({ state }: { state: PreflightState }) {
  return (
    <span className={`preflight-badge ${state}`}>
      {state === "verified" ? "verified" : state === "incompatible" ? "not compatible" : "unknown"}
    </span>
  );
}

/** Cloud Code through official Mistral infrastructure only.
 *
 * Uses projectLinks/* and vibeCode/* when operational. Teleport is one-way
 * local -> cloud and always lands on Medium 3.5 in the cloud (24h max, 3h
 * idle, 30s per command). No bidirectional sync is promised.
 * Preflight verifies the Git repo and model provider from real backend data;
 * account tier and GitHub App stay unknown and are delegated to Mistral.
 * Opening the picker is reported as exactly that — transfer completion can
 * only be confirmed in Vibe Code Web.
 */
export function CloudPanel({
  sessionId,
  projectPath,
  activeModel,
  models,
  hasApiKey,
  backendReady,
  disabled,
  onClose,
}: Props) {
  const [links, setLinks] = useState<any[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [checkingGit, setCheckingGit] = useState(false);
  const [isGitRepo, setIsGitRepo] = useState<boolean | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const [pickerState, setPickerState] = useState<"idle" | "opened" | "failed">("idle");
  const [sessionCopied, setSessionCopied] = useState(false);

  const refresh = useCallback(async () => {
    if (!bridge) return;
    setLoading(true);
    setError("");
    try {
      const result = await bridge.request<{ links?: any[]; items?: any[] }>(
        "projectLinks/list",
        {},
      );
      const raw = result.links ?? result.items ?? [];
      setLinks(Array.isArray(raw) ? raw : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const checkGit = useCallback(async () => {
    if (!bridge?.git || !projectPath) {
      setIsGitRepo(null);
      setBranch(null);
      return;
    }
    setCheckingGit(true);
    try {
      const status = await bridge.git<{
        isGitRepository?: boolean;
        branch?: string | null;
      }>("status", { projectPath });
      setIsGitRepo(status?.isGitRepository ?? null);
      setBranch(
        typeof status?.branch === "string" && status.branch ? status.branch : null,
      );
    } catch {
      // A failed check is unknown, never satisfied.
      setIsGitRepo(null);
      setBranch(null);
    } finally {
      setCheckingGit(false);
    }
  }, [projectPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    setPickerState("idle");
    void checkGit();
  }, [checkGit, sessionId]);

  const openPicker = async (purpose: "configure" | "teleport") => {
    if (!sessionId || !bridge) return;
    setError("");
    setNotice("");
    try {
      await bridge.request("vibeCode/projects/open", { sessionId, purpose });
      setPickerState("opened");
      setNotice(
        purpose === "teleport"
          ? "Teleport picker opened by Vibe (step 2 of 5). Choose the cloud project in the session flow. Steps 3–5 complete in Vibe Code Web under Mistral custody; this panel cannot confirm the transfer."
          : "Cloud picker opened by Vibe. Project selection continues in the session flow.",
      );
    } catch (e) {
      setPickerState("failed");
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const openCodeWeb = () =>
    void bridge?.openExternal("https://mistral.ai/products/vibe").catch(() => {});
  const copySessionId = async () => {
    if (!sessionId) return;
    try {
      await navigator.clipboard.writeText(sessionId);
      setSessionCopied(true);
    } catch {
      setError("Could not copy the session id.");
    }
  };

  // Provider comes from the runtime inventory record only — never inferred
  // from the display name. Unknown provider stays unknown.
  const activeRecord = activeModel
    ? models.find((m) => m.alias === activeModel) ?? null
    : null;
  const preflight = classifyTeleportReadiness({
    isGitRepository: isGitRepo,
    branch,
    provider: activeRecord?.provider ?? null,
    activeModelAlias: activeModel,
    hasApiKey,
    backendReady,
  });
  const canAttemptTeleport = Boolean(
    sessionId && !disabled && backendReady && preflight.overall !== "incompatible",
  );

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
            disabled={disabled || !sessionId || !backendReady}
            onClick={() => void openPicker("configure")}
          >
            Configure cloud project
          </button>
        </div>
        {loading && <p role="status">Loading links…</p>}
        {!loading && !links.length && <p>No linked cloud projects reported by Vibe.</p>}
        {links.map((link: any, index: number) => (
          <div className="loop-row" key={String(link?.projectId ?? link?.id ?? index)}>
            <div>
              <strong>{String(link?.projectName ?? link?.name ?? "Cloud project")}</strong>
              <small className="break-word">{String(link?.projectId ?? link?.id ?? "")}</small>
            </div>
          </div>
        ))}
      </section>
      <section>
        <h3>Teleport this session</h3>
        <div className="button-row">
          <button className="secondary" disabled={checkingGit || !projectPath} onClick={() => void checkGit()}>
            <RefreshCw size={13} /> {checkingGit ? "Checking repository…" : "Re-check repository"}
          </button>
        </div>
        <ul className="teleport-checks">
          <li>
            Git repository: <StateBadge state={preflight.gitRepo} />{" "}
            {preflight.gitRepo === "verified"
              ? branch
                ? `valid repo, branch ${branch}`
                : "valid repo, branch unknown"
              : preflight.gitRepo === "incompatible"
                ? "not a Git repository — Teleport requires one"
                : "could not verify — select a project and retry"}
          </li>
          <li>
            Model: <StateBadge state={preflight.model} /> {activeModel ?? "inherited"}
            {preflight.model === "incompatible"
              ? " — third-party/custom providers cannot teleport"
              : preflight.model === "unknown"
                ? " — provider not verifiable here; Mistral decides"
                : ""}
          </li>
          <li>
            Credentials: <StateBadge state={preflight.credentials} />{" "}
            {hasApiKey ? "key available to Vibe" : "missing — sign in first"}
          </li>
          <li>
            Account plan (Pro/Team/Enterprise): <StateBadge state={preflight.accountTier} />{" "}
            verified by Mistral at transfer time
          </li>
          <li>
            GitHub App and permissions: <StateBadge state={preflight.githubApp} />{" "}
            verified by Mistral at transfer time
          </li>
        </ul>
        <h3>Transfer lifecycle (honest)</h3>
        <ol className="teleport-lifecycle">
          <li>
            <strong>1 · Local preflight</strong> —{" "}
            {preflight.overall === "incompatible"
              ? "blocked (see incompatible check above)"
              : preflight.overall === "verified"
                ? "verified locally"
                : "partially verifiable; Mistral decides the rest"}
          </li>
          <li>
            <strong>2 · Official picker</strong> —{" "}
            {pickerState === "opened"
              ? "opened by Vibe (this panel only proves the picker opened)"
              : pickerState === "failed"
                ? "last open failed (see error)"
                : "not opened yet"}
          </li>
          <li>
            <strong>3 · Transfer requested</strong> — confirmed only in Vibe Code Web, never here
          </li>
          <li>
            <strong>4 · Transfer confirmed</strong> — confirmed only in Vibe Code Web; the local session is not converted into a cloud session
          </li>
          <li>
            <strong>5 · Beyond client visibility</strong> — sandbox lifetime, GitHub persistence and resume limits are Mistral-owned; no local sync is promised
          </li>
        </ol>
        <p>
          Teleport is <strong>one-way</strong>. The cloud continues on Mistral
          Medium 3.5 for up to 24h (3h idle timeout, 30s per command). Local files
          that were never pushed to the authorized GitHub repository do not move
          automatically; local secrets never move. You cannot pull it back locally;
          continue from Vibe Code Web.
          {pickerState === "opened" &&
            " Picker opened — completion is confirmed in Vibe Code Web, not here."}
        </p>
        <p>
          <small>
            Needs: Mistral sign-in, an eligible Git repository, a Mistral-model session,
            and the Mistral GitHub App on that repository. Plan tier and App state are
            verified by Mistral at transfer time — the desktop never guesses them.
          </small>
        </p>
        <div className="button-row">
          <button
            className="primary"
            disabled={!canAttemptTeleport}
            title={
              preflight.overall === "incompatible"
                ? "A requirement is not compatible (see states above)"
                : !sessionId
                  ? "Open a session first"
                  : "Open the Mistral Teleport picker for this session"
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
          <button className="secondary" onClick={openCodeWeb}>
            Open Vibe Code Web <ArrowUpRight size={13} />
          </button>
          {sessionId && (
            <button className="secondary" onClick={() => void copySessionId()}>
              {sessionCopied ? "Session id copied" : "Copy session id"}
            </button>
          )}
        </div>
      </section>
    </section>
  );
}
