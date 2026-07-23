// GET /submit — the page a phone lands on after scanning the wall's QR overlay.
// Deliberately self-contained (inline CSS/JS, no build step, no framework): it is
// served by the API process directly (main app AND the dedicated phone listener),
// so it must work without the Vite bundle and on any mobile browser.
//
// The refactored contract: CONTEXT is the primary field — describe what the
// fleet should build — and the LINK is optional (any http(s) URL; a GitHub
// repo link gets cloned and grounds the build). It POSTs { context, url } to
// /api/projects/import and shows the spawned project's callsign on success.
export function importPageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Vibersyn — add a project</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #0b0e14; color: #e6e9f0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  main { width: min(28rem, calc(100vw - 3rem)); padding: 2rem 0; }
  h1 { font-size: 1.3rem; margin: 0 0 0.25rem; }
  p.hint { color: #8b93a7; font-size: 0.9rem; margin: 0 0 1.25rem; }
  form { display: flex; flex-direction: column; gap: 0.75rem; }
  textarea, input[type="url"] {
    padding: 0.85rem 1rem; font-size: 1rem; border-radius: 0.75rem;
    border: 1px solid #2a3040; background: #131826; color: inherit; outline: none;
    font-family: inherit;
  }
  textarea { resize: vertical; min-height: 5.5rem; }
  textarea:focus, input[type="url"]:focus { border-color: #5b8cff; }
  label { color: #8b93a7; font-size: 0.8rem; margin-bottom: -0.35rem; }
  button {
    padding: 0.85rem 1rem; font-size: 1rem; font-weight: 600; border-radius: 0.75rem;
    border: none; background: #5b8cff; color: #0b0e14; cursor: pointer;
  }
  button:disabled { opacity: 0.5; }
  #status { min-height: 1.5rem; font-size: 0.95rem; margin-top: 0.75rem; }
  #status.ok { color: #6fe3a5; }
  #status.error { color: #ff7d90; }
</style>
</head>
<body>
<main>
  <h1>Add a project to the wall</h1>
  <p class="hint">Describe what the fleet should build. Optionally add a link — a GitHub repo gets cloned and grounds the build; any other link rides along as reference.</p>
  <form id="import-form">
    <label for="project-context">What should the fleet build?</label>
    <textarea id="project-context" autocomplete="off" autocapitalize="sentences"
              placeholder="A synthwave dashboard for our ticket queue…" autofocus></textarea>
    <label for="repo-url">Link (optional) — GitHub repo or any reference URL</label>
    <input id="repo-url" type="url" inputmode="url" autocomplete="off" autocapitalize="off"
           placeholder="https://github.com/owner/repo" />
    <button id="submit-button" type="submit">Add to the wall</button>
  </form>
  <div id="status" role="status"></div>
</main>
<script>
  const form = document.getElementById("import-form");
  const contextInput = document.getElementById("project-context");
  const urlInput = document.getElementById("repo-url");
  const button = document.getElementById("submit-button");
  const status = document.getElementById("status");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const context = contextInput.value.trim();
    const url = urlInput.value.trim();
    if (context === "" && url === "") {
      status.className = "error";
      status.textContent = "Add some context or a link.";
      return;
    }
    button.disabled = true;
    status.className = "";
    status.textContent = "Adding…";
    try {
      const response = await fetch("/api/projects/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ context, url }),
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok && body.ok) {
        status.className = "ok";
        status.textContent = body.callsign ? "\\u2713 " + body.callsign + " is on the wall" : "Added to the wall \\u2713";
        contextInput.value = "";
        urlInput.value = "";
      } else {
        status.className = "error";
        status.textContent = body.error || "That submission was rejected. Add some context or a valid link.";
      }
    } catch {
      status.className = "error";
      status.textContent = "Could not reach the Vibersyn server. Same Wi-Fi?";
    } finally {
      button.disabled = false;
    }
  });
</script>
</body>
</html>
`;
}
