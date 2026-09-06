import { useEffect, useRef } from "react";
import { bindNavigationPad } from "./navigation-pad-input";
import { NAVIGATION_GROUPS, NAVIGATION_HEIGHT, sceneNavigation } from "./spatial-navigation";

export function NavigationPad({ locked = false, onHome }: { locked?: boolean; onHome: () => void }) {
  const root = useRef<HTMLElement>(null);
  useEffect(() => bindNavigationPad(root.current!, keys => sceneNavigation.set("controls", keys)), []);
  return <section ref={root} className="navigation-pad" data-testid="navigation-pad" aria-label="Spatial navigation">
    <div className="navigation-heading"><h3>Explore</h3>
      <label className="navigation-dwell"><input type="checkbox" data-nav-dwell disabled={locked} /> Dwell to move</label>
    </div>
    {locked ? <p>This corner projector view is fixed. Explore from the desktop view.</p> :
      <p>Hold a direction, or turn on dwell and rest your pointer on it. Move away to stop.</p>}
    <div className="navigation-pads">
      {NAVIGATION_GROUPS.map(group => <div key={group.label} className="navigation-group" role="group" aria-label={group.label}>
        <span>{group.label}</span><div className="navigation-cross">
          {group.buttons.map(button => <button key={button.key} type="button" className={`navigation-direction ${button.position}`}
            data-nav-key={button.key} data-testid={`nav-${button.key}`} disabled={locked}
            aria-label={button.label} title={button.label}><span aria-hidden="true">{button.icon}</span></button>)}
        </div>
      </div>)}
    </div>
    <div className="navigation-height" role="group" aria-label="Camera height">
      <span>Height</span>{NAVIGATION_HEIGHT.map(button => <button key={button.key} type="button" className="navigation-direction"
        data-nav-key={button.key} data-testid={`nav-${button.key}`} disabled={locked} aria-label={button.label}>{button.text}</button>)}
    </div>
    <div className="navigation-zoom" role="group" aria-label="Zoom and reset">
      <button type="button" className="navigation-direction" data-nav-key="=" disabled={locked} aria-label="Zoom in">＋</button>
      <button type="button" className="navigation-direction" data-nav-key="-" disabled={locked} aria-label="Zoom out">−</button>
      <button type="button" className="ctl-button" data-nav-stop disabled={locked} onClick={onHome}>Back to projects</button>
    </div>
  </section>;
}
