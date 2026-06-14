// Panopticon Pro UI. Vanilla ES module — no build step.
// Receives the event stream over /ws, drives commands over /api.

const $ = (s) => document.querySelector(s);
const api = (path, body, method = "POST") =>
  fetch(`/api/${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json());

// ── client state ──────────────────────────────────────────────────────────
const state = {
  processes: new Map(), // id → meta
  bubbles: new Map(), // id → suggestion
  outputs: new Map(), // id → [{role,text,artifact}]
  ticks: new Map(), // id → last note
  selected: null,
  answers: new Map(), // suggestionId → {questionId: choice}
};
const cardEls = new Map(); // id → {root, refs}
const bubbleEls = new Map(); // id → root

// ── websocket ───────────────────────────────────────────────────────────────
let ws;
function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => setConn(true);
  ws.onclose = () => {
    setConn(false);
    setTimeout(connect, 1000);
  };
  ws.onmessage = (ev) => handle(JSON.parse(ev.data));
}
function setConn(on) {
  const el = $("#conn");
  el.textContent = on ? "● live" : "● offline";
  el.className = "conn " + (on ? "on" : "off");
}

// ── event handling ────────────────────────────────────────────────────────
function handle(e) {
  switch (e.type) {
    case "snapshot":
      state.processes = new Map(e.processes.map((m) => [m.upid, m]));
      state.bubbles = new Map(e.suggestions.map((s) => [s.id, s]));
      state.selected = e.selected;
      applyConfig(e.config);
      $("#brainName").textContent = e.brain || "";
      renderAll();
      break;
    case "process.created":
    case "process.updated":
      state.processes.set(e.process.upid, e.process);
      upsertCard(e.process);
      if (e.process.upid === state.selected) renderSelected();
      break;
    case "process.killed":
      state.processes.delete(e.processId);
      removeCard(e.processId);
      if (state.selected === e.processId) selectProcess(null);
      break;
    case "process.output":
      recordOutput(e.output);
      break;
    case "process.tick":
      state.ticks.set(e.processId, e.note);
      updateTick(e.processId);
      break;
    case "process.selected":
      state.selected = e.processId;
      reflectSelection();
      break;
    case "suggestion.created":
    case "suggestion.updated":
      if (e.suggestion.state === "active") {
        state.bubbles.set(e.suggestion.id, e.suggestion);
        upsertBubble(e.suggestion);
      } else {
        state.bubbles.delete(e.suggestion.id);
        removeBubble(e.suggestion.id);
      }
      break;
    case "suggestion.expired":
      state.bubbles.delete(e.suggestionId);
      removeBubble(e.suggestionId);
      break;
    case "session.config":
      applyConfig(e.config);
      break;
  }
}

// ── process cards ───────────────────────────────────────────────────────────
function renderAll() {
  $("#board").innerHTML = "";
  cardEls.clear();
  for (const m of state.processes.values()) upsertCard(m);
  $("#bubbleList").innerHTML = "";
  bubbleEls.clear();
  [...state.bubbles.values()].forEach(upsertBubble);
  reflectSelection();
}

function upsertCard(meta) {
  let c = cardEls.get(meta.upid);
  if (!c) {
    const root = document.createElement("div");
    root.className = "card";
    root.onclick = (ev) => {
      if (ev.target.closest("button")) return;
      selectProcess(meta.upid);
    };
    root.innerHTML = `
      <div class="head"><span class="title"></span><span class="badge"></span></div>
      <div class="viz"><div class="empty">no output yet</div></div>
      <div class="tick"></div>
      <div class="foot">
        <span class="flags"></span>
        <button data-a="pause">⏸</button>
        <button data-a="fork">⑂</button>
        <button data-a="qr">▦</button>
        <button data-a="kill" class="danger">✕</button>
      </div>`;
    root.querySelector('[data-a="pause"]').onclick = () => togglePause(meta.upid);
    root.querySelector('[data-a="fork"]').onclick = () => api(`processes/${meta.upid}/fork`);
    root.querySelector('[data-a="kill"]').onclick = () => api(`processes/${meta.upid}/kill`);
    root.querySelector('[data-a="qr"]').onclick = () => showQR(meta);
    $("#board").appendChild(root);
    c = {
      root,
      title: root.querySelector(".title"),
      badge: root.querySelector(".badge"),
      viz: root.querySelector(".viz"),
      tick: root.querySelector(".tick"),
      flags: root.querySelector(".flags"),
      pauseBtn: root.querySelector('[data-a="pause"]'),
      lastArtifact: null,
    };
    cardEls.set(meta.upid, c);
  }
  c.title.textContent = meta.title;
  c.badge.textContent = meta.state;
  c.badge.className = "badge " + meta.state;
  c.root.classList.toggle("dead", meta.state === "dead");
  c.root.classList.toggle("selected", meta.upid === state.selected);
  c.pauseBtn.textContent = meta.state === "paused" ? "▶" : "⏸";
  c.flags.innerHTML = "";
  const flags = [meta.model.replace("claude-", ""), meta.mode.execution, meta.mode.safety];
  flags.forEach((f) => {
    const s = document.createElement("span");
    s.className = "flag" + (f === "dangerous" ? " live" : "");
    s.textContent = f;
    c.flags.appendChild(s);
  });
}

function removeCard(id) {
  cardEls.get(id)?.root.remove();
  cardEls.delete(id);
}
function updateTick(id) {
  const c = cardEls.get(id);
  if (c) c.tick.textContent = "› " + (state.ticks.get(id) || "");
}

function recordOutput(o) {
  const arr = state.outputs.get(o.processId) || [];
  arr.push(o);
  state.outputs.set(o.processId, arr);
  if (o.artifact) setViz(o.processId, o.artifact);
  if (o.processId === state.selected) renderSelected();
  if (o.text) {
    const c = cardEls.get(o.processId);
    if (c) c.tick.textContent = "› " + o.text.slice(0, 60);
  }
}

function setViz(id, artifact) {
  const c = cardEls.get(id);
  if (!c) return;
  const sig = JSON.stringify(artifact);
  if (c.lastArtifact === sig) return;
  c.lastArtifact = sig;
  c.viz.innerHTML = "";
  if (artifact.html) {
    const f = document.createElement("iframe");
    f.sandbox = "allow-scripts";
    f.srcdoc = artifact.html;
    c.viz.appendChild(f);
  } else if (artifact.content) {
    const pre = document.createElement("pre");
    pre.textContent = artifact.content;
    c.viz.appendChild(pre);
  }
}

function togglePause(id) {
  const m = state.processes.get(id);
  if (!m) return;
  api(`processes/${id}/${m.state === "paused" ? "resume" : "pause"}`);
}

function showQR(meta) {
  const url = `${location.origin}/m/${meta.qrToken}`;
  const src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(url)}`;
  const w = window.open("", "_blank", "width=260,height=320");
  w.document.write(
    `<title>pair</title><body style="font:14px system-ui;background:#0b0f17;color:#e7ecf3;text-align:center;padding:20px">
     <h3>${meta.title}</h3><img src="${src}" alt="qr"/><p style="word-break:break-all">${url}</p></body>`,
  );
}

