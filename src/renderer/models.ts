/**
 * The desktop picker receives the model projection exposed by Vibe's
 * runtime/read method. The runtime, rather than this renderer, is the
 * authority for which configured models can be selected in the session.
 */
export interface RuntimeModelOption {
  /** Vibe selection handle used by config/model/write. */
  alias: string;
  displayName: string;
  /** Canonical provider model name from ModelConfigView.name, when exposed. */
  apiId?: string;
  /** Provider identity is optional in Vibe's public ModelConfigView. */
  provider?: string;
  category?: string;
  thinking?: string;
  thinkingLevels?: string[];
  maxContextLength?: number;
  supportsImages?: boolean;
  imageDelivery?: string;
  /** Only populated when the runtime includes current, attributable pricing. */
  pricing?: RuntimeModelPricing;
  /** Present only if the source runtime explicitly reports successful use. */
  verifiedUsable?: boolean;
}

export interface RuntimeModelPricing {
  currency: string;
  inputPerMillion?: number;
  outputPerMillion?: number;
  cachedInputPerMillion?: number;
  sourceUrl: string;
  updatedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | undefined {
  return values.find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function normalizeProvider(value: unknown): string | undefined {
  if (typeof value === "string") return firstString(value);
  if (!isRecord(value)) return undefined;
  return firstString(value.name, value.id, value.provider);
}

function normalizeLevels(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const levels = value.filter(
    (level): level is string => typeof level === "string" && level.trim().length > 0,
  );
  return [...new Set(levels)];
}

function normalizePricing(value: unknown): RuntimeModelPricing | undefined {
  if (!isRecord(value)) return undefined;
  const sourceUrl = firstString(value.sourceUrl, value.source_url);
  const updatedAt = firstString(value.updatedAt, value.updated_at);
  const currency = firstString(value.currency);
  if (!sourceUrl || !updatedAt || !currency || !Number.isFinite(Date.parse(updatedAt)))
    return undefined;

  let source: URL;
  try {
    source = new URL(sourceUrl);
  } catch {
    return undefined;
  }
  const officialPricingPage =
    source.protocol === "https:" &&
    source.hostname === "docs.mistral.ai" &&
    source.pathname.startsWith("/inference/pricing");
  if (!officialPricingPage) return undefined;

  const inputPerMillion = finiteNumber(
    value.inputPerMillion ?? value.input_per_million,
  );
  const outputPerMillion = finiteNumber(
    value.outputPerMillion ?? value.output_per_million,
  );
  const cachedInputPerMillion = finiteNumber(
    value.cachedInputPerMillion ?? value.cached_input_per_million,
  );
  if (inputPerMillion === undefined && outputPerMillion === undefined)
    return undefined;

  return {
    currency,
    ...(inputPerMillion !== undefined ? { inputPerMillion } : {}),
    ...(outputPerMillion !== undefined ? { outputPerMillion } : {}),
    ...(cachedInputPerMillion !== undefined ? { cachedInputPerMillion } : {}),
    sourceUrl: source.toString(),
    updatedAt,
  };
}

function normalizeModel(value: unknown): RuntimeModelOption | undefined {
  if (typeof value === "string") {
    const alias = firstString(value);
    return alias ? { alias, displayName: alias } : undefined;
  }
  if (!isRecord(value)) return undefined;

  const alias = firstString(value.alias, value.modelAlias, value.model_alias);
  if (!alias) return undefined;

  // `name` is the canonical API model identifier in Vibe's ModelConfigView;
  // aliases stay separate because they are what config/model/write selects.
  const apiId = firstString(
    value.name,
    value.apiId,
    value.api_id,
    value.modelId,
    value.model_id,
    value.canonicalName,
    value.canonical_name,
  );
  const displayName = firstString(
    value.displayName,
    value.display_name,
    value.title,
  ) || alias;
  const provider = normalizeProvider(value.provider ?? value.providerName ?? value.provider_name);
  const category = firstString(
    value.category,
    value.modelCategory,
    value.model_category,
    value.group,
  );
  const thinkingLevels = normalizeLevels(
    value.thinkingLevels ?? value.thinking_levels ?? value.reasoningLevels ?? value.reasoning_levels,
  );
  const maxContextLength = finiteNumber(
    value.maxContextLength ?? value.max_context_length ?? value.contextLength ?? value.context_length,
  );
  const supportsImages =
    typeof value.supportsImages === "boolean"
      ? value.supportsImages
      : typeof value.supports_images === "boolean"
        ? value.supports_images
        : undefined;
  const imageDelivery = firstString(value.imageDelivery, value.image_delivery);
  const pricing = normalizePricing(value.pricing);
  const verifiedUsable =
    typeof value.verifiedUsable === "boolean"
      ? value.verifiedUsable
      : typeof value.verified_usable === "boolean"
        ? value.verified_usable
        : undefined;

  return {
    alias,
    displayName,
    ...(apiId ? { apiId } : {}),
    ...(provider ? { provider } : {}),
    ...(category ? { category } : {}),
    ...(firstString(value.thinking) ? { thinking: firstString(value.thinking) } : {}),
    ...(thinkingLevels ? { thinkingLevels } : {}),
    ...(maxContextLength !== undefined ? { maxContextLength } : {}),
    ...(supportsImages !== undefined ? { supportsImages } : {}),
    ...(imageDelivery ? { imageDelivery } : {}),
    ...(pricing ? { pricing } : {}),
    ...(verifiedUsable !== undefined ? { verifiedUsable } : {}),
  };
}

function getRuntimeModelArray(source: unknown): unknown[] {
  if (Array.isArray(source)) return source;
  if (!isRecord(source)) return [];

  // Accept the app-server runtime object or its config object. Deliberately do
  // not inspect catalog fields: catalog knowledge is not session selectability.
  const config = isRecord(source.config) ? source.config : source;
  return Array.isArray(config.models) ? config.models : [];
}

/**
 * Normalize the app-server's configured/selectable inventory without adding
 * catalog models. In Vibe 2.26.1, config.available_models() applies
 * `allowed_models` before these records are sent to runtime/read.
 */
export function normalizeModelInventory(source: unknown): RuntimeModelOption[] {
  const seen = new Set<string>();
  const models: RuntimeModelOption[] = [];
  for (const item of getRuntimeModelArray(source)) {
    const normalized = normalizeModel(item);
    if (!normalized || seen.has(normalized.alias)) continue;
    seen.add(normalized.alias);
    models.push(normalized);
  }
  return models;
}

/** Returns a useful display group without guessing model capabilities. */
export function modelCategory(model: RuntimeModelOption): string {
  if (model.category) return model.category;
  if (model.provider) return model.provider;
  return "Configured";
}
