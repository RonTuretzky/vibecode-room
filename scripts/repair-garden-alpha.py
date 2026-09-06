#!/usr/bin/env python3
"""Restore Poly Haven opacity in packed foliage GLBs without changing meshes.

Requires Pillow. Run after fetch-garden-assets.py, or use --check to validate
the committed assets without network access. Source masks retain their CC0
license; their URLs and hashes are recorded with each repaired image.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path
import struct
import urllib.request

from PIL import Image

MODELS = Path(__file__).resolve().parents[1] / "public/assets/garden/models"


def read_glb(path):
    raw = path.read_bytes()
    magic, version, length = struct.unpack_from("<III", raw)
    assert (magic, version, length) == (0x46546C67, 2, len(raw)), path
    count, kind = struct.unpack_from("<II", raw, 12)
    assert kind == 0x4E4F534A
    doc = json.loads(raw[20:20 + count])
    offset = 20 + count
    size, kind = struct.unpack_from("<II", raw, offset)
    assert kind == 0x004E4942
    binary = raw[offset + 8:offset + 8 + size]
    assert len(doc["buffers"]) == 1
    return doc, binary


def image_bytes(doc, binary, image):
    view = doc["bufferViews"][image["bufferView"]]
    start = view.get("byteOffset", 0)
    return binary[start:start + view["byteLength"]]


def alpha_images(doc):
    indices = set()
    for material in doc.get("materials", []):
        if material.get("alphaMode", "OPAQUE") == "OPAQUE":
            continue
        texture = material.get("pbrMetallicRoughness", {}).get("baseColorTexture")
        if texture:
            indices.add(doc["textures"][texture["index"]]["source"])
    return [doc["images"][i] for i in sorted(indices)]


def fetch(url):
    request = urllib.request.Request(url, headers={"User-Agent": "vibersyn-garden-fetch/1.0"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def pack(doc, binary, replacements):
    packed = bytearray()
    for index, view in enumerate(doc["bufferViews"]):
        start = view.get("byteOffset", 0)
        payload = replacements.get(index, binary[start:start + view["byteLength"]])
        packed.extend(b"\0" * (-len(packed) % 4))
        view["byteOffset"], view["byteLength"] = len(packed), len(payload)
        packed.extend(payload)
    doc["buffers"][0]["byteLength"] = len(packed)
    packed.extend(b"\0" * (-len(packed) % 4))
    metadata = json.dumps(doc, separators=(",", ":")).encode()
    metadata += b" " * (-len(metadata) % 4)
    return (struct.pack("<III", 0x46546C67, 2, 28 + len(metadata) + len(packed))
            + struct.pack("<II", len(metadata), 0x4E4F534A) + metadata
            + struct.pack("<II", len(packed), 0x004E4942) + packed)


def repair(path, check):
    doc, binary = read_glb(path)
    replacements, sources = {}, None
    for image in alpha_images(doc):
        color = Image.open(io.BytesIO(image_bytes(doc, binary, image)))
        extrema = color.getchannel("A").getextrema() if "A" in color.getbands() else (255, 255)
        if extrema[0] < 128 < extrema[1]:
            print(f"  valid {path.stem}: {image.get('name')}")
            continue
        if check:
            raise ValueError(f"{path.name}: {image.get('name')} has no foliage cutout alpha")
        if sources is None:
            sources = json.loads(fetch("https://api.polyhaven.com/files/" + path.stem))
        matches = [key for key in sources if "alpha" in key.lower() or "opacity" in key.lower()]
        if len(matches) != 1:
            raise ValueError(f"{path.stem}: expected one source mask, found {matches}")
        source = sources[matches[0]]["1k"]["png"]
        raw = fetch(source["url"])
        assert hashlib.md5(raw).hexdigest() == source["md5"], "Source mask hash mismatch"
        mask = Image.open(io.BytesIO(raw)).convert("L").resize(color.size, Image.Resampling.LANCZOS)
        assert mask.getextrema()[0] < 128 and mask.getextrema()[1] > 128
        color = color.convert("RGBA")
        color.putalpha(mask)
        encoded = io.BytesIO()
        color.save(encoded, format="PNG", optimize=True)
        replacements[image["bufferView"]] = encoded.getvalue()
        image["mimeType"] = "image/png"
        image.setdefault("extras", {})["opacitySource"] = {"url": source["url"], "md5": source["md5"]}
        print(f"  restore {path.stem}: {image.get('name')} ({len(encoded.getvalue()) // 1024} KiB)")
    if replacements:
        output = pack(doc, binary, replacements)
        temporary = path.with_suffix(".glb.tmp")
        temporary.write_bytes(output)
        # Never replace a valid asset with an incomplete binary.
        read_glb(temporary)
        temporary.replace(path)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Validate existing assets without fetching or writing")
    parser.add_argument("models", nargs="*", help="Optional model names; defaults to every garden GLB")
    args = parser.parse_args()
    paths = [MODELS / (name + ".glb") for name in args.models] if args.models else sorted(MODELS.glob("*.glb"))
    for path in paths:
        repair(path, args.check)
