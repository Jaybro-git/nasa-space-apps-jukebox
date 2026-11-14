"""SVS 5313 — Change in Night Lights 2012-2023, EIC version (Black Marble / VIIRS).

Case: COLOR AND BRIGHTNESS ARE THE DATA. There is no colorbar with units: light
brightness is relative, and in the change map purple = more light, orange = less light
(2012 vs 2023). The sound is driven by shares of bright / purple / orange area.

Geometry (checked on the frames, not assumed): the 7680x2160 EIC frame shows the world
map TWICE side by side (period ~3842 px) and is not 2:1 plate carree, so pixels are not
converted to lat/lon. Explore mode and narration use relative regions plus the four
labelled zoom insets (Western Europe, Eastern Mediterranean, Ukraine, India).

Timeline (read from the on-screen year labels at 0.5 s steps, see METHODS.md):
  0-~9.3 s annual maps 2012..2023 | ~9.5-20.5 s change map | ~21-37 s annual maps with
  zoom insets | ~37 s-end change map with zoom insets.
Phase boundaries are detected from the pixels and checked against that reading.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import cv2
import numpy as np

from lib import features as F
from lib.fetch import PUBLIC_DATA, RAW, download, ffmpeg, log
from sources import NIGHTLIGHTS

ID = "nightlights"
FILE = "nightlights_flat_series_and_change_wZooms_13_EIC_2160p30_h265.mp4"
SAMPLE_FPS = 2
SCALE = 0.5  # analyse at 3840x1080
VIDEO_W, VIDEO_H = 1280, 640
GRID_W, GRID_H = 72, 36
# Globe window: one map copy, starting at 180 W. Measured by correlating the grey land
# mask with the SST frame's land (a known -180..180 plate carree): best match at a
# 12 degree shift with zero vertical offset, i.e. latitude runs linearly 90N (top) to
# 90S (bottom) -- a plate carree stretched to 16:9 -- and x=0 of each copy is 168 W.
PERIOD = 3842
WIN_X0 = PERIOD - round(12 / 360 * PERIOD)  # 3714: 180 W in the second copy

# Year labels as shown on screen (video seconds -> year), read at 0.5 s resolution.
YEAR_LABELS = {
    "annual": [(0.0, 2012), (0.5, 2013), (1.0, 2014), (1.5, 2015), (2.5, 2016), (3.0, 2017), (3.5, 2018),
               (4.0, 2019), (4.5, 2020), (5.0, 2021), (6.0, 2022), (6.5, 2023)],
    "zoomAnnual": [(21.0, 2012), (27.5, 2013), (28.5, 2014), (29.0, 2015), (29.5, 2016), (30.0, 2017),
                   (30.5, 2018), (31.0, 2019), (32.0, 2020), (32.5, 2021), (33.0, 2022), (33.5, 2023)],
}

# Zoom inset boxes in full-resolution pixels (x, y, w, h), detected from the border lines
# of a frame at 34 s and matched to their on-screen titles.
INSETS = {
    "westernEurope": ("Western Europe", (679, 743, 1319, 1318)),
    "easternMediterranean": ("Eastern Mediterranean", (2367, 127, 861, 1148)),
    "ukraine": ("Ukraine", (4640, 102, 1091, 819)),
    "india": ("India", (6052, 1065, 1034, 1034)),
}
# Year label + change legend sit in the mid-Pacific between the two map copies.
OVERLAY_MASK = (3300, 850, 1100, 450)

PHASES = [
    {"id": "annual", "label": "Annual night lights, 2012 to 2023"},
    {"id": "change", "label": "Change map, 2012 versus 2023"},
    {"id": "zoomAnnual", "label": "Zoomed regions, 2012 to 2023"},
    {"id": "zoomChange", "label": "Zoomed regions, change 2012 versus 2023"},
]


def classify(hsv: np.ndarray) -> dict[str, np.ndarray]:
    h, s, v = hsv[..., 0].astype(np.int16), hsv[..., 1], hsv[..., 2]
    lit = (v >= 110) & ((s >= 40) | (v >= 200))  # city lights: bright, warm or white
    # OpenCV hue is 0..180. Purple/violet ~ 125-165, orange ~ 5-22.
    purple = (h >= 125) & (h <= 165) & (s >= 60) & (v >= 70)
    orange = (h >= 5) & (h <= 22) & (s >= 110) & (v >= 90)
    return {"lit": lit, "purple": purple, "orange": orange}


def light_index(v: np.ndarray, mask: np.ndarray) -> float:
    """Mean brightness above the land background (0..1), over the analysed area."""
    x = np.clip((v.astype(np.float32) - 90.0) / 165.0, 0, 1)
    return float(x[mask].mean()) if mask.any() else 0.0


def box(scale: float, b: tuple[int, int, int, int]) -> tuple[slice, slice]:
    x, y, w, h = (int(round(c * scale)) for c in b)
    return slice(y, y + h), slice(x, x + w)


def insets_present(hsv: np.ndarray) -> bool:
    """Grey inset border lines present? (long thin low-saturation runs)."""
    line = ((hsv[..., 1] < 40) & (hsv[..., 2] > 95) & (hsv[..., 2] < 200)).astype(np.uint8)
    hl = cv2.morphologyEx(line, cv2.MORPH_OPEN, np.ones((1, int(300 * SCALE)), np.uint8))
    return int(hl.sum()) > 2000 * SCALE


def label_at(phase: str, t: float) -> str | None:
    seq = YEAR_LABELS.get(phase)
    if not seq:
        return None
    year = seq[0][1]
    for ts, y in seq:
        if t + 1e-6 >= ts:
            year = y
    return str(year)


def run() -> dict:
    raw = RAW / ID
    out = PUBLIC_DATA / ID
    out.mkdir(parents=True, exist_ok=True)
    src = download(NIGHTLIGHTS["movie"], raw / FILE)

    # Display copy: HEVC is not playable in most browsers -> H.264, 1920x540.
    video = out / "video.mp4"
    if not video.exists():
        ffmpeg("-i", str(src), "-an", "-vf", f"crop={PERIOD}:2160:{WIN_X0}:0,scale={VIDEO_W}:{VIDEO_H}:flags=area", "-c:v", "libx264",
               "-preset", "slow", "-crf", "27", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(video))
    poster = out / "poster.jpg"
    if not poster.exists():
        ffmpeg("-ss", "34", "-i", str(video), "-frames:v", "1", "-q:v", "4", str(poster))

    # Sampled analysis frames (lossless PNG from the decoded HEVC).
    fdir = raw / "frames"
    if not fdir.exists() or not any(fdir.glob("*.png")):
        fdir.mkdir(parents=True, exist_ok=True)
        ffmpeg("-i", str(src), "-vf", f"fps={SAMPLE_FPS},scale=iw*{SCALE}:ih*{SCALE}:flags=area",
               str(fdir / "f%04d.png"))
    files = sorted(fdir.glob("*.png"))
    duration = float(subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(src)],
        capture_output=True, text=True, check=True).stdout.strip())

    frames, grids = [], []
    prev_v = None
    seen_change = False
    for k, p in enumerate(files):
        t = round(k / SAMPLE_FPS, 3)  # fps filter emits frames at 0, 0.5, 1.0 ...
        bgr = cv2.imread(str(p))
        hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
        H, W = hsv.shape[:2]
        cls = classify(hsv)
        area = np.ones((H, W), bool)
        oy, ox = box(SCALE, OVERLAY_MASK)
        area[oy, ox] = False
        zoom = insets_present(hsv)
        world = area.copy()
        if zoom:
            for _, b in INSETS.values():
                by, bx = box(SCALE, b)
                world[by, bx] = False
        n = world.sum()
        purple = (cls["purple"] & world).sum() / n
        orange = (cls["orange"] & world).sum() / n
        lit = (cls["lit"] & world).sum() / n
        is_change = (purple + orange) > 0.002
        # Insets fade in over ~2 s after the first change map: treat that as the zoom part.
        zoom_part = zoom or (seen_change and not is_change)
        phase = ("zoomChange" if is_change else "zoomAnnual") if zoom_part else ("change" if is_change else "annual")
        seen_change = seen_change or is_change

        v = hsv[..., 2]
        f = {
            "t": t,
            "phase": phase,
            "label": label_at(phase, t) or ("Change 2012 to 2023" if is_change else None),
            "light": F.r(light_index(v, world), 5),
            "shares": {
                "lit": F.r(lit, 5),
                "gain": F.r(purple if is_change else 0.0, 5),
                "loss": F.r(orange if is_change else 0.0, 5),
            },
            "change": F.r(float(np.abs(v.astype(np.int16) - prev_v).mean()) / 255, 5) if prev_v is not None else None,
        }
        g = purple + orange
        f["shares"]["gainFraction"] = F.r(purple / g, 4) if is_change and g > 0 else None
        f["shares"]["lossFraction"] = F.r(orange / g, 4) if is_change and g > 0 else None
        if zoom:
            regs = {}
            for key, (_, b) in INSETS.items():
                by, bx = box(SCALE, b)
                sub = {c: m[by, bx] for c, m in cls.items()}
                m = sub["lit"] | sub["purple"] | sub["orange"]
                lit_px = max(1, int(m.sum()))
                regs[key] = {
                    "light": F.r(light_index(v[by, bx], np.ones_like(sub["lit"])), 5),
                    "gain": F.r(sub["purple"].sum() / lit_px, 4) if is_change else None,
                    "loss": F.r(sub["orange"].sum() / lit_px, 4) if is_change else None,
                }
            f["regions"] = regs
        # Year progress for the before/after stereo image (2012 left -> 2023 right).
        if f["label"] and f["label"].isdigit():
            f["yearProgress"] = F.r((int(f["label"]) - 2012) / 11, 4)
        frames.append(f)
        prev_v = v.astype(np.int16)

        # Explore grid: annual -> brightness 0..100; change -> net change -100..100.
        vf = np.clip((v.astype(np.float32) - 90) / 165, 0, 1) * 100
        field = np.where(cls["purple"], 100.0, np.where(cls["orange"], -100.0, 0.0)) if is_change else vf
        field = np.where(area, field, np.nan)
        # Explore grid on the globe window (equirectangular after the vertical squash).
        wx0, ww = int(round(WIN_X0 * SCALE)), int(round(PERIOD * SCALE))
        gr = F.grid(field[:, wx0 : wx0 + ww], GRID_W, GRID_H)
        if is_change:  # share of changed pixels per cell, signed
            gr = np.clip(gr * 4, -100, 100)
        else:
            gr = np.clip(gr * 4, 0, 100)
        grids.append(F.quantize_grid(gr, -100, 100))

    # Lit area relative to the first frame of the same kind of view (100 = start year).
    base: dict[str, float] = {}
    for f in frames:
        if f["phase"] in ("annual", "zoomAnnual") and f["shares"]["lit"]:
            key = f["phase"]
            # zoomAnnual baseline: first frame once the insets are fully in
            if key not in base and (key == "annual" or "regions" in f):
                base[key] = f["shares"]["lit"]
            if key in base:
                rel = 100.0 * f["shares"]["lit"] / base[key]
                # < 60 only happens on the crossfade frame into a change map: not a year value
                f["litVsStart"] = F.r(rel, 1) if rel >= 60 else None

    # Report detected phase spans (compare with the label reading in the docstring).
    spans = []
    for f in frames:
        if not spans or spans[-1]["id"] != f["phase"]:
            spans.append({"id": f["phase"], "start": f["t"], "end": f["t"]})
        spans[-1]["end"] = f["t"] + 1 / SAMPLE_FPS
    spans[-1]["end"] = round(duration, 3)
    log("phases:", [(s["id"], s["start"], s["end"]) for s in spans])
    labels = {p["id"]: p["label"] for p in PHASES}
    phases = [{**s, "label": labels[s["id"]]} for s in spans]

    meta = {
        "id": ID,
        "title": "Night Lights 2012–2023",
        "svsId": 5313,
        "svsUrl": NIGHTLIGHTS["page"],
        "kind": "color",
        "kindLabel": "No legend units: brightness and color are the data",
        "sourceLabel": "NASA Black Marble (VIIRS)",
        "description": ("Annual night-light maps from NASA's Black Marble product, 2012 to 2023, followed by a "
                        "change map: purple where night lights grew, orange where they faded, then zoomed views of "
                        "Western Europe, the Eastern Mediterranean, Ukraine and India. There are no units, so the "
                        "music follows how much of the map is lit, brightening or dimming."),
        "units": "relative",
        "range": [-100, 100],
        "period": "2012 to 2023",
        "projection": "equirectangular",
        "aspect": 2.0,
        "video": {"src": f"/data/{ID}/video.mp4", "poster": f"/data/{ID}/poster.jpg", "width": VIDEO_W,
                  "height": VIDEO_H, "duration": round(duration, 3), "fps": 30},
        "phases": phases,
        "regions": {k: v[0] for k, v in INSETS.items()},
        "caveats": [
            "No colorbar or units: brightness and purple/orange area are relative measures, not radiance.",
            "The EIC frame shows the world map twice side by side, stretched to 16:9. We use one copy, re-projected to 2:1 by matching its coastlines to a known lat/lon map (about 1 degree accuracy). Zoom-inset statistics come from the full frame.",
            "Year labels and phase timing were read from the video; purple and orange compare 2012 with 2023 only.",
        ],
        "grid": {"w": GRID_W, "h": GRID_H, "min": -100, "max": 100, "noData": 255},
    }
    (out / "meta.json").write_text(json.dumps(meta, indent=1, ensure_ascii=False), encoding="utf-8")
    (out / "features.json").write_text(json.dumps({"frames": frames}, separators=(",", ":")), encoding="utf-8")
    (out / "grid.json").write_text(json.dumps({"frames": grids}, separators=(",", ":")), encoding="utf-8")
    return {"meta": meta}


if __name__ == "__main__":
    run()
