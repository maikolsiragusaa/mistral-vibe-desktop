import assert from "node:assert/strict";
import test from "node:test";
import { classifyTeleportReadiness } from "../src/renderer/cloud-preflight.ts";

test("non-git directory is incompatible, never verified", () => {
  const result = classifyTeleportReadiness({
    isGitRepository: false,
    branch: null,
    provider: "mistral",
    activeModelAlias: "mistral-medium-3.5",
    hasApiKey: true,
    backendReady: true,
  });
  assert.equal(result.gitRepo, "incompatible");
  assert.equal(result.overall, "incompatible");
});

test("third-party provider is incompatible even when configured", () => {
  const result = classifyTeleportReadiness({
    isGitRepository: true,
    branch: "main",
    provider: "glm",
    activeModelAlias: "glm-5.3",
    hasApiKey: true,
    backendReady: true,
  });
  assert.equal(result.model, "incompatible");
  assert.equal(result.overall, "incompatible");
});

test("custom provider without record stays unknown, never satisfied", () => {
  const result = classifyTeleportReadiness({
    isGitRepository: true,
    branch: "main",
    provider: null,
    activeModelAlias: "my-custom-model",
    hasApiKey: true,
    backendReady: true,
  });
  assert.equal(result.model, "unknown");
  assert.equal(result.overall, "unknown");
});

test("missing credentials are incompatible; tier and github app always unknown", () => {
  const result = classifyTeleportReadiness({
    isGitRepository: true,
    branch: "main",
    provider: "mistral",
    activeModelAlias: "mistral-medium-3.5",
    hasApiKey: false,
    backendReady: true,
  });
  assert.equal(result.credentials, "incompatible");
  assert.equal(result.accountTier, "unknown");
  assert.equal(result.githubApp, "unknown");
  assert.equal(result.overall, "incompatible");
});

test("unchecked git and inactive backend are unknown, not verified", () => {
  const result = classifyTeleportReadiness({
    isGitRepository: null,
    branch: null,
    provider: "mistral",
    activeModelAlias: "mistral-medium-3.5",
    hasApiKey: true,
    backendReady: false,
  });
  assert.equal(result.gitRepo, "unknown");
  assert.equal(result.model, "unknown");
  assert.equal(result.overall, "unknown");
});

test("fully verifiable local requirements pass but overall stays unknown until Mistral decides", () => {
  const result = classifyTeleportReadiness({
    isGitRepository: true,
    branch: "main",
    provider: "mistral",
    activeModelAlias: "mistral-medium-3.5",
    hasApiKey: true,
    backendReady: true,
  });
  assert.equal(result.gitRepo, "verified");
  assert.equal(result.model, "verified");
  assert.equal(result.credentials, "verified");
  assert.equal(result.overall, "unknown");
});
