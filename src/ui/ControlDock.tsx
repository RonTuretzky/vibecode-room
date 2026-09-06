import { useEffect, useRef, useState, type ReactNode } from "react";

export interface ControlDockProps {
  children: ReactNode;
  initialExpanded?: boolean;
  collapseSignal?: number;
}

/** One persistent controls panel. It closes on an explicit toggle, Escape,
 * outside press or another panel opening; reading it never starts a timeout. */
export function ControlDock({ children, initialExpanded = false, collapseSignal = 0 }: ControlDockProps) {
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(initialExpanded);
  useEffect(() => { if (collapseSignal > 0) setExpanded(false); }, [collapseSignal]);
  useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setExpanded(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setExpanded(false); toggle.current?.focus(); }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", key); };
  }, [expanded]);
  return <div className="control-dock" data-testid="control-dock" data-expanded={String(expanded)} ref={root}>
    <button ref={toggle} type="button" className="ctl-button dock-toggle" data-testid="control-dock-button"
      aria-expanded={expanded} aria-label="Room controls" title="Plant ideas, find projects, and explore the room"
      onClick={() => setExpanded(open => !open)}>⚙ Controls</button>
    <div className="control-dock-tray" data-testid="control-dock-tray" inert={!expanded}>{children}</div>
  </div>;
}
