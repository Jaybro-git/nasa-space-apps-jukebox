"""SVS 5011 — Lightning Events Detected from the ISS (LIS), Science On a Sphere version.

Case: DETECTED EVENTS ARE THE DATA. No colorbar or units: each yellow dot is a lightning
event seen by LIS on the ISS, shown in a 10-day roving window. We detect yellow blobs
(threshold + connected components). Dots that are NEW since the previous sample become
percussive hits; the overall pattern (how much, where, north vs south) steers the music.

Source: iss_lightning_sos_yearly_07312023_2048p60.mp4 (4096x2048, 2:1 equirectangular,
checked on frames: continents line up with a plate carree grid; grey lines mark the
equator and tropics). Only a 90 s window (source 8-98 s) is streamed with HTTP range
requests -- the full 334 MB movie is never downloaded.

The SOS movie has no on-screen date and the page does not give its time base, so this
track does NOT attach calendar dates. It describes seasons by where the lightning is.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import cv2
import numpy as np

from lib import features as F
from lib.fetch import PUBLIC_DATA, RAW, ffmpeg, log
from sources import LIGHTNING

ID = "lightning"
CLIP_START, CLIP_LEN = 8, 90  # seconds in the source movie (of 100)
ANALYSIS_FPS = 6
VIDEO_W, VIDEO_H = 1280, 640
LIS_LAT = 55  # LIS on the ISS sees roughly +-55 degrees; outside is always empty


def yellow_mask(bgr: np.ndarray) -> np.ndarray:
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    return (h >= 18) & (h <= 36) & (s >= 110) & (v >= 110)


def ensure_clip(raw: Path) -> tuple[Path, Path]:
    clip = raw / "clip_1280.mp4"
    fdir = raw / "frames"
    if clip.exists() and fdir.exists() and any(fdir.glob("*.png")):
        return clip, fdir
    fdir.mkdir(parents=True, exist_ok=True)
    ffmpeg("-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "10",
           "-ss", str(CLIP_START), "-t", str(CLIP_LEN), "-i", LIGHTNING["movie"],
           "-filter_complex", f"[0:v]split=2[a][b];[a]fps=30,scale={VIDEO_W}:{VIDEO_H}:flags=area[v];"
                              f"[b]fps={ANALYSIS_FPS},scale=2048:1024:flags=area[f]",
           "-map", "[v]", "-an", "-c:v", "libx264", "-preset", "slow", "-crf", "27", "-pix_fmt", "yuv420p",
           "-movflags", "+faststart", str(clip), "-map", "[f]", str(fdir / "f%04d.png"))
    return clip, fdir


def run() -> dict:
    raw = RAW / ID
    out = PUBLIC_DATA / ID
    out.mkdir(parents=True, exist_ok=True)
    clip, fdir = ensure_clip(raw)
    shutil.copyfile(clip, out / "video.mp4")
    poster = out / "poster.jpg"
    if not poster.exists():
        ffmpeg("-ss", "8", "-i", str(clip), "-frames:v", "1", "-q:v", "4", str(poster))

    files = sorted(fdir.glob("*.png"))
    frames, grids = [], []
    prev = None
    for k, p in enumerate(files):
        bgr = cv2.imread(str(p))
        m = yellow_mask(bgr)
        h, w = m.shape
        lats = 90.0 - (np.arange(h) + 0.5) / h * 180.0
        north = m[lats > 0].sum()
        total = int(m.sum())
        # New flashes: yellow now, not near yellow in the previous sample.
        if prev is not None:
            new = m & ~cv2.dilate(prev.astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool)
        else:
            new = np.zeros_like(m)
        events = F.blobs(new, min_area=3, max_n=2000)
        density = F.grid(m.astype(np.float32))  # share of yellow pixels per 5 degree cell
        hs = F.hotspot(m.astype(np.float32), cells=(72, 36), min_frac=0.0)
        ys, xs = np.nonzero(m)
        if xs.size:
            ang = np.radians(-180.0 + (xs + 0.5) / w * 360.0)
            clon = float(np.degrees(np.arctan2(np.sin(ang).mean(), np.cos(ang).mean())))
            clat = float(90.0 - (ys.mean() + 0.5) / h * 180.0)
        else:
            clon = clat = None
        frames.append({
            "t": round(k / ANALYSIS_FPS, 3),
            "flashArea": F.r(total / m.size, 6),
            "northShare": F.r(north / total, 4) if total else None,
            "tropicsShare": F.r(m[np.abs(lats) <= 23.4].sum() / total, 4) if total else None,
            "centroid": {"lat": F.r(clat, 1), "lon": F.r(clon, 1),
                         "x": F.r((clon + 180) / 360, 4) if clon is not None else None},
            "hotspot": hs,
            "eventCount": len(events),
            "events": events[:12],
            "change": F.r(float((m ^ prev).mean()), 6) if prev is not None else None,
        })
        grids.append(F.quantize_grid(np.clip(density * 400, 0, 100), 0, 100))
        prev = m
    log(f"{len(frames)} frames, events/frame median {np.median([f['eventCount'] for f in frames]):.0f}")

    meta = {
        "id": ID,
        "title": "Lightning Seen from the ISS",
        "svsId": 5011,
        "svsUrl": LIGHTNING["page"],
        "kind": "events",
        "kindLabel": "No legend units: detected flashes are the data",
        "sourceLabel": "LIS on the International Space Station",
        "description": ("Lightning events detected by the Lightning Imaging Sensor on the International Space Station, "
                        "shown as a 10-day window rolling through the seasons. Every new flash becomes a percussive "
                        "hit: left to right follows longitude, higher notes are further north. Listen to the storms "
                        "swing between the hemispheres."),
        "units": "flash density",
        "range": [0, 100],
        "period": f"2017 to 2023 ({CLIP_LEN} s excerpt)",
        "projection": "equirectangular",
        "aspect": 2.0,
        "video": {"src": f"/data/{ID}/video.mp4", "poster": f"/data/{ID}/poster.jpg", "width": VIDEO_W,
                  "height": VIDEO_H, "duration": float(CLIP_LEN), "fps": 30},
        "caveats": [
            "No colorbar or units: a flash is a detected event, and density is relative.",
            "The Science On a Sphere movie has no date label, so this track describes seasons by where lightning is, not by calendar date.",
            f"{CLIP_LEN}-second excerpt (source seconds {CLIP_START} to {CLIP_START + CLIP_LEN}) of a 100-second movie covering January 2017 to July 2023.",
            f"LIS on the ISS only sees between about {LIS_LAT} degrees north and south.",
        ],
        "grid": {"w": F.GRID_W, "h": F.GRID_H, "min": 0, "max": 100, "noData": 255},
    }
    (out / "meta.json").write_text(json.dumps(meta, indent=1, ensure_ascii=False), encoding="utf-8")
    (out / "features.json").write_text(json.dumps({"frames": frames}, separators=(",", ":")), encoding="utf-8")
    (out / "grid.json").write_text(json.dumps({"frames": grids}, separators=(",", ":")), encoding="utf-8")
    return {"meta": meta}


if __name__ == "__main__":
    run()
