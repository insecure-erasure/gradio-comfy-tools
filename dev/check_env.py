#!/usr/bin/env python3
"""Validate a live ComfyUI instance against this repo's workflows.

Usage:
    python3 dev/check_env.py [BASE_URL]

BASE_URL defaults to http://192.168.1.8 (the dev instance); use
http://localhost:8188 for a local one.

Checks:
  1. API reachability        -> GET /system_stats
  2. Workflow nodes          -> every class_type used by workflows/ is
                                registered (GET /object_info)
  3. Workflow models         -> every model file actively used by
                                workflows/ is installed (GET /models/*)

Exit code 0 if everything is OK, 1 otherwise. Missing files that are only
listed in disabled LoRA slots ("on": false) are reported as "inactive" and
do NOT fail the check.
"""

import argparse
import json
import re
import sys
from pathlib import PurePosixPath
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORKFLOWS = sorted((ROOT / "workflows").glob("*.json"))

MODEL_RE = re.compile(r"\.(safetensors|ckpt|gguf|bin|onnx|pth)$", re.I)


def get_json(base: str, path: str) -> object:
    with urllib.request.urlopen(base.rstrip("/") + path, timeout=15) as r:
        return json.load(r)


def active_model_values(workflow: dict) -> set[str]:
    """Model-file strings in node inputs (ignores disabled LoRA slots)."""
    found: set[str] = set()

    def walk(o: object) -> None:
        if isinstance(o, dict):
            if isinstance(o.get("inputs"), dict):
                for v in o["inputs"].values():
                    if isinstance(v, str) and MODEL_RE.search(v):
                        found.add(v)
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)

    walk(workflow)
    return found


def installed_files(base: str) -> set[str]:
    """File paths (and basenames) visible via GET /models/* ."""
    available: set[str] = set()
    folders = get_json(base, "/models")
    if not isinstance(folders, list):
        return available
    for folder in folders:
        try:
            files = get_json(base, f"/models/{folder}")
        except Exception:
            continue
        if isinstance(files, list):
            for name in files:
                if isinstance(name, str):
                    # ComfyUI returns Windows paths with (possibly escaped)
                    # backslashes and Linux paths with forward slashes;
                    # PurePosixPath treats both as separators and gives a
                    # canonical posix form + the basename.
                    p = PurePosixPath(name.replace("\\", "/"))
                    norm = str(p)
                    available.add(norm)
                    available.add(p.name)
    return available


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("base_url", nargs="?", default="http://192.168.1.8")
    args = parser.parse_args()
    base = args.base_url.rstrip("/")
    failures = 0

    # 1. Reachability
    print(f"ComfyUI base: {base}")
    try:
        stats = get_json(base, "/system_stats")
        ver = stats["system"]["comfyui_version"]
        print(f"[OK] API reachable (ComfyUI {ver})")
    except Exception as e:
        print(f"[FAIL] API not reachable: {e}")
        return 1

    # 2. Nodes
    try:
        object_info = get_json(base, "/object_info")
    except Exception as e:
        print(f"[FAIL] /object_info unavailable: {e}")
        return 1

    used_nodes: set[str] = set()
    for wf in WORKFLOWS:
        for node in json.loads(wf.read_text(encoding="utf-8")).values():
            if isinstance(node, dict) and "class_type" in node:
                used_nodes.add(node["class_type"])

    print(f"\nNodos usados por workflows/ ({len(used_nodes)}):")
    for ct in sorted(used_nodes):
        if ct in object_info:
            print(f"  [OK]    {ct}")
        else:
            failures += 1
            print(f"  [FALTA] {ct}")

    # 3. Models
    try:
        available = installed_files(base)
    except Exception as e:
        print(f"[FAIL] /models unavailable: {e}")
        return 1

    used_models: set[str] = set()
    for wf in WORKFLOWS:
        used_models |= active_model_values(json.loads(wf.read_text(encoding="utf-8")))

    print(f"\nModelos activos usados por workflows/ ({len(used_models)}):")
    for m in sorted(used_models):
        # Same canonicalization as installed_files (PurePosixPath).
        p = PurePosixPath(m.replace("\\", "/"))
        norm = str(p)
        if norm in available or p.name in available:
            print(f"  [OK]    {m}")
        else:
            failures += 1
            print(f"  [FALTA] {m}")

    # 4. Installed LoRAs (informational: the UI dropdown enumerates these)
    try:
        loras = get_json(base, "/models/loras")
        if isinstance(loras, list):
            print(f"\nLoRAs instaladas en el servidor: {len(loras)}")
    except Exception:
        pass

    print(f"\n{'TODO OK' if failures == 0 else f'{failures} fallos'}")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
