import { ShieldCheck } from "lucide-react";
import { ComposerPicker } from "./ComposerPicker";

const modeLabel = (name: string) =>
  name === "ask"
    ? "Ask before tools"
    : name === "accept-edits"
      ? "Accept edits"
      : name === "plan"
        ? "Plan"
        : name || "Default from Vibe";
const description = (name: string) =>
  name === "ask"
    ? "Request approval before tool execution"
    : name === "accept-edits"
      ? "Allow edits using Vibe's permission policy"
      : name === "plan"
        ? "Explore and plan before implementation"
        : "Use this configured Vibe agent";

export function ModePicker({
  agents,
  current,
  disabled,
  onSelect,
}: {
  agents: { name: string }[];
  current: string;
  disabled: boolean;
  onSelect: (name: string) => void | Promise<void>;
}) {
  return (
    <ComposerPicker
      label="Agent mode"
      current={current}
      icon={ShieldCheck}
      title="Choose agent mode"
      subtitle="Permissions and workflow"
      options={agents.map(({ name }) => ({
        value: name,
        label: modeLabel(name),
        detail: description(name),
      }))}
      footer="Vibe manages tool permissions for each mode."
      disabled={disabled}
      onSelect={onSelect}
    />
  );
}
