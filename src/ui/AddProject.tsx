import { useEffect, useRef, useState } from "react";
export function AddProject({ onClose }: { onClose: () => void }) {
  const [url, setUrl] = useState("");
  const [context, setContext] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    first.current?.focus();
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
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
        aria-label="Add project"
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
              throw new Error(body.error ?? "Project could not be added");
            onClose();
          } catch (error) {
            setError(String(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        <h2>Add project</h2>
        <p>
          Import a GitHub repository to study it and grow changes, or describe a
          new project.
        </p>
        <label>
          Repository or reference URL
          <input
            ref={first}
            aria-label="Repository or reference URL"
            type="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://github.com/owner/repo"
          />
        </label>
        <label>
          What would you like to do?
          <textarea
            aria-label="What would you like to do?"
            value={context}
            maxLength={4000}
            onChange={(event) => setContext(event.target.value)}
            placeholder="Leave blank to study the repository first."
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <button
          className="ctl-button"
          disabled={busy || (!url.trim() && !context.trim())}
          type="submit"
        >
          {busy ? "Adding…" : "Add to garden"}
        </button>
        <button className="ctl-button" type="button" onClick={onClose}>
          Cancel
        </button>
      </form>
    </div>
  );
}
