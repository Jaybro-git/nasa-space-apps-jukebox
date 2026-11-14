"""SVS 3912 — Global Sea Surface Currents and Temperature (ECCO2, Mar 2007 - Mar 2008).

Case: LEGEND-DECODED VALUES. Each ocean pixel's color is decoded back to degrees C with
the published colorbar (sst_ecco2_cbar.png). Analysis uses the lossless TIF frames; the
web player shows a downscaled H.264 copy of the SVS movie, aligned to the TIF frames by
thumbnail correlation (not assumed).
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from pathlib import Path

import cv2
import numpy as np

from lib import features as F
from lib.colorbar import Colorbar
from lib.fetch import PUBLIC_DATA, RAW, download, ffmpeg, list_directory, log
from sources import SST

ID = "sst"
N_FRAMES = 36  # ~10 days apart over the year
VMIN, VMAX = 0.0, 32.0
VIDEO_W, VIDEO_H = 1280, 640
THUMB = (128, 64)


def frame_number(name: str) -> int:
    return int(name.rsplit(".", 2)[-2])


def pick_frames(names: list[str], n: int) -> list[str]:
    idx = np.linspace(0, len(names) - 1, n).round().astype(int)
    return [names[i] for i in idx]


def read_rgb(path: Path) -> np.ndarray:
    bgr = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if bgr is None:
        raise RuntimeError(f"cannot read {path}")
    return cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)


def thumb(rgb: np.ndarray) -> np.ndarray:
    g = cv2.cvtColor(cv2.resize(rgb, THUMB, interpolation=cv2.INTER_AREA), cv2.COLOR_RGB2GRAY).astype(np.float32)
    return (g - g.mean()) / (g.std() + 1e-6)


def video_thumbs(path: Path) -> tuple[np.ndarray, float]:
    cap = cv2.VideoCapture(str(path))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    out = []
    while True:
        ok, bgr = cap.read()
        if not ok:
            break
        out.append(thumb(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)))
    cap.release()
    return np.stack(out), fps


def align(tif_thumbs: list[np.ndarray], vthumbs: np.ndarray) -> list[int]:
    """Best-matching video frame for each TIF thumbnail (normalized cross-correlation)."""
    flat = vthumbs.reshape(len(vthumbs), -1)
    return [int(np.argmax(flat @ t.ravel())) for t in tif_thumbs]


SKIP_FRAMES = 30  # the first second: flow particles are still spinning up (sparse poles)


def warm_centroid(sst: np.ndarray, thresh: float = 28.0) -> dict:
    """Circular-mean longitude of water >= thresh (the warm pool). Steadier than the
    single hottest cell, which flickers between equally saturated cells."""
    h, w = sst.shape
    ys, xs = np.nonzero(np.nan_to_num(sst, nan=-99) >= thresh)
    if xs.size == 0:
        return {"x": None, "lon": None, "lat": None}
    ang = np.radians(-180.0 + (xs + 0.5) / w * 360.0)
    lon = float(np.degrees(np.arctan2(np.sin(ang).mean(), np.cos(ang).mean())))
    lat = float(90.0 - (ys.mean() + 0.5) / h * 180.0)
    return {"x": F.r((lon + 180.0) / 360.0, 4), "lon": F.r(lon, 1), "lat": F.r(lat, 1)}


def video_frames(path: Path, n: int) -> tuple[list[tuple[int, np.ndarray]], float, int]:
    """n evenly spaced RGB frames from a video -> [(frame_index, rgb)], fps, total frames."""
    cap = cv2.VideoCapture(str(path))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    want = set(np.linspace(SKIP_FRAMES, total - 1, n).round().astype(int).tolist())
    out, i = [], 0
    while True:
        ok, bgr = cap.read()
        if not ok:
            break
        if i in want:
            out.append((i, cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)))
        i += 1
    cap.release()
    return out, fps, i


def run(lite: bool = False) -> dict:
    """lite=True: analyse + display the small SVS m4v (640x320, 12 MB) instead of the
    lossless TIF frames + 244 MB movie. Same features, ~0.5 C extra decode noise."""
    raw = RAW / ID
    out = PUBLIC_DATA / ID
    out.mkdir(parents=True, exist_ok=True)

    # 1. colorbar -> decoder
    cbar_path = download(SST["colorbar"], raw / "sst_ecco2_cbar.png")
    # Shaded: the frames draw flow streaks in darkened colorbar colors -> decode by hue.
    cbar = Colorbar.from_image(str(cbar_path), VMIN, VMAX, units="°C").set_shaded()
    log(f"colorbar LUT: {len(cbar.colors)} entries, bar box {cbar.bar_box}")
    cv2.imwrite(str(out / "colorbar.png"), cv2.imread(str(cbar_path), cv2.IMREAD_UNCHANGED))

    t0 = datetime.fromisoformat(SST["start"].replace("Z", "+00:00"))
    t1 = datetime.fromisoformat(SST["end"].replace("Z", "+00:00"))
    video = out / "video.mp4"

    if lite:
        src = download(SST["movie_small"], raw / "ecco2_sst_flow.m4v")
        if not video.exists():
            ffmpeg("-i", str(src), "-an", "-c:v", "libx264", "-preset", "slow", "-crf", "26",
                   "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(video))
        sampled, fps, total = video_frames(src, N_FRAMES)
        items = [(f"{src.name}#{i}", rgb, i / max(1, total - 1), round(i / fps, 3)) for i, rgb in sampled]
        vw, vh = sampled[0][1].shape[1], sampled[0][1].shape[0]
        duration = total / fps
        vthumbs = None
    else:
        # 2. frames (real names from the SVS directory listing)
        names = list_directory(SST["frames_dir"], SST["frame_pattern"])
        names.sort(key=frame_number)
        chosen = pick_frames(names[SKIP_FRAMES:], N_FRAMES)
        paths = [download(SST["frames_dir"] + n, raw / "frames" / n) for n in chosen]
        f0, f1 = frame_number(names[0]), frame_number(names[-1])
        # 3. display video: downscale the SVS movie (streamed; only the encoded copy is kept)
        if not video.exists():
            ffmpeg("-i", SST["movie"], "-an", "-vf", f"scale={VIDEO_W}:{VIDEO_H}:flags=area",
                   "-c:v", "libx264", "-preset", "slow", "-crf", "28", "-pix_fmt", "yuv420p",
                   "-movflags", "+faststart", str(video))
        vthumbs, fps = video_thumbs(video)
        duration = len(vthumbs) / fps
        vw, vh = VIDEO_W, VIDEO_H
        # Dates: frame numbers are spread linearly over the published time range.
        items = [(n, read_rgb(p), (frame_number(n) - f0) / max(1, f1 - f0), None) for n, p in zip(chosen, paths)]

    poster = out / "poster.jpg"
    if not poster.exists():
        ffmpeg("-ss", "20", "-i", str(video), "-frames:v", "1", "-q:v", "4", str(poster))

    # 4. per-frame features
    frames, grids, tif_thumbs = [], [], []
    prev = None
    for name, rgb, u, t in items:
        tif_thumbs.append(thumb(rgb))
        sst = cbar.decode(rgb)
        date = t0 + (t1 - t0) * u
        g = F.grid(sst)
        w = sst.shape[1]
        grad = F.gradient_strength(sst)
        cold = F.hotspot(-sst)
        if cold["value"] is not None:
            cold["value"] = F.r(-cold["value"])
        bands = F.lat_bands(sst)
        valid = sst[np.isfinite(sst)]
        ns = (bands["north_mid"] - bands["south_mid"]) if None not in (bands["north_mid"], bands["south_mid"]) else None
        frames.append({
            "t": t,
            "source": name,
            "date": date.date().isoformat(),
            # mean = area-weighted over 5-degree cells, so densely drawn streak regions
            # don't outweigh sparse ones; min/max/percentiles are per decoded pixel
            "stats": {**F.stats(sst), "mean": F.area_mean(g)},
            "bands": bands,
            # share of ocean pixels >= 28 C (the Indo-Pacific "warm pool" threshold)
            "shares": {"warm28": F.r((valid >= 28.0).mean(), 4) if valid.size else None},
            # mid-latitude north minus south: flips sign with the seasons
            "contrast": {"nsMid": F.r(ns)},
            "hotspot": F.hotspot(sst),
            "warmPool": warm_centroid(sst),
            "coldspot": cold,
            # degrees C per degree of longitude: resolution-independent
            "gradient": F.r(grad * w / 360.0, 4) if grad is not None else None,
            "change": F.frame_change(prev, sst),
        })
        grids.append(F.quantize_grid(g, VMIN, VMAX))
        prev = sst
        log(name, frames[-1]["date"], frames[-1]["stats"]["mean"], "°C mean")

    # 5. time alignment to the display video (full mode: frames come from separate TIFs)
    if vthumbs is not None:
        vidx = align(tif_thumbs, vthumbs)
        monotonic = all(b >= a for a, b in zip(vidx, vidx[1:]))
        if not monotonic:
            log("WARNING: alignment not monotonic, falling back to linear spacing", vidx)
            vidx = np.linspace(0, len(vthumbs) - 1, len(frames)).round().astype(int).tolist()
        for f, vi in zip(frames, vidx):
            f["t"] = round(vi / fps, 3)

    meta = {
        "id": ID,
        "title": "Ocean Currents & Sea Surface Temperature",
        "svsId": 3912,
        "svsUrl": SST["page"],
        "kind": "decoded",
        "kindLabel": "Decoded values (°C from the colorbar)",
        "sourceLabel": "ECCO2 ocean model",
        "description": ("Sea surface temperature and currents from the ECCO2 ocean model, March 2007 to March 2008. "
                        "Every ocean pixel's color is decoded back to degrees Celsius with the published colorbar, "
                        "so you hear real temperatures: the seasons swapping hemispheres, the tropical warm pool "
                        "swelling and shrinking, and fast currents like the Gulf Stream as shimmer."),
        "units": "°C",
        "range": [VMIN, VMAX],
        "period": f"{t0.date()} to {t1.date()}",
        "projection": "equirectangular",
        "aspect": 2.0,
        "video": {"src": f"/data/{ID}/video.mp4", "poster": f"/data/{ID}/poster.jpg", "width": vw, "height": vh, "duration": round(duration, 3), "fps": fps},
        "source": "SVS ecco2_sst_flow.m4v (640x320)" if lite else "SVS lossless TIF frames (2048x1024)",
        "colorbar": {"src": f"/data/{ID}/colorbar.png", **cbar.to_json(step=4)},
        "caveats": [
            "ECCO2 is an ocean model constrained by observations, not a direct satellite image.",
            "One year (March 2007 to March 2008): the changes you hear are the seasons, not long-term climate change.",
            "Values are decoded from rendered colors, so precision is limited to about half a degree.",
        ],
        "grid": {"w": F.GRID_W, "h": F.GRID_H, "min": VMIN, "max": VMAX, "noData": 255},
    }
    (out / "meta.json").write_text(json.dumps(meta, indent=1, ensure_ascii=False), encoding="utf-8")
    (out / "features.json").write_text(json.dumps({"frames": frames}, separators=(",", ":")), encoding="utf-8")
    (out / "grid.json").write_text(json.dumps({"frames": grids}, separators=(",", ":")), encoding="utf-8")
    return {"meta": meta, "frames": frames}


if __name__ == "__main__":
    run()
