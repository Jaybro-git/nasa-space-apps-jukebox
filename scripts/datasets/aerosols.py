"""SVS 5669 — GEOS Aerosols (GEOS-FP, 2025-08-19 20:00 UTC), Earth Information Center still.

Case: CATEGORICAL COLOURS ARE THE DATA. The map has no numeric colorbar; its legend
(Aerosols_cbar.png) names four aerosol types by colour, and brightness shows how much:
  black carbon (smoke)  red / orange
  dust                  lilac / purple
  sea salt              pale blue-grey (cyan-ish, low saturation)
  sulfate               green
Every pixel is classified by hue (HSV) after removing the base map (grey land, dark ocean,
white city lights), and its strength is how far its brightness rises above that base.
Checked visually against the frame: the Saharan dust plume, African smoke, southern-ocean
sea salt and Asian / North Pacific sulfate land in the right classes.

The image is a plate carree world map stretched to 16:9 (180 W .. 180 E, 90 N .. 90 S), so
x -> longitude and y -> latitude are linear.

Outputs in public/data/aerosols/: aerosols.jpg (texture), grid.json (2-degree total
aerosol strength 0..1, clear air = no data), types.json (dominant type per 1-degree cell,
CountriesFile format), meta.json, rules.json.
"""

from __future__ import annotations

import json

import cv2
import numpy as np
from PIL import Image

from lib.fetch import PUBLIC_DATA, RAW, download, log
from sources import AEROSOLS

ID = "aerosols"
TYPES = ["Black carbon (smoke)", "Dust", "Sea salt", "Sulfate"]
GW, GH = 180, 90  # explore grid: 2 degrees
TW, TH = 360, 180  # type raster: 1 degree
CLEAR = 0.08  # mean strength below this = clear air (silent)


