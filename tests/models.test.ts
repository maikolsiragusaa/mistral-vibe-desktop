import { test } from "node:test";
import assert from "node:assert/strict";
import { modelCategory, normalizeModelInventory } from "../src/renderer/models.ts";

test("normalizes GLM models from the configured Vibe runtime records", () => {
  const models = normalizeModelInventory({
    config: {
      models: [
        {
          name: "zai-glm-5-2",
          alias: "zai-glm-5-2",
          displayName: "Z.ai GLM 5.2",
          maxContextLength: 1000000,
        },
        {
          name: "zai-glm-5-3",
          alias: "zai-glm-5-3",
          displayName: "Z.ai GLM 5.3",
          thinkingLevels: ["low", "high", "max"],
          maxContextLength: 1000000,
        },
      ],
    },
  });

  assert.deepEqual(
    models.map(({ alias, apiId, displayName }) => ({ alias, apiId, displayName })),
    [
      {
        alias: "zai-glm-5-2",
        apiId: "zai-glm-5-2",
        displayName: "Z.ai GLM 5.2",
      },
      {
        alias: "zai-glm-5-3",
        apiId: "zai-glm-5-3",
        displayName: "Z.ai GLM 5.3",
      },
    ],
  );
  assert.deepEqual(models[1].thinkingLevels, ["low", "high", "max"]);
  assert.equal(models[0].thinkingLevels, undefined);
  assert.equal(models[0].maxContextLength, 1000000);
  assert.equal(models[1].maxContextLength, 1000000);
});

test("only runtime-exposed models become selectable when its inventory is restricted", () => {
  const models = normalizeModelInventory({
    config: {
      // `available_models()` has already applied Vibe's `allowed_models` rule.
      models: [
        {
          name: "zai-glm-5-3",
          alias: "glm-current",
          displayName: "Z.ai GLM 5.3",
        },
      ],
    },
    // Catalog entries are knowledge only and must not leak into this picker.
    modelCatalog: [
      { name: "zai-glm-5-2", alias: "zai-glm-5-2", displayName: "Z.ai GLM 5.2" },
      { name: "mistral-large-4", alias: "mistral-large-4", displayName: "Mistral Large 4" },
    ],
  });

  assert.deepEqual(models.map((model) => model.alias), ["glm-current"]);
  assert.equal(models.some((model) => model.alias === "zai-glm-5-2"), false);
  assert.equal(models.some((model) => model.alias === "mistral-large-4"), false);
});

test("preserves the provider and API ID for a custom OpenAI-compatible model", () => {
  const [model] = normalizeModelInventory([
    {
      name: "qwen-coder-32b-instruct",
      alias: "workstation-coder",
      displayName: "Workstation Coder",
      provider: { name: "local-openai" },
      category: "Coding",
      thinkingLevels: ["off"],
      maxContextLength: 32768,
      supportsImages: false,
    },
  ]);

  assert.equal(model.alias, "workstation-coder");
  assert.equal(model.apiId, "qwen-coder-32b-instruct");
  assert.equal(model.provider, "local-openai");
  assert.equal(modelCategory(model), "Coding");
  assert.deepEqual(model.thinkingLevels, ["off"]);
  assert.equal(model.maxContextLength, 32768);
  assert.equal(model.supportsImages, false);
});

test("does not treat configured price numbers as authoritative API pricing", () => {
  const [model] = normalizeModelInventory([
    {
      name: "local-model",
      alias: "local",
      displayName: "Local model",
      provider: "local-openai",
      inputPrice: 0.2,
      outputPrice: 0.4,
      input_price: 0.2,
      output_price: 0.4,
    },
  ]);

  assert.equal(model.pricing, undefined);
});

test("keeps pricing only with an official source and update time", () => {
  const [model] = normalizeModelInventory([
    {
      name: "mistral-medium-3-5",
      alias: "medium",
      displayName: "Mistral Medium 3.5",
      pricing: {
        currency: "USD",
        inputPerMillion: 1.5,
        outputPerMillion: 7.5,
        sourceUrl: "https://docs.mistral.ai/inference/pricing",
        updatedAt: "2026-10-12T00:00:00Z",
      },
    },
  ]);

  assert.deepEqual(model.pricing, {
    currency: "USD",
    inputPerMillion: 1.5,
    outputPerMillion: 7.5,
    sourceUrl: "https://docs.mistral.ai/inference/pricing",
    updatedAt: "2026-10-12T00:00:00Z",
  });
});
