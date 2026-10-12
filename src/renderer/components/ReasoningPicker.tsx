import { BrainCircuit } from "lucide-react";
import { ComposerPicker } from "./ComposerPicker";

const label = (value: string) =>
  value.replace(/[_-]/g, " ").replace(/^./, (char) => char.toUpperCase());

export function ReasoningPicker({
  levels,
  current,
  disabled,
  onSelect,
}: {
  levels: string[];
  current: string;
  disabled: boolean;
  onSelect: (level: string) => Promise<void>;
}) {
  return (
    <ComposerPicker
      label="Reasoning level"
      current={current}
      options={levels.map((value) => ({ value, label: label(value) }))}
      icon={BrainCircuit}
      title="Choose reasoning level"
      subtitle="Thinking effort supported by this model"
      footer="Vibe applies this level to your next turn."
      disabled={disabled}
      onSelect={onSelect}
    />
  );
}
