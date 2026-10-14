/** Real Teleport preflight states.
 *
 * Each requirement is verified, incompatible or unknown. Anything that cannot
 * be verified locally stays unknown and the final check is delegated to the
 * Mistral controller — never shown as satisfied.
 */

export type PreflightState = "verified" | "incompatible" | "unknown";

export interface TeleportPreflightInput {
  /** git status says this is a real repository. Null = not checked/failed. */
  isGitRepository: boolean | null;
  branch: string | null;
  /** Provider record of the active model (e.g. "mistral"). Null = unknown. */
  provider: string | null;
  activeModelAlias: string | null;
  hasApiKey: boolean;
  backendReady: boolean;
}

export interface TeleportPreflight {
  gitRepo: PreflightState;
  model: PreflightState;
  credentials: PreflightState;
  accountTier: PreflightState;
  githubApp: PreflightState;
  overall: PreflightState;
  /** Machine-readable reasons for UI copy. */
  reasons: string[];
}

export function classifyTeleportReadiness(input: TeleportPreflightInput): TeleportPreflight {
  const reasons: string[] = [];

  let gitRepo: PreflightState;
  if (input.isGitRepository === true) {
    gitRepo = "verified";
    if (!input.branch) reasons.push("branch-unknown");
  } else if (input.isGitRepository === false) {
    gitRepo = "incompatible";
    reasons.push("not-a-git-repo");
  } else {
    gitRepo = "unknown";
    reasons.push("git-unchecked");
  }

  let model: PreflightState;
  const provider = (input.provider ?? "").trim().toLowerCase();
  if (!input.backendReady) {
    model = "unknown";
    reasons.push("backend-inactive");
  } else if (!input.activeModelAlias) {
    model = "unknown";
    reasons.push("model-unknown");
  } else if (provider === "mistral") {
    model = "verified";
  } else if (provider) {
    // Third-party (e.g. GLM) or custom providers cannot teleport, even when
    // configured in Vibe. Never infer from the display name — provider record only.
    model = "incompatible";
    reasons.push(`provider-${provider}`);
  } else {
    model = "unknown";
    reasons.push("provider-unknown");
  }

  let credentials: PreflightState;
  if (!input.backendReady) {
    credentials = "unknown";
  } else if (input.hasApiKey) {
    credentials = "verified";
  } else {
    credentials = "incompatible";
    reasons.push("no-credentials");
  }

  // Plan tier (Pro/Team/Enterprise), GitHub App install and permissions are
  // not verifiable from the desktop: always unknown, delegated to Mistral.
  const accountTier: PreflightState = "unknown";
  const githubApp: PreflightState = "unknown";
  reasons.push("tier-delegated", "github-app-delegated");

  let overall: PreflightState = "verified";
  for (const state of [gitRepo, model, credentials, accountTier, githubApp]) {
    if (state === "incompatible") {
      overall = "incompatible";
      break;
    }
    if (state === "unknown") overall = "unknown";
  }

  return { gitRepo, model, credentials, accountTier, githubApp, overall, reasons };
}
