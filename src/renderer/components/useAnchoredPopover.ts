import { useLayoutEffect, useState, type RefObject } from "react";

/** Position a native top-layer popover near its trigger, within the viewport. */
export function useAnchoredPopover(
  open: boolean,
  trigger: RefObject<HTMLElement | null>,
  popover: RefObject<HTMLElement | null>,
) {
  const [position, setPosition] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    if (!open) return;
    popover.current?.showPopover();
    const place = () => {
      if (!trigger.current || !popover.current) return;
      const anchor = trigger.current.getBoundingClientRect();
      const rect = popover.current.getBoundingClientRect();
      const above = anchor.top - rect.height - 12;
      setPosition({
        left: Math.max(
          12,
          Math.min(anchor.left, window.innerWidth - rect.width - 12),
        ),
        top:
          above >= 54
            ? above
            : Math.max(
                54,
                Math.min(
                  anchor.bottom + 12,
                  window.innerHeight - rect.height - 12,
                ),
              ),
      });
    };
    place();
    const observer = new ResizeObserver(place);
    if (popover.current) observer.observe(popover.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, trigger, popover]);
  return position;
}
