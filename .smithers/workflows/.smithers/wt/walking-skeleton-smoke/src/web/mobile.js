// Mobile paired device (§5.7). The URL is /m/:qrToken. We resolve the token to a
// process and feed its input queue — this device is "selected onto" that process,
// so its mic + chat are scoped steering (not the ambient suggestion channel).

const token = location.pathname.split("/").filter(Boolean)[1];
const $ = (s) => document.querySelector(s);
let proc = null;

function log(msg) {
  const d = document.createElement("div");
  d.textContent = msg;
  $("#log").prepend(d);
}

async function resolve() {
  const r = await fetch(`/api/processes/by-token/${token}`);
  if (!r.ok) {
    $("#ptitle").textContent = "process not found / ended";
    return;
  }
  proc = await r.json();
  $("#ptitle").textContent = proc.title;
}

async function steer(text) {
  if (!proc) return;
  log("→ " + text);
  await fetch(`/api/processes/${proc.upid}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

$("#f").onsubmit = (e) => {
  e.preventDefault();
  const t = $("#i").value.trim();
  if (!t) return;
  steer(t);
  $("#i").value = "";
};

let recog = null;
$("#mic").onclick = () => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    $("#micLabel").textContent = "voice not supported — use chat";
    return;
  }
  if (recog) {
    recog.stop();
    return;
  }
  recog = new SR();
  recog.continuous = true;
  recog.interimResults = false;
  recog.onresult = (ev) => {
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      if (ev.results[i].isFinal) steer(ev.results[i][0].transcript);
    }
  };
  recog.onend = () => {
    $("#mic").classList.remove("rec");
    $("#micLabel").textContent = "tap to talk";
    recog = null;
  };
  recog.start();
  $("#mic").classList.add("rec");
  $("#micLabel").textContent = "listening… tap to stop";
};

resolve();
