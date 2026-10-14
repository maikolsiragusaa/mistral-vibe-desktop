import { ArrowUpRight, X } from "lucide-react";

const bridge = window.vibe;

interface Props {
  onClose: () => void;
}

/** Work is Mistral-hosted. The local app-server is not a Work API.
 *
 * This panel never fakes remote tasks: it links to the official Work surface
 * and documents that scheduled tasks run in Work mode only, on Workflows
 * infrastructure, with Skills/Connectors/Web/Libraries/Projects.
 */
export function WorkPanel({ onClose }: Props) {
  const openWork = (path: string) =>
    void bridge?.openExternal(`https://mistral.ai/${path}`).catch(() => {});
  return (
    <section className="work-panel" aria-label="Mistral Work">
      <header>
        <div>
          <p className="eyebrow">Work</p>
          <h2>Mistral Work</h2>
          <small>Hosted generalist work. No local replica is claimed.</small>
        </div>
        <button className="icon-button" aria-label="Close Work panel" onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      <p>
        Work runs on Mistral infrastructure: research, documents, inbox triage,
        data analysis and hosted automations. The desktop does not expose a
        private Work API and does not scrape account pages.
      </p>
      <h3>Official surfaces</h3>
      <div className="button-row">
        <button className="secondary" onClick={() => openWork("products/vibe")}>
          Open Vibe Work <ArrowUpRight size={13} />
        </button>
        <button
          className="text-button"
          onClick={() =>
            void bridge?.openExternal("https://docs.mistral.ai/vibe/work/scheduled-tasks")
          }
        >
          Scheduled tasks docs <ArrowUpRight size={13} />
        </button>
      </div>
      <h3>Scheduled tasks</h3>
      <p>
        Time-based prompts (once, daily, weekly, monthly) run unattended in Work
        and notify on completion. Create and manage them from Tasks → Scheduled
        in Vibe Work, or ask Work in chat to schedule the current prompt.
        Pre-authorize sensitive Connector actions with Always allow if the task
        must complete without you.
      </p>
      <small>
        No hosted task list is mirrored here: no stable public API is available
        to the desktop for remote Work tasks.
      </small>
    </section>
  );
}