// ── selection / steer panel ─────────────────────────────────────────────────
function selectProcess(id) {
  api("select", { id });
}
function reflectSelection() {
  for (const [id, c] of cardEls) c.root.classList.toggle("selected", id === state.selected);
  const panel = $("#selectedPanel");
  if (!state.selected || !state.processes.has(state.selected)) {
    panel.classList.add("hidden");
    return;
  }
  panel.classList.remove("hidden");
  renderSelected();
}
function renderSelected() {
  const m = state.processes.get(state.selected);
  if (!m) return;
  $("#selTitle").textContent = m.title;
  const log = $("#selLog");
  log.innerHTML = "";
  for (const o of state.outputs.get(m.upid) || []) {
    if (!o.text) continue;
    const d = document.createElement("div");
    d.className = "msg " + (o.kind === "chat" || o.kind === "artifact" ? "agent" : "agent");
    d.textContent = o.text;
    log.appendChild(d);
  }
  log.scrollTop = log.scrollHeight;
}
$("#selClose").onclick = () => selectProcess(null);
$("#promptForm").onsubmit = (e) => {
  e.preventDefault();
  const inp = $("#promptInput");
  const text = inp.value.trim();
  if (!text || !state.selected) return;
  // echo user message locally
  const arr = state.outputs.get(state.selected) || [];
  arr.push({ processId: state.selected, kind: "chat", text: "you: " + text });
  state.outputs.set(state.selected, arr);
  renderSelected();
  api(`processes/${state.selected}/prompt`, { text });
  inp.value = "";
};

