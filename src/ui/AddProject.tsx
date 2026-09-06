import { useEffect, useRef, useState } from "react";
export function AddProject({ onClose }: { onClose: () => void }) {
  const [url, setUrl] = useState("");
  const [context, setContext] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const first = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    first.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.offsetParent !== null) previous.focus();
      else document.querySelector<HTMLButtonElement>('[data-testid="control-dock-button"]')?.focus();
    };
  }, []);
  return (
    <div
      className="detail-overlay add-project-overlay"
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key === "Tab") {
          const fields = [
            ...event.currentTarget.querySelectorAll<HTMLElement>(
              "input, textarea, button:not(:disabled), a[href]",
            ),
          ];
          const first = fields[0];
          const last = fields.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <form
        className="add-project-card"
        role="dialog"
        aria-modal="true"
        aria-label="Plant an idea"
        onClick={(event) => event.stopPropagation()}
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          setError("");
          try {
            const response = await fetch("/api/projects/import", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                url: url.trim(),
                context: context.trim(),
              }),
            });
            const body = await response.json();
            if (!response.ok)
              throw new Error(body.error ?? "Your idea could not be planted");
            onClose();
          } catch (error) {
            setError(String(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        <h2>Plant an idea</h2>
        <p>
          Describe what you want to grow. You can also start from an existing
          GitHub repository.
        </p>
        <label>
          What would you like to do?
          <textarea ref={first} aria-label="What would you like to do?"
            value={context} maxLength={4000} onChange={event => setContext(event.target.value)}
            placeholder="An idea, a tool you wish existed, or a change you want to make…" />
        </label>
        <label>
          Repository or reference URL (optional)
          <input aria-label="Repository or reference URL" type="url" value={url}
            onChange={event => setUrl(event.target.value)} placeholder="https://github.com/owner/repo" />
        </label>
        <p className="plant-hint">Just a repository link? We’ll study it first so you can grow changes from it.</p>
        {error && <p role="alert">{error}</p>}
        <button
          className="ctl-button"
          disabled={busy || (!url.trim() && !context.trim())}
          type="submit"
        >
          {busy ? "Planting…" : "Plant in the garden"}
        </button>
        <button className="ctl-button" type="button" onClick={onClose}>
          Cancel
        </button>
      </form>
    </div>
  );
}
