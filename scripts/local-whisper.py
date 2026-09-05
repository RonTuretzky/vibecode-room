"""Persistent local Whisper worker. stdin: PCM16/16kHz base64 lines; stdout: JSON.
Model installation is explicit; serving microphone audio never downloads a model.
"""
import base64
import json
import os
import sys
from pathlib import Path

import numpy as np
import torch
import whisper

torch.set_num_threads(4)
name = os.environ.get("VIBERSYN_LOCAL_WHISPER_MODEL", "base.en")
cache = Path(os.environ.get("VIBERSYN_LOCAL_WHISPER_CACHE", str(Path.home() / ".cache" / "whisper")))
path = Path(name) if Path(name).is_file() else cache / f"{name}.pt"
if not path.is_file():
    raise RuntimeError(f"Local Whisper model missing: {path}. Run bun run local:setup first.")
model = whisper.load_model(str(path), device="cpu")
for line in sys.stdin:
    try:
        data = json.loads(line)
        audio = np.frombuffer(base64.b64decode(data["pcm"]), dtype="<i2").astype(np.float32) / 32768.0
        result = model.transcribe(audio, language=os.environ.get("VIBERSYN_LOCAL_WHISPER_LANGUAGE", "en"), fp16=False, temperature=0, condition_on_previous_text=False)
        print(json.dumps({"text": result["text"].strip()}), flush=True)
    except Exception as error:
        print(json.dumps({"error": str(error)}), flush=True)
