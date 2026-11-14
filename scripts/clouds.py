"""Real clouds for the Earth globe: one day of NASA MODIS true-colour imagery (Terra + Aqua,
from NASA GIBS), with the clouds pulled out as a transparency map.

A pixel is cloud when it is bright and grey-white (low saturation). Ice sheets and snow are
also white, so anything already white in the cloud-free Blue Marble is removed, and clouds
fade out towards the poles where sea ice and low sun make the split unreliable. Swath gaps
and polar night (black in the imagery) simply have no clouds.

Output: public/clouds/clouds.jpg, a 2048 x 1024 greyscale map (white = dense cloud), used as
an alpha map on a slowly drifting sphere just above the globe.

    .venv/Scripts/python scripts/clouds.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib.fetch import PUBLIC_DATA, RAW, ROOT, download, log  # noqa: E402
from sources import CLOUDS  # noqa: E402

OUT = ROOT / "public" / "clouds"
W, H = 2048, 1024


def cloud_alpha(rgb: np.ndarray) -> np.ndarray:
    """0..1 cloud density from a true-colour image (bright, low-saturation pixels)."""
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV).astype(np.float32)
    s, v = hsv[..., 1] / 255, hsv[..., 2] / 255
    bright = np.clip((v - 0.5) / 0.45, 0, 1)
    grey = 1 - np.clip((s - 0.08) / 0.18, 0, 1)
    return (bright * grey) ** 1.3


def run() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    alphas = []
    for name, url in CLOUDS["layers"].items():
        p = download(url, RAW / "clouds" / f"{name}_{CLOUDS['date']}.jpg")
        alphas.append(cloud_alpha(np.asarray(Image.open(p).convert("RGB").resize((W, H), Image.LANCZOS))))
    a = np.maximum.reduce(alphas)
    # remove ice and snow: white in the cloud-free Blue Marble
    base = PUBLIC_DATA / "earth" / "earth.jpg"
    if base.exists():
        ice = cloud_alpha(np.asarray(Image.open(base).convert("RGB").resize((W, H), Image.LANCZOS)))
        a = np.clip(a - 1.2 * ice, 0, 1)
    # polar sea ice and low sun make the poles unreliable: fade clouds out beyond 65-75 degrees
    lat = 90 - (np.arange(H) + 0.5) / H * 180
    a *= np.clip((75 - np.abs(lat)) / 10, 0, 1)[:, None]
    a = cv2.GaussianBlur(a, (0, 0), 1.5)
    Image.fromarray(np.round(a * 255).astype(np.uint8), "L").save(OUT / "clouds.jpg", quality=85, optimize=True)
    log("clouds:", round((OUT / "clouds.jpg").stat().st_size / 1e6, 2), "MB, cover", round(float((a > 0.3).mean()), 3))


if __name__ == "__main__":
    run()
