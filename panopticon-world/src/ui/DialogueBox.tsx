import { type FormEvent, useEffect, useRef, useState } from "react";
import { engine, useWorld } from "../world/mockEngine.ts";

// The room conversation, as a JRPG dialogue box. This is the always-on ambient
// channel (C3) that feeds the suggestion engine — type or talk and watch the
// Idea Spring bubble.
export function DialogueBox() {
  const w = useWorld();
  const last = w.transcript[w.transcript.length - 1];
  const [typed, setTyped] = useState("");
  const [rec, setRec] = useState(false);
  const recogRef = useRef<any>(null);

  // typewriter for the latest line
  useEffect(() => {
    if (!last) return;
    setTyped("");
    let i = 0;
    const id = setInterval(() => {
      i++;
      setTyped(last.text.slice(0, i));
      if (i >= last.text.length) clearInterval(id);
    }, 22);
    return () => clearInterval(id);
  }, [last?.ts]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const inp = (e.currentTarget as HTMLFormElement).elements.namedItem("t") as HTMLInputElement;
    const v = inp.value.trim();
    if (!v) return;
    engine.pushTranscript(v, "pro");
    inp.value = "";
  };

  const toggleMic = () => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      alert("Web Speech API not available in this browser. Type in the box instead.");
      return;
    }
    if (recogRef.current) {
      recogRef.current.stop();
      return;
    }
    const r = new SR();
    r.continuous = true;
    r.interimResults = false;
    r.onresult = (ev: any) => {
      for (let i = ev.resultIndex; i < ev.results.length; i++)
        if (ev.results[i].isFinal) engine.pushTranscript(ev.results[i][0].transcript, "mic");
    };
    r.onend = () => {
      setRec(false);
      recogRef.current = null;
    };
    r.start();
    recogRef.current = r;
    setRec(true);
  };

  return (
    <div className="dialogue snes-panel">
      <div className="speaker">🗣 ROOM</div>
      <div className="lines">
        {typed}
        <span className="caret">▌</span>
        {!last && <span className="ghost">…say something buildable — “we should build a dashboard to track our agents”</span>}
      </div>
      <form onSubmit={submit}>
        <input name="t" placeholder="talk in the room (ambient → suggestions)…" autoComplete="off" />
        <button type="button" className={"snes-btn mic" + (rec ? " rec" : "")} onClick={toggleMic} title="voice">
          🎤
        </button>
        <button type="submit" className="snes-btn">
          Say
        </button>
      </form>
    </div>
  );
}
