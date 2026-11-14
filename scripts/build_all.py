"""Re-create everything in public/data from the SVS source files.

    .venv/Scripts/python scripts/build_all.py            # all datasets
    .venv/Scripts/python scripts/build_all.py sst        # one dataset
    .venv/Scripts/python scripts/build_all.py --lite     # low-bandwidth SST source

Raw downloads are cached in data-raw/ (gitignored); rerunning skips existing files.
Hand-authored public/data/<id>/rules.json files are never touched.
"""

from __future__ import annotations

import argparse
import importlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib.fetch import PUBLIC_DATA, log  # noqa: E402

DATASETS = ["sst", "nightlights", "lightning", "aerosols", "earth"]
BUDGET_MB = 30.0


def public_size_mb() -> float:
    root = PUBLIC_DATA.parent
    return sum(p.stat().st_size for p in root.rglob("*") if p.is_file()) / 1e6


def write_index() -> None:
    entries = []
    for ds in DATASETS:
        meta = PUBLIC_DATA / ds / "meta.json"
        if meta.exists():
            m = json.loads(meta.read_text(encoding="utf-8"))
            entries.append({k: m[k] for k in ("id", "title", "kind", "kindLabel", "svsId", "period")})
    (PUBLIC_DATA / "index.json").write_text(json.dumps({"datasets": entries}, indent=1, ensure_ascii=False), encoding="utf-8")
    log("index.json:", [e["id"] for e in entries])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("only", nargs="*", help=f"datasets to build (default: all of {DATASETS})")
    ap.add_argument("--lite", action="store_true", help="SST from the 12 MB SVS m4v instead of TIF frames")
    args = ap.parse_args()
    unknown = set(args.only) - set(DATASETS)
    if unknown:
        ap.error(f"unknown dataset(s): {sorted(unknown)}")
    PUBLIC_DATA.mkdir(parents=True, exist_ok=True)
    if not args.only:
        log("=== night sky ===")
        importlib.import_module("sky").run()
        log("=== instrument samples ===")
        importlib.import_module("samples").run()
    for ds in args.only or DATASETS:
        mod = importlib.import_module(f"datasets.{ds}")
        log(f"=== {ds} ===")
        mod.run(lite=args.lite) if ds == "sst" else mod.run()
    if not args.only or "earth" in args.only:
        log("=== real clouds (MODIS) ===")
        importlib.import_module("clouds").run()
    write_index()
    size = public_size_mb()
    log(f"public/ total: {size:.1f} MB (budget {BUDGET_MB} MB)")
    if size > BUDGET_MB:
        log("ERROR: over budget")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
