import { Component, type ReactNode } from "react";

/** A secondary panel failure must leave the running session accessible. */
export class PanelBoundary extends Component<
  {
    children: ReactNode;
    onClose: () => void;
    name: string;
    modal?: boolean;
  },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        className={this.props.modal ? "modal-backdrop" : "workspace-loading"}
      >
        <section
          className="modal"
          role="alert"
          aria-label={`${this.props.name} unavailable`}
        >
          <h2>{this.props.name} could not open</h2>
          <p>
            Your session remains available. Reopen the panel or restart the
            desktop to reload its files.
          </p>
          <button onClick={this.props.onClose}>Return to session</button>
        </section>
      </div>
    );
  }
}
