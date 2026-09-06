#!/usr/bin/env python3
"""Fetch the pinned CC0 park material maps, or verify local copies with --check."""
import argparse
import hashlib
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[1] / "public/assets/park"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Verify without network access")
    args = parser.parse_args()
    for group in ["bark", "ground"]:
        directory = ROOT / group
        manifest = json.loads((directory / "sources.json").read_text())
        for maps in manifest.values():
            for source in maps.values():
                path = directory / source["file"]
                valid = path.exists() and hashlib.md5(path.read_bytes()).hexdigest() == source["md5"]
                if not valid:
                    if args.check:
                        raise ValueError(f"Missing or changed material map: {path.name}")
                    request = urllib.request.Request(source["url"], headers={"User-Agent": "vibersyn-assets/1.0"})
                    with urllib.request.urlopen(request, timeout=60) as response:
                        payload = response.read()
                    if hashlib.md5(payload).hexdigest() != source["md5"]:
                        raise ValueError(f"Source hash mismatch: {path.name}")
                    path.write_bytes(payload)
                print(f"Verified {path.name}")


if __name__ == "__main__":
    main()
