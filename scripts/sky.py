"""Night-mode background: NASA SVS Deep Star Maps 2020 (svs.gsfc.nasa.gov/4851, public domain),
galactic-coordinate version, so the Milky Way runs along the middle of the panorama.

    .venv/Scripts/python scripts/sky.py
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib.fetch import RAW, ROOT, download, log  # noqa: E402
from sources import SKY  # noqa: E402

OUT = ROOT / "public" / "sky"


def run() -> None:
    src = download(SKY["starmap"], RAW / "sky" / "starmap_2020_4k_gal_print.jpg")
    OUT.mkdir(parents=True, exist_ok=True)
    img = Image.open(src).convert("RGB")
    img = img.resize((4096, 2048), Image.LANCZOS) if img.size != (4096, 2048) else img
    img.save(OUT / "milkyway.jpg", quality=82, optimize=True, progressive=True)
    img.resize((2048, 1024), Image.LANCZOS).save(OUT / "milkyway-2k.jpg", quality=80, optimize=True, progressive=True)
    log("sky:", [(p.name, round(p.stat().st_size / 1e6, 2)) for p in OUT.glob("*.jpg")])


if __name__ == "__main__":
    run()
