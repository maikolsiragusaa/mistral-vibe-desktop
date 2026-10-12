import { useMemo } from "react";
import { Cpu } from "lucide-react";
import { normalizeModelInventory } from "../models";
import { ComposerPicker } from "./ComposerPicker";

export interface ModelPickerProps {
  models: readonly unknown[];
  activeModel?: unknown;
  activeContextWindow?: number;
  verifiedAliases?: readonly string[];
  disabled?: boolean;
  onSelect: (
    modelAlias: string,
    reasoningEffort?: string,
  ) => void | Promise<void>;
}

export function ModelPicker({
  models: source,
  activeModel: activeSource,
  activeContextWindow,
  verifiedAliases = [],
  disabled = false,
  onSelect,
}: ModelPickerProps) {
  const models = useMemo(() => normalizeModelInventory(source), [source]);
  const active = useMemo(
    () => normalizeModelInventory([activeSource])[0],
    [activeSource],
  );
  return (
    <ComposerPicker
      label="Model"
      current={active?.alias || ""}
      icon={Cpu}
      title="Choose a model"
      subtitle="Configured in your Vibe session"
      searchable
      disabled={disabled}
      footer="Reasoning effort is set with the adjacent picker."
      options={models.map((model) => {
        const context =
          model.maxContextLength ||
          (model.alias === active?.alias ? activeContextWindow : undefined);
        return {
          value: model.alias,
          label: model.displayName,
          detail: [
            model.provider || model.alias,
            context
              ? `${(context / 1000).toLocaleString()}k context`
              : undefined,
            model.supportsImages ? "Images" : undefined,
          ]
            .filter(Boolean)
            .join(" · "),
          metadata:
            model.verifiedUsable || verifiedAliases.includes(model.alias)
              ? "Verified"
              : undefined,
          title: `${model.displayName}\nAPI ID: ${model.apiId || model.alias}\nProvider: ${model.provider || "—"}`,
        };
      })}
      onSelect={(alias) => {
        const model = models.find((item) => item.alias === alias);
        // Preserve a supported effort; otherwise use the model's configured default.
        const effort =
          active?.thinking && model?.thinkingLevels?.includes(active.thinking)
            ? active.thinking
            : model?.thinking;
        return onSelect(alias, effort);
      }}
    />
  );
}
