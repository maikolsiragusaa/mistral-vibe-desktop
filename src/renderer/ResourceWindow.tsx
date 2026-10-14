import { useEffect, useRef, useState } from "react";
import { Layers, X } from "lucide-react";
import { ResourcesWorkspace } from "./ResourcesWorkspace";
import type { ComponentProps } from "react";

type Props = ComponentProps<typeof ResourcesWorkspace> & {
  onClose: () => void;
};

/** A workspace management window; the conversation stays mounted underneath. */
export function ResourceWindow({ onClose, ...resources }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [closing, setClosing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const close = () => {
    if (closing) return;
    setClosing(true);
    const reduced =
      document.documentElement.dataset.motion === "off" ||
      matchMedia("(prefers-reduced-motion: reduce)").matches;
    timer.current = setTimeout(onClose, reduced ? 0 : 160);
  };
  useEffect(() => {
    dialog.current?.showModal();
    return () => {
      if (timer.current) clearTimeout(timer.current);
      dialog.current?.close();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className={`resource-window ${closing ? "is-closing" : ""}`}
      aria-label="Workspace management"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const box = dialog.current!.getBoundingClientRect();
          if (
            event.clientX < box.left ||
            event.clientX > box.right ||
            event.clientY < box.top ||
            event.clientY > box.bottom
          )
            close();
        }
      }}
    >
      <header className="resource-window-titlebar">
        <span>
          <Layers size={16} /> Workspace management
        </span>
        <button
          className="icon-button"
          aria-label="Close workspace management"
          onClick={close}
          autoFocus
        >
          <X size={18} />
        </button>
      </header>
      <div className="resource-window-body">
        <ResourcesWorkspace {...resources} />
      </div>
    </dialog>
  );
}
