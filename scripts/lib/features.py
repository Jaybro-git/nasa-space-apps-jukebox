"""Shared per-frame feature extraction. Works on a 2D float field (decoded values, or
brightness, or a signed change score) laid out as an equirectangular map unless the
dataset says otherwise. NaN = no data (land, overlays)."""

from __future__ import annotations

import math
import warnings

import cv2
import numpy as np

GRID_W, GRID_H = 72, 36  # 5 degree cells on a 2:1 map


def r(x: float | None, nd: int = 3) -> float | None:
    if x is None or not math.isfinite(float(x)):
        return None
    return round(float(x), nd)


def lat_lon(y: float, x: float, h: int, w: int) -> tuple[float, float]:
    """Pixel center -> (lat, lon) on an equirectangular image."""
    return 90.0 - (y + 0.5) / h * 180.0, -180.0 + (x + 0.5) / w * 360.0


def stats(field: np.ndarray) -> dict:
    v = field[np.isfinite(field)]
    if v.size == 0:
        return {"mean": None, "min": None, "max": None, "std": None, "p10": None, "p50": None, "p90": None, "coverage": 0.0}
    p10, p50, p90 = np.percentile(v, [10, 50, 90])
    return {
        "mean": r(v.mean()),
        "min": r(v.min()),
        "max": r(v.max()),
        "std": r(v.std()),
        "p10": r(p10),
        "p50": r(p50),
        "p90": r(p90),
        "coverage": r(v.size / field.size, 4),
    }


def area_mean(g: np.ndarray) -> float | None:
    """cos(latitude)-weighted mean of an equirectangular grid (NaN cells skipped)."""
    gh = g.shape[0]
    lats = 90.0 - (np.arange(gh) + 0.5) / gh * 180.0
    w = np.cos(np.radians(lats))[:, None] * np.ones_like(g)
    m = np.isfinite(g)
    return r((g[m] * w[m]).sum() / w[m].sum()) if m.any() else None


def lat_bands(field: np.ndarray) -> dict:
    """Mean per latitude band. Area-weighted by cos(lat) within each band."""
    h, w = field.shape
    lats = 90.0 - (np.arange(h) + 0.5) / h * 180.0
    bands = {
        "north_polar": (60, 90),
        "north_mid": (30, 60),
        "tropics": (-30, 30),
        "south_mid": (-60, -30),
        "south_polar": (-90, -60),
    }
    out = {}
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        row_mean = np.nanmean(field, axis=1)
        row_n = np.isfinite(field).sum(axis=1)
    wts = np.cos(np.radians(lats)) * row_n
    for name, (lo, hi) in bands.items():
        m = (lats >= lo) & (lats < hi) & np.isfinite(row_mean) & (wts > 0)
        out[name] = r(np.average(row_mean[m], weights=wts[m])) if m.any() else None
    return out


def hotspot(field: np.ndarray, cells: tuple[int, int] = (144, 72), min_frac: float = 0.05) -> dict:
    """Location + value of the maximum cell mean on a 2.5-degree grid. Cell means make it
    robust to single bright pixels; cells with < min_frac valid pixels are ignored."""
    h, w = field.shape
    gw, gh = cells
    ys = np.linspace(0, h, gh + 1).astype(int)
    xs = np.linspace(0, w, gw + 1).astype(int)
    valid = np.isfinite(field)
    vals = np.nan_to_num(field)
    # block sums via cumulative sums
    def block(a):
        c = np.pad(a.astype(np.float64), ((1, 0), (1, 0))).cumsum(0).cumsum(1)
        return c[ys[1:]][:, xs[1:]] - c[ys[:-1]][:, xs[1:]] - c[ys[1:]][:, xs[:-1]] + c[ys[:-1]][:, xs[:-1]]
    n = block(valid)
    tot = block(vals)
    area = np.outer(np.diff(ys), np.diff(xs))
    with np.errstate(invalid="ignore", divide="ignore"):
        mean = np.where(n >= np.maximum(3, min_frac * area), tot / n, -np.inf)
    if not np.isfinite(mean).any():
        return {"x": None, "y": None, "lat": None, "lon": None, "value": None}
    j, i = np.unravel_index(int(np.argmax(mean)), mean.shape)
    lat = 90.0 - (j + 0.5) / gh * 180.0
    lon = -180.0 + (i + 0.5) / gw * 360.0
    return {"x": r((i + 0.5) / gw, 4), "y": r((j + 0.5) / gh, 4), "lat": r(lat, 1), "lon": r(lon, 1), "value": r(mean[j, i])}


def gradient_strength(field: np.ndarray) -> float | None:
    """Mean Sobel magnitude over valid pixels (units per pixel). Fronts/currents proxy."""
    f = np.nan_to_num(field, nan=0.0).astype(np.float32)
    valid = np.isfinite(field).astype(np.uint8)
    valid = cv2.erode(valid, np.ones((3, 3), np.uint8))  # drop coast edges
    gx = cv2.Sobel(f, cv2.CV_32F, 1, 0, ksize=3) / 8.0
    gy = cv2.Sobel(f, cv2.CV_32F, 0, 1, ksize=3) / 8.0
    mag = np.sqrt(gx * gx + gy * gy)[valid > 0]
    return r(mag.mean(), 4) if mag.size else None


def frame_change(a: np.ndarray | None, b: np.ndarray) -> float | None:
    """Mean absolute difference between two fields where both are valid."""
    if a is None:
        return None
    m = np.isfinite(a) & np.isfinite(b)
    return r(np.abs(a[m] - b[m]).mean(), 4) if m.any() else None


def grid(field: np.ndarray, gw: int = GRID_W, gh: int = GRID_H) -> np.ndarray:
    """Block nanmean downsample to (gh, gw)."""
    h, w = field.shape
    ys = np.linspace(0, h, gh + 1).astype(int)
    xs = np.linspace(0, w, gw + 1).astype(int)
    out = np.full((gh, gw), np.nan, np.float32)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        for j in range(gh):
            band = field[ys[j] : ys[j + 1]]
            for i in range(gw):
                out[j, i] = np.nanmean(band[:, xs[i] : xs[i + 1]])
    return out


def quantize_grid(g: np.ndarray, vmin: float, vmax: float) -> list[int]:
    """Floats -> 0..254 ints (255 = no data). Flat row-major list for compact JSON."""
    q = np.round((g - vmin) / (vmax - vmin) * 254)
    q = np.clip(q, 0, 254)
    q[~np.isfinite(g)] = 255
    return q.astype(np.uint8).ravel().tolist()


def blobs(mask: np.ndarray, min_area: int = 2, max_n: int = 400) -> list[dict]:
    """Connected components of a boolean mask -> [{x, y, size}] (x, y normalized 0..1)."""
    n, _, st, cen = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=8)
    h, w = mask.shape
    out = []
    for i in range(1, n):
        area = int(st[i, cv2.CC_STAT_AREA])
        if area < min_area:
            continue
        out.append({"x": r(cen[i, 0] / w, 4), "y": r(cen[i, 1] / h, 4), "size": area})
    out.sort(key=lambda b: -b["size"])
    return out[:max_n]
