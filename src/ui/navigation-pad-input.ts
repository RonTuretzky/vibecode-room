/** Framework-free so the room and self-contained guest page use identical
 * hold/dwell cancellation. Keep all runtime dependencies inside this function. */
export function bindNavigationPad(root: HTMLElement, onHeld: (keys: string[]) => void) {
  const abort = new AbortController();
  const signal = abort.signal;
  const buttons = [...root.querySelectorAll<HTMLButtonElement>("button[data-nav-key]")];
  const holds = new Map<HTMLButtonElement, Set<string>>();
  const timers = new Map<HTMLButtonElement, ReturnType<typeof setTimeout>>();
  const dwell = root.querySelector<HTMLInputElement>("[data-nav-dwell]");
  const emit = () => onHeld([...holds].filter(([, sources]) => sources.size).map(([b]) => b.dataset.navKey!));
  const set = (button: HTMLButtonElement, source: string, on: boolean) => {
    let sources = holds.get(button);
    if (!sources) { sources = new Set(); holds.set(button, sources); }
    if (on && !button.disabled) sources.add(source); else sources.delete(source);
    button.dataset.held = sources.size ? "1" : "0";
    emit();
  };
  const clearTimer = (button: HTMLButtonElement) => {
    clearTimeout(timers.get(button)); timers.delete(button); delete button.dataset.dwelling;
  };
  const release = () => {
    for (const button of buttons) { clearTimer(button); holds.delete(button); button.dataset.held = "0"; }
    emit();
  };
  const usable = (button: HTMLButtonElement) => {
    const rect = button.getBoundingClientRect();
    const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return !document.hidden && !button.disabled && rect.width > 0 && rect.height > 0 && (top === button || (top !== null && button.contains(top)));
  };
  for (const button of buttons) {
    button.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      event.preventDefault(); button.focus({ preventScroll: true });
      clearTimer(button); button.setPointerCapture(event.pointerId);
      set(button, `pointer:${event.pointerId}`, true);
    }, { signal });
    const pointerEnd = (event: PointerEvent) => {
      set(button, `pointer:${event.pointerId}`, false);
      clearTimer(button); set(button, "hover", false);
    };
    button.addEventListener("pointerup", pointerEnd, { signal });
    button.addEventListener("pointercancel", pointerEnd, { signal });
    button.addEventListener("lostpointercapture", pointerEnd, { signal });
    button.addEventListener("pointerenter", event => {
      if (event.pointerType !== "mouse" || !dwell?.checked || button.disabled) return;
      clearTimer(button); button.dataset.dwelling = "1";
      timers.set(button, setTimeout(() => {
        clearTimer(button); if (usable(button)) set(button, "hover", true);
      }, 700));
    }, { signal });
    button.addEventListener("pointerleave", () => { clearTimer(button); set(button, "hover", false); }, { signal });
    button.addEventListener("keydown", event => {
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault(); event.stopPropagation(); set(button, "keyboard", true);
      }
    }, { signal });
    button.addEventListener("keyup", event => {
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault(); event.stopPropagation(); set(button, "keyboard", false);
      }
    }, { signal });
    button.addEventListener("blur", () => set(button, "keyboard", false), { signal });
    // Screen-reader activation produces a click without a pointer or key hold.
    button.addEventListener("click", event => {
      if (event.detail !== 0 || holds.get(button)?.size) return;
      set(button, "step", true);
      setTimeout(() => { if (!signal.aborted) set(button, "step", false); }, 180);
    }, { signal });
    button.addEventListener("navigation-dwell-start", () => set(button, "gesture", true), { signal });
    button.addEventListener("navigation-dwell-end", () => set(button, "gesture", false), { signal });
    button.addEventListener("contextmenu", event => event.preventDefault(), { signal });
  }
  root.addEventListener("navigation-cancel", release, { signal });
  dwell?.addEventListener("change", release, { signal });
  root.querySelector("[data-nav-stop]")?.addEventListener("click", release, { signal });
  window.addEventListener("blur", release, { signal });
  window.addEventListener("pagehide", release, { signal });
  window.addEventListener("keydown", event => { if (event.key === "Escape") release(); }, { signal });
  document.addEventListener("visibilitychange", release, { signal });
  // A menu closing or a dialog covering the pad must stop a held direction.
  const watchdog = setInterval(() => {
    for (const button of buttons) if ((holds.get(button)?.size || timers.has(button)) && !usable(button)) {
      clearTimer(button); holds.delete(button); button.dataset.held = "0"; emit();
    }
  }, 80);
  return () => { abort.abort(); clearInterval(watchdog); release(); };
}
