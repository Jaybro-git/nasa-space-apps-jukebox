"""Download helpers. Every URL used by the pipeline lives in scripts/sources.py and was
copied from the SVS pages; frame filenames are read from the live directory listing."""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data-raw"
PUBLIC_DATA = ROOT / "public" / "data"
UA = {"User-Agent": "earth-jukebox-pipeline (NASA Space Apps)"}


def log(*a: object) -> None:
    print("[fetch]", *a, file=sys.stderr, flush=True)


def download(url: str, dest: Path) -> Path:
    """Download ``url`` to ``dest`` unless it already exists (idempotent)."""
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    log("GET", url)
    with requests.get(url, headers=UA, stream=True, timeout=60) as r:
        r.raise_for_status()
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)
    tmp.replace(dest)
    return dest


def list_directory(url: str, pattern: str) -> list[str]:
    """Filenames in an Apache-style directory listing matching ``pattern`` (regex)."""
    html = requests.get(url, headers=UA, timeout=60).text
    names = sorted(set(re.findall(r'href="(' + pattern + r')"', html)))
    if not names:
        raise RuntimeError(f"no files matching {pattern!r} at {url}")
    return names


def ffmpeg(*args: str) -> None:
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("ffmpeg not found on PATH")
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args]
    log(" ".join(cmd))
    subprocess.run(cmd, check=True)
