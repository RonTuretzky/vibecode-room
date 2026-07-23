#!/usr/bin/env python3
"""Fetch + pack the CC0 Poly Haven assets the pastoral garden scene renders.

Pipeline (all outputs are committed, so this only needs re-running to change
the asset set):
  1. Download each model's 1k glTF (+ bin/texture includes) into a temp cache.
  2. Repack to a single quantized .glb via gltf-transform (bunx). The
     jacaranda tree additionally gets meshopt-simplified: its LOD0 scan is a
     199MB bin, far too heavy for the two-projector room.
  3. Download the tiled ground texture (1k diff + normal) and the tonemapped
     sky panorama (8k, downscaled to 4k with sips).

Everything lands in public/assets/garden/. Licensing: all Poly Haven content
is CC0 — see public/assets/garden/ASSETS.md.
"""
import json
import os
import subprocess
import sys
import tempfile
import urllib.request

ROOT = os.path.join(os.path.dirname(__file__), "..", "public", "assets", "garden")
API = "https://api.polyhaven.com/files/"

# name -> (meshopt simplify ratio, error tolerance, join). These are heavily
# instanced background props viewed from projector distance, so each gets a
# hard triangle budget — the raw scans are 15k-85k tris each (the jacaranda
# LOD0 is millions) and instancing multiplies that into tens of millions per
# frame. Foliage keeps a TIGHT error bound: a loose one collapses grass
# blades and leaf cutouts into debris-looking slabs.
#
# join=False keeps a SET's separate clumps as separate meshes (the loader
# scatters each clump as a variant); the jacaranda is ONE tree whose
# thousands of leaf cards MUST be joined first or they can't simplify (an
# unjoined build came out 88MB).
# 4th field (jacaranda only): simplify-lock-border off — locked borders on
# thousands of alpha-cutout leaf cards make the canopy un-simplifiable.
MODELS = {
    "grass_medium_01": (0.18, 0.01, False),
    "flower_gazania": (0.2, 0.01, False),
    "flower_ursinia": (0.12, 0.01, False),
    "dandelion_01": (0.06, 0.01, False),
    "periwinkle_plant": (0.1, 0.01, False),
    "shrub_02": (0.2, 0.01, False),
    "shrub_03": (0.35, 0.01, False),
    "rock_moss_set_01": (0.048, 0.05, False),
    "tree_stump_01": (0.073, 0.05, False),
    "jacaranda_tree": (0.02, 0.008, True, False),
}
GROUND = "aerial_grass_rock"
# Sunnier than kloofendal_48d (which reads overcast on a projector): blue
# zenith, scattered fair-weather cumulus.
SKY = "sunflowers_puresky"

# Poly Haven 403s the default urllib agent.
OPENER = urllib.request.build_opener()
OPENER.addheaders = [("User-Agent", "vibersyn-garden-fetch/1.0")]
urllib.request.install_opener(OPENER)


def fetch_json(url):
    with urllib.request.urlopen(url) as r:
        return json.load(r)


def download(url, dest):
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    print(f"  get  {os.path.basename(dest)}")
    urllib.request.urlretrieve(url, dest)


def fetch_model(asset, ratio, cache):
    out = os.path.join(ROOT, "models", f"{asset}.glb")
    if os.path.exists(out):
        print(f"[model] {asset}: exists, skip")
        return
    print(f"[model] {asset}")
    entry = fetch_json(API + asset)["gltf"]["1k"]["gltf"]
    raw_dir = os.path.join(cache, asset)
    raw = os.path.join(raw_dir, os.path.basename(entry["url"]))
    download(entry["url"], raw)
    for rel, inc in entry.get("include", {}).items():
        download(inc["url"], os.path.join(raw_dir, rel))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    ratio, error, join, *rest = ratio
    lock_border = rest[0] if rest else True
    cmd = [
        "bunx", "@gltf-transform/cli", "optimize", raw, out,
        "--compress", "quantize", "--texture-compress", "false",
        "--join", "true" if join else "false",
        "--simplify", "true", "--simplify-ratio", str(ratio),
        "--simplify-error", str(error),
        "--simplify-lock-border", "true" if lock_border else "false",
    ]
    subprocess.run(cmd, check=True, capture_output=True)
    print(f"  made {asset}.glb ({os.path.getsize(out) // 1024}KB)")


def fetch_ground():
    print(f"[ground] {GROUND}")
    files = fetch_json(API + GROUND)
    for kind, name in (("Diffuse", "diff"), ("nor_gl", "nor")):
        dest = os.path.join(ROOT, "ground", f"{GROUND}_{name}_1k.jpg")
        if os.path.exists(dest):
            print(f"  skip {os.path.basename(dest)}")
            continue
        download(files[kind]["1k"]["jpg"]["url"], dest)


def fetch_sky(cache):
    print(f"[sky] {SKY}")
    final = os.path.join(ROOT, "sky", f"{SKY}_4k.jpg")
    if os.path.exists(final):
        print(f"  skip {os.path.basename(final)}")
        return
    entry = fetch_json(API + SKY)["tonemapped"]
    raw = os.path.join(cache, f"{SKY}_8k.jpg")
    download(entry["url"], raw)
    os.makedirs(os.path.dirname(final), exist_ok=True)
    code = os.system(f"sips -Z 4096 -s format jpeg -s formatOptions 80 '{raw}' --out '{final}' >/dev/null")
    if code != 0:
        sys.exit("sips downscale failed")
    print(f"  made {os.path.basename(final)} ({os.path.getsize(final) // 1024}KB)")


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="garden-assets-") as cache:
        for asset, ratio in MODELS.items():
            fetch_model(asset, ratio, cache)
        fetch_ground()
        fetch_sky(cache)
    total = 0
    for dirpath, _, names in os.walk(ROOT):
        total += sum(os.path.getsize(os.path.join(dirpath, n)) for n in names)
    print(f"total payload: {total // (1024 * 1024)}MB")
