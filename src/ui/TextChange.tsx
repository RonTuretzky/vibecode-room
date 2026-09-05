import { useState } from "react";
export function TextChange({
  upid,
  branch,
  grow = false,
}: {
  upid: string;
  branch?: string;
  grow?: boolean;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  return (
    <form
      className="text-change"
      aria-label="Type a change"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!text.trim() || busy) return;
        setBusy(true);
        setMessage("");
        try {
          const response = await fetch(
            `/api/process/${encodeURIComponent(upid)}/change`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ text, branch, grow }),
            },
          );
          const body = await response.json();
          if (!response.ok)
            throw new Error(body.error ?? "Change could not be submitted");
          setText("");
          setMessage("Request submitted. Follow its progress in Projects.");
        } catch (error) {
          setMessage(String(error));
        } finally {
          setBusy(false);
        }
      }}
    >
      <label>
        Describe the change
        <textarea
          aria-label="Describe the change"
          value={text}
          maxLength={4000}
          onChange={(event) => setText(event.target.value)}
          placeholder="What should work differently?"
        />
      </label>
      <button
        type="submit"
        className="ctl-button"
        disabled={busy || !text.trim()}
      >
        {busy
          ? "Submitting…"
          : grow
            ? "Grow branch with change"
            : "Apply change"}
      </button>
      {message && <p role="status">{message}</p>}
    </form>
  );
}