def classify(bgr: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Per pixel: type index (0 = none, 1..4 = TYPES) and strength 0..1."""
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV).astype(np.float32)
    h, s, v = hsv[..., 0] * 2, hsv[..., 1] / 255, hsv[..., 2] / 255  # hue in degrees
    t = np.zeros(h.shape, np.uint8)
    smoke = ((h < 35) | (h > 340)) & (s > 0.35) & (v > 0.35)
    dust = (h > 255) & (h < 330) & (s > 0.15) & (v > 0.35)
    sulfate = (h > 75) & (h < 160) & (s > 0.35) & (v > 0.25)
    salt = (h > 160) & (h < 240) & (s > 0.08) & (s < 0.55) & (v > 0.35)
    t[salt] = 3
    t[sulfate] = 4
    t[dust] = 2
    t[smoke] = 1
    # strength: brightness above the dark base map, reaching 1 at full brightness
    strength = np.clip((v - 0.2) / 0.75, 0, 1) * (t > 0)
    return t, strength


def run() -> None:
    out = PUBLIC_DATA / ID
    out.mkdir(parents=True, exist_ok=True)
    src = download(AEROSOLS["image"], RAW / ID / "Aerosols_2025-08-19T20_00_00_3840x2160.png")
    img = Image.open(src).convert("RGB")
    img.save(out / "aerosols.jpg", quality=84, optimize=True, progressive=True)
    img.resize((1024, 576), Image.LANCZOS).save(out / "poster.jpg", quality=80)

    bgr = cv2.cvtColor(np.asarray(img.resize((1920, 1080), Image.LANCZOS)), cv2.COLOR_RGB2BGR)
    types, strength = classify(bgr)

    # explore grid: mean strength per 2-degree cell
    g = cv2.resize(strength, (GW, GH), interpolation=cv2.INTER_AREA)
    q = np.round(g * 254).astype(np.int32)
    q[g < CLEAR] = 255
    (out / "grid.json").write_text(json.dumps({"frames": [q.ravel().tolist()]}, separators=(",", ":")), encoding="utf-8")

    # dominant type per 1-degree cell, weighted by strength
    per = np.stack([cv2.resize(strength * (types == k), (TW, TH), interpolation=cv2.INTER_AREA) for k in range(1, 5)])
    dom = (np.argmax(per, axis=0) + 1).astype(np.uint16)
    dom[per.max(axis=0) < CLEAR / 2] = 0
    flat = dom.ravel()
    change = np.flatnonzero(np.diff(flat)) + 1
    starts = np.concatenate([[0], change])
    ends = np.concatenate([change, [flat.size]])
    rle = [int(x) for s_, e in zip(starts, ends) for x in (flat[s_], e - s_)]
    (out / "types.json").write_text(json.dumps({"w": TW, "h": TH, "names": TYPES, "labels": [], "rle": rle}, separators=(",", ":")), encoding="utf-8")

    shares = {TYPES[k - 1]: round(float((types == k).mean()), 4) for k in range(1, 5)}
    meta = {
        "id": ID,
        "title": "Aerosols: Smoke, Dust, Sea Salt, Sulfate",
        "svsId": 5669,
        "svsUrl": AEROSOLS["page"],
        "kind": "color",
        "kindLabel": "Four aerosol types by colour; brightness = how much",
        "sourceLabel": "GEOS-FP model",
        "description": "Smoke, dust, sea salt and sulfate drifting around the whole planet on 19 August 2025, from NASA's GEOS model. Each type has its own colour: red smoke from African and North American fires, a lilac river of Saharan dust over the Atlantic, pale sea salt whipped up by southern storms, and green sulfate from industry and volcanoes. Explore it by ear: higher means more aerosol, and the type is spoken when it changes.",
        "units": "",
        "range": [0, 1],
        "period": "19 August 2025, 20:00 UTC",
        "projection": "equirectangular",
        "aspect": 16 / 9,
        "video": {"src": "", "width": 1920, "height": 1080, "duration": 0, "fps": 0, "poster": f"/data/{ID}/poster.jpg"},
        "caveats": [
            "There is no numeric colorbar: strength is relative brightness (0 to 100), not a concentration.",
            "Types are read from colour; where plumes overlap, the brighter colour wins.",
            "City lights on land can read as faint aerosol; very faint values count as clear air.",
        ],
        "grid": {"w": GW, "h": GH, "min": 0, "max": 100, "noData": 255, "label": "aerosol strength, 0-100"},
        "still": {"image": f"/data/{ID}/aerosols.jpg", "regions": f"/data/{ID}/types.json", "regionWord": "aerosol type"},
        "shares": shares,
    }
    (out / "meta.json").write_text(json.dumps(meta, indent=1, ensure_ascii=False), encoding="utf-8")
    rules = out / "rules.json"
    if not rules.exists():
        rules.write_text(json.dumps({
            "readouts": [],
            "legendBar": {"colors": ["#d2604a", "#c39cdb", "#86aaa8", "#53dc35"], "min": "smoke · dust", "max": "sea salt · sulfate"},
            "legend": [
                {"text": "Higher note means more aerosol under the probe. Silence means clear air.", "demo": {"target": "pitch", "from": 0, "to": 1}},
                {"text": "A soft tick means the aerosol type changed, and the new type is spoken.", "demo": {"target": "ticks", "from": 0, "to": 1}},
                {"text": "The Box tool scans an area west to east: north is higher, louder means more.", "demo": {"target": "events", "from": 0, "to": 1}},
            ],
            "mappings": [],
            "narration": [],
            "explore": {"valueLabel": "of 100", "decimals": 0, "noData": "clear air"},
        }, indent=2), encoding="utf-8")
    log(ID, "type shares:", shares)


def debug_masks(path: str, out_png: str) -> None:
    """Paint each class in a flat colour, for checking the classification by eye."""
    bgr = cv2.imread(path)
    t, s = classify(bgr)
    pal = np.array([[0, 0, 0], [40, 60, 230], [220, 120, 200], [200, 200, 120], [40, 220, 60]], np.uint8)
    cv2.imwrite(out_png, (pal[t] * (0.3 + 0.7 * s[..., None])).astype(np.uint8))
