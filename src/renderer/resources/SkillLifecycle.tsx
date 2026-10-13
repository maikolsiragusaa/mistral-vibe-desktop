import { useState } from "react";
import {
  validScope,
  validSkillAlias,
  validSkillId,
  validSkillName,
  validSkillVersion,
} from "./validation";
import { getErrorMessage } from "./adapters";

interface SkillLifecycleProps {
  sessionId: string | undefined;
  installedName: string;
  currentAlias?: string;
  onDone: (message: string) => void;
  onError: (message: string) => void;
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  refresh: () => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function SkillLifecycle({
  sessionId,
  installedName,
  currentAlias,
  onDone,
  onError,
  request,
  refresh,
}: SkillLifecycleProps) {
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<"alias" | "version" | "latest" | "convert" | "remove">("alias");
  const [alias, setAlias] = useState(currentAlias ?? "");
  const [versionText, setVersionText] = useState("");
  const [scope, setScope] = useState("");
  const [pending, setPending] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        className="rw-button rw-secondary rw-small"
        aria-label={`Manage ${installedName}`}
        onClick={() => setOpen(true)}
      >
        Manage
      </button>
    );
  }

  const run = async () => {
    if (!sessionId) {
      onError("Select or open a Vibe session before managing skills.");
      return;
    }
    if (!validSkillName(installedName)) {
      onError("This skill name cannot be used for lifecycle operations.");
      return;
    }
    const cleanScope = scope.trim();
    if (!validScope(cleanScope)) {
      onError("Scope must be empty, global, project or local.");
      return;
    }
    const params: Record<string, unknown> = { sessionId, name: installedName };
    if (cleanScope) params.scope = cleanScope;
    let method = "";
    if (action === "alias") {
      if (!validSkillAlias(alias)) {
        onError("Enter a valid alias (letters, digits, dot, underscore, dash, colon).");
        return;
      }
      method = "skills/setAlias";
      params.alias = alias.trim();
    } else if (action === "version") {
      const parsed = validSkillVersion(versionText);
      if (parsed === null) {
        onError("Enter a positive integer version.");
        return;
      }
      method = "skills/setVersion";
      params.version = parsed;
    } else if (action === "latest") {
      method = "skills/setLatest";
    } else if (action === "convert") {
      method = "skills/convertLocal";
    } else {
      if (!confirmRemove) {
        onError("Confirm removal by checking the acknowledgement first.");
        return;
      }
      method = "skills/remove";
    }
    setPending(true);
    try {
      await request(method, params);
      await refresh();
      // Readback: the mutated skill must be observable (or observably gone).
      const readback = await request("skills/installed", { sessionId });
      const skillsRaw =
        isRecord(readback) && Array.isArray(readback["skills"]) ? readback["skills"] : [];
      const names = skillsRaw.flatMap((entry): string[] => {
        if (!isRecord(entry) || typeof entry["name"] !== "string") return [];
        return [entry["name"] as string];
      });
      if (action === "remove") {
        if (names.includes(installedName)) {
          throw new Error("Vibe still lists this skill after removal. Refresh to inspect it.");
        }
      } else if (!names.includes(installedName) && action !== "alias") {
        throw new Error("Vibe no longer lists this skill after the change. Refresh to inspect it.");
      }
      setOpen(false);
      setConfirmRemove(false);
      onDone(
        action === "remove"
          ? `Removed ${installedName}.`
          : action === "alias"
            ? `Alias updated for ${installedName}.`
            : action === "version"
              ? `Version updated for ${installedName}.`
              : action === "latest"
                ? `${installedName} now tracks latest.`
                : `${installedName} converted to local.`,
      );
    } catch (cause) {
      onError(getErrorMessage(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="rw-dialog-inline" role="dialog" aria-label={`Manage ${installedName}`}>
      <div className="rw-form-row">
        <label>
          Operation
          <select value={action} onChange={(event) => setAction(event.target.value as typeof action)} disabled={pending}>
            <option value="alias">Set alias</option>
            <option value="version">Set version</option>
            <option value="latest">Track latest</option>
            <option value="convert">Convert to local</option>
            <option value="remove">Remove</option>
          </select>
        </label>
        <label>
          Scope (optional)
          <select value={scope} onChange={(event) => setScope(event.target.value)} disabled={pending}>
            <option value="">Session default</option>
            <option value="global">global</option>
            <option value="project">project</option>
            <option value="local">local</option>
          </select>
        </label>
      </div>
      {action === "alias" && (
        <label className="rw-field">
          Alias
          <input
            type="text"
            aria-label={`Alias for ${installedName}`}
            value={alias}
            onChange={(event) => setAlias(event.target.value)}
            disabled={pending}
            maxLength={256}
          />
        </label>
      )}
      {action === "version" && (
        <label className="rw-field">
          Version (positive integer)
          <input
            type="text"
            inputMode="numeric"
            aria-label={`Version for ${installedName}`}
            value={versionText}
            onChange={(event) => setVersionText(event.target.value)}
            disabled={pending}
          />
        </label>
      )}
      {action === "remove" && (
        <label className="rw-check">
          <input
            type="checkbox"
            checked={confirmRemove}
            onChange={(event) => setConfirmRemove(event.target.checked)}
            disabled={pending}
          />
          I understand this removes {installedName} from the selected scope.
        </label>
      )}
      {(action === "latest" || action === "convert") && (
        <p className="rw-note">
          {action === "latest"
            ? "The skill will track the latest compatible version."
            : "The skill will become a local copy you can edit."}
        </p>
      )}
      <div className="rw-actions">
        <button type="button" className="rw-button rw-secondary" onClick={() => setOpen(false)} disabled={pending}>
          Cancel
        </button>
        <button
          type="button"
          className={action === "remove" ? "rw-button rw-danger" : "rw-button rw-primary"}
          onClick={() => void run()}
          disabled={pending}
        >
          {pending ? "Working…" : action === "remove" ? "Remove skill" : "Apply"}
        </button>
      </div>
    </div>
  );
}

interface SkillImportProps {
  sessionId: string | undefined;
  skillId: string;
  onDone: (message: string) => void;
  onError: (message: string) => void;
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  refresh: () => Promise<void>;
}

export function SkillImport({ sessionId, skillId, onDone, onError, request, refresh }: SkillImportProps) {
  const [open, setOpen] = useState(false);
  const [versionText, setVersionText] = useState("");
  const [alias, setAlias] = useState("");
  const [scope, setScope] = useState("");
  const [consent, setConsent] = useState(false);
  const [pending, setPending] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        className="rw-button rw-primary rw-small"
        aria-label={`Import ${skillId}`}
        onClick={() => setOpen(true)}
      >
        Import
      </button>
    );
  }

  const run = async () => {
    if (!sessionId) {
      onError("Select or open a Vibe session before importing skills.");
      return;
    }
    if (!validSkillId(skillId)) {
      onError("This registry entry has an invalid skill identifier.");
      return;
    }
    if (!consent) {
      onError("Confirm that you trust this skill source before importing.");
      return;
    }
    const cleanScope = scope.trim();
    if (!validScope(cleanScope)) {
      onError("Scope must be empty, global, project or local.");
      return;
    }
    if (alias.trim() && !validSkillAlias(alias)) {
      onError("The alias is invalid.");
      return;
    }
    const parsedVersion = validSkillVersion(versionText);
    if (versionText.trim() && parsedVersion === null) {
      onError("Version must be a positive integer or empty.");
      return;
    }
    const params: Record<string, unknown> = { sessionId, skillId: skillId.trim() };
    if (parsedVersion !== null) params.version = parsedVersion;
    if (alias.trim()) params.alias = alias.trim();
    if (cleanScope) params.scope = cleanScope;
    setPending(true);
    try {
      await request("skills/import", params);
      await refresh();
      const readback = await request("skills/installed", { sessionId });
      const skillsRaw =
        isRecord(readback) && Array.isArray(readback["skills"]) ? readback["skills"] : [];
      const names = skillsRaw.flatMap((entry): string[] => {
        if (!isRecord(entry) || typeof entry["name"] !== "string") return [];
        return [entry["name"] as string];
      });
      const expected = alias.trim() || skillId.trim();
      const matched = names.some((name) => name === expected || name.endsWith(`:${expected}`) || expected.endsWith(name));
      if (!matched) {
        throw new Error("Import completed but the skill is not listed yet. Reload installed skills to verify.");
      }
      setOpen(false);
      onDone(`Imported ${skillId}. Verified in installed skills.`);
    } catch (cause) {
      onError(getErrorMessage(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="rw-dialog-inline" role="dialog" aria-label={`Import ${skillId}`}>
      <p className="rw-note">
        Registry skills are third-party content. Importing never executes skill commands automatically;
        review the description and version before confirming.
      </p>
      <div className="rw-form-row">
        <label>
          Version (optional)
          <input
            type="text"
            inputMode="numeric"
            aria-label={`Import version for ${skillId}`}
            value={versionText}
            onChange={(event) => setVersionText(event.target.value)}
            disabled={pending}
            placeholder="latest"
          />
        </label>
        <label>
          Alias (optional)
          <input
            type="text"
            aria-label={`Import alias for ${skillId}`}
            value={alias}
            onChange={(event) => setAlias(event.target.value)}
            disabled={pending}
            maxLength={256}
          />
        </label>
        <label>
          Scope (optional)
          <select value={scope} onChange={(event) => setScope(event.target.value)} disabled={pending}>
            <option value="">Session default</option>
            <option value="global">global</option>
            <option value="project">project</option>
            <option value="local">local</option>
          </select>
        </label>
      </div>
      <label className="rw-check">
        <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} disabled={pending} />
        I trust this source and want to import {skillId}
        {scope.trim() ? ` into ${scope.trim()} scope` : ""}.
      </label>
      <div className="rw-actions">
        <button type="button" className="rw-button rw-secondary" onClick={() => setOpen(false)} disabled={pending}>
          Cancel
        </button>
        <button type="button" className="rw-button rw-primary" onClick={() => void run()} disabled={pending}>
          {pending ? "Importing…" : "Confirm import"}
        </button>
      </div>
    </div>
  );
}
