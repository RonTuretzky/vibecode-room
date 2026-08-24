#!/usr/bin/env python3
"""Fetch + repack the CC-BY landmark models for the Pond scene.

The room's ?env=park scene is ONE iconic place — Gapstow Bridge over the
Pond at the park's south-east corner — and its skyline is real models, not
extruded boxes: the Plaza Hotel and the Billionaires' Row towers that stand
behind the Pond in every postcard.

All models are Creative Commons Attribution from Sketchfab, fetched from the
Objaverse mirror (Allen Institute for AI, huggingface.co/datasets/allenai/
objaverse), which hosts CC-licensed Sketchfab uploads for direct download —
Sketchfab's own download API needs an account token. Attribution lives in
public/assets/park/ASSETS.md; keep it in sync with MODELS below.

Repack: `bunx @gltf-transform/cli optimize` with quantization and WebP
textures, NO meshopt/draco (plain GLTFLoader stays sufficient) and NO
simplification (architectural edges shred). Placement/scale/orientation is
code-side in src/park3d/park-models.ts — this script only ships bytes.

    python3 scripts/fetch-park-models.py
"""
import os
import subprocess
import sys
import urllib.request

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "assets", "park", "models")
MIRROR = "https://huggingface.co/datasets/allenai/objaverse/resolve/main/"

# name -> (objaverse path, sketchfab uid, title, author) — all CC-BY 4.0.
MODELS = {
    "plaza_hotel": (
        "glbs/000-002/fd4b083aca0245379418564c9105b4a7.glb",
        "fd4b083aca0245379418564c9105b4a7",
        "Plaza Hotel",
        "mshukla",
    ),
    "central_park_tower": (
        "glbs/000-150/53c2458a58104c708390149fc942b03a.glb",
        "53c2458a58104c708390149fc942b03a",
        "Central Park Tower",
        "NanoRay",
    ),
    "one57": (
        "glbs/000-019/60327eb81d1147f6bc4d248c51813085.glb",
        "60327eb81d1147f6bc4d248c51813085",
        "One57",
        "NanoRay",
    ),
    "steinway_tower": (
        "glbs/000-019/94deba673b494217b76de75fd0d149fc.glb",
        "94deba673b494217b76de75fd0d149fc",
        "111 West 57th Street - Steinway Tower",
        "NanoRay",
    ),
    "432_park": (
        "glbs/000-050/d1071ed9bd9549a5a03c83b72fbaffd1.glb",
        "d1071ed9bd9549a5a03c83b72fbaffd1",
        "432 Park Avenue",
        "NanoRay",
    ),
    "220_cps": (
        "glbs/000-156/84c23b63fdbe42c393fa4a96a68f4ada.glb",
        "84c23b63fdbe42c393fa4a96a68f4ada",
        "220 Central Park South",
        "NanoRay",
    ),
}

OPENER = urllib.request.build_opener()
OPENER.addheaders = [("User-Agent", "vibersyn-park-fetch/1.0")]
urllib.request.install_opener(OPENER)


def main():
    os.makedirs(ROOT, exist_ok=True)
    cache = os.path.join(ROOT, ".raw")
    os.makedirs(cache, exist_ok=True)
    for name, (path, uid, title, author) in MODELS.items():
        out = os.path.join(ROOT, f"{name}.glb")
        if os.path.exists(out):
            print(f"[model] {name}: exists, skip")
            continue
        raw = os.path.join(cache, f"{name}.glb")
        if not os.path.exists(raw):
            print(f"[model] {name}: fetch {path}")
            urllib.request.urlretrieve(MIRROR + path, raw)
        print(f"[model] {name}: optimize ({title} by {author}, CC-BY)")
        subprocess.run(
            [
                "bunx",
                "--yes",
                "@gltf-transform/cli",
                "optimize",
                raw,
                out,
                "--compress",
                "false",
                "--simplify",
                "false",
                "--texture-compress",
                "webp",
                "--texture-size",
                "1024",
            ],
            check=True,
        )
        print(f"  {os.path.getsize(raw) // 1024} KB -> {os.path.getsize(out) // 1024} KB")
    total = sum(os.path.getsize(os.path.join(ROOT, n)) for n in os.listdir(ROOT) if n.endswith(".glb"))
    print(f"[done] {total // 1024} KB in {os.path.relpath(ROOT)}")


if __name__ == "__main__":
    sys.exit(main())
