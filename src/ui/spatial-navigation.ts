/** Shared room/guest navigation vocabulary. Only these keys cross the LAN. */
export const NAVIGATION_GROUPS = [
  { label: "Move", buttons: [
    { key: "w", label: "Move forward", icon: "↑", position: "north" },
    { key: "a", label: "Move left", icon: "←", position: "west" },
    { key: "s", label: "Move backward", icon: "↓", position: "south" },
    { key: "d", label: "Move right", icon: "→", position: "east" },
  ] },
  { label: "Look", buttons: [
    { key: "arrowup", label: "Raise view", icon: "↗", position: "north" },
    { key: "arrowleft", label: "Turn left", icon: "↶", position: "west" },
    { key: "arrowdown", label: "Lower view", icon: "↘", position: "south" },
    { key: "arrowright", label: "Turn right", icon: "↷", position: "east" },
  ] },
] as const;
export const NAVIGATION_KEYS = ["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright", "=", "-", "home"] as const;
export type NavigationKey = typeof NAVIGATION_KEYS[number];
export function isNavigationKey(key: string): key is NavigationKey {
  return (NAVIGATION_KEYS as readonly string[]).includes(key);
}

/** Each input source owns its releases; a guest cannot release a local hold. */
export class NavigationHolds {
  private sources = new Map<string, Set<string>>();
  set(source: string, keys: readonly string[]) {
    const valid = keys.filter(isNavigationKey);
    if (valid.length) this.sources.set(source, new Set(valid));
    else this.sources.delete(source);
  }
  keys(): Set<string> { return new Set([...this.sources.values()].flatMap(keys => [...keys])); }
}
export const sceneNavigation = new NavigationHolds();

export function navigationAxes(keys: ReadonlySet<string>) {
  const axis = (positive: string, negative: string) => Number(keys.has(positive)) - Number(keys.has(negative));
  const forward = axis("w", "s"), right = axis("d", "a");
  const length = Math.max(1, Math.hypot(forward, right));
  return { forward: forward / length, right: right / length,
    turn: axis("arrowleft", "arrowright"), elevation: axis("arrowup", "arrowdown"), zoom: axis("-", "=") };
}