// ── idea bubbles ──────────────────────────────────────────────────────────
function upsertBubble(s) {
  let root = bubbleEls.get(s.id);
  const isNew = !root;
  if (isNew) {
    root = document.createElement("div");
    root.className = "bubble";
    bubbleEls.set(s.id, root);
    $("#bubbleList").prepend(root); // most recent on top, expanded
    // collapse all others
    for (const [id, el] of bubbleEls) if (id !== s.id) el.classList.add("collapsed");
  }
  const ans = state.answers.get(s.id) || {};
  root.innerHTML = `
    <div class="bhead">
      <span class="t"></span>
      ${s.modelInitiated ? '<span class="tag">model</span>' : ""}
    </div>
    <div class="body">
      <div class="rationale"></div>
      <div class="demo"></div>
      <div class="qs"></div>
      <div class="actions">
        <button class="primary" data-a="accept">Accept → spawn</button>
        <button data-a="dismiss">Dismiss</button>
      </div>
    </div>`;
  root.querySelector(".t").textContent = s.title;
  root.querySelector(".rationale").textContent = s.rationale;
  root.querySelector(".bhead").onclick = () => root.classList.toggle("collapsed");

  const demo = root.querySelector(".demo");
  if (s.demo?.html) {
    const f = document.createElement("iframe");
    f.sandbox = "allow-scripts";
    f.srcdoc = s.demo.html;
    demo.appendChild(f);
  } else if (s.demo?.content) {
    demo.innerHTML = `<pre style="margin:0;padding:8px;font:11px ui-monospace;color:#cfe;overflow:auto;height:100%">${escapeHtml(
      s.demo.content,
    )}</pre>`;
  }

  const qs = root.querySelector(".qs");
  for (const q of s.questions || []) {
    const block = document.createElement("div");
    block.className = "q";
    const p = document.createElement("div");
    p.className = "qp";
    p.textContent = q.prompt;
    const choices = document.createElement("div");
    choices.className = "choices";
    for (const choice of q.choices) {
      const b = document.createElement("button");
      b.textContent = choice;
      if (ans[q.id] === choice) b.classList.add("sel");
      b.onclick = () => {
        const a = state.answers.get(s.id) || {};
        a[q.id] = choice;
        state.answers.set(s.id, a);
        upsertBubble(s);
      };
      choices.appendChild(b);
    }
    block.append(p, choices);
    qs.appendChild(block);
  }

  root.querySelector('[data-a="accept"]').onclick = async () => {
    const a = state.answers.get(s.id) || {};
    const answers = {};
    for (const q of s.questions || []) if (a[q.id]) answers[q.prompt] = a[q.id];
    await api(`suggestions/${s.id}/accept`, { answers });
  };
  root.querySelector('[data-a="dismiss"]').onclick = () => api(`suggestions/${s.id}/dismiss`);
}
function removeBubble(id) {
  bubbleEls.get(id)?.remove();
  bubbleEls.delete(id);
}
function escapeHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}

// ── room transcript (ambient) ───────────────────────────────────────────────
$("#transcriptForm").onsubmit = (e) => {
  e.preventDefault();
  const inp = $("#transcriptInput");
  const text = inp.value.trim();
  if (!text) return;
  api("transcript", { text, source: "pro" });
  inp.value = "";
};

// Web Speech API mic → ambient transcript stream
let recog = null;
$("#micBtn").onclick = () => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return alert("Web Speech API not available in this browser.");
  if (recog) {
    recog.stop();
    return;
  }
  recog = new SR();
  recog.continuous = true;
  recog.interimResults = false;
  recog.onresult = (ev) => {
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      if (ev.results[i].isFinal) api("transcript", { text: ev.results[i][0].transcript, source: "mic" });
    }
  };
  recog.onend = () => {
    $("#micBtn").classList.remove("rec");
    recog = null;
  };
  recog.start();
  $("#micBtn").classList.add("rec");
};

// ── config knobs ────────────────────────────────────────────────────────────
function applyConfig(cfg) {
  $("#bpm").value = cfg.bubblesPerMinute;
  $("#bpmV").textContent = cfg.bubblesPerMinute;
  $("#ttl").value = Math.round(cfg.suggestionTtlMs / 1000);
  $("#ttlV").textContent = Math.round(cfg.suggestionTtlMs / 1000);
}
$("#bpm").oninput = (e) => {
  $("#bpmV").textContent = e.target.value;
  api("config", { bubblesPerMinute: Number(e.target.value) });
};
$("#ttl").oninput = (e) => {
  $("#ttlV").textContent = e.target.value;
  api("config", { suggestionTtlMs: Number(e.target.value) * 1000 });
};

// ── boot ──────────────────────────────────────────────────────────────────
fetch("/api/config")
  .then((r) => r.json())
  .then(applyConfig)
  .catch(() => {});
connect();
