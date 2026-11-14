"""Instrument samples for the data layers (piano, strings, harp, flute, contrabass).

    .venv/Scripts/python scripts/samples.py

File names come from the repositories' GitHub API listings (nothing is guessed). We keep
notes roughly every few semitones inside each instrument's useful range (Tone.Sampler
pitch-shifts in between), trim them to 4 s, convert to mono 96 kbps MP3 and write
public/samples/manifest.json: {instrument: {"C4": "/samples/piano/C4.mp3", ...}}.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.fetch import RAW, ROOT, UA, download, ffmpeg, log  # noqa: E402
from sources import SAMPLE_SOURCES  # noqa: E402

OUT = ROOT / "public" / "samples"
PC = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
NAME = re.compile(r"^([A-G])(s|#|b)?(-?\d)\.mp3$")


def midi_of(name: str) -> int | None:
    m = NAME.match(name)
    if not m:
        return None
    pc = PC[m.group(1)] + (1 if m.group(2) in ("s", "#") else -1 if m.group(2) == "b" else 0)
    return 12 * (int(m.group(3)) + 1) + pc


def tone_name(name: str) -> str:
    """'Cs4.mp3' -> 'C#4' (Tone.Sampler note names)."""
    return name[:-4].replace("s", "#")


def run() -> dict:
    manifest: dict[str, dict[str, str]] = {}
    for inst, (api, base, (lo, hi), spacing) in SAMPLE_SOURCES.items():
        listing = requests.get(api, headers=UA, timeout=60).json()
        files = sorted(
            ((midi_of(f["name"]), f["name"]) for f in listing if midi_of(f["name"]) is not None),
            key=lambda x: x[0],
        )
        chosen, last = [], -99
        for m, name in files:
            if lo <= m <= hi and m - last >= spacing:
                chosen.append(name)
                last = m
        (OUT / inst).mkdir(parents=True, exist_ok=True)
        manifest[inst] = {}
        for name in chosen:
            raw = download(base + name, RAW / "samples" / inst / name)
            out = OUT / inst / name
            if not out.exists():
                ffmpeg("-i", str(raw), "-ac", "1", "-t", "4", "-af", "afade=t=out:st=3.3:d=0.7",
                       "-codec:a", "libmp3lame", "-b:a", "96k", str(out))
            manifest[inst][tone_name(name)] = f"/samples/{inst}/{name}"
        log(inst, len(chosen), "notes:", " ".join(manifest[inst]))
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    return manifest


if __name__ == "__main__":
    run()
