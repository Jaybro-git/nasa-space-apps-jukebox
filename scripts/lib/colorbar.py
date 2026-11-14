"""Colorbar decoder: turn a rendered pixel color back into the data value it encodes.

Approach
--------
1. Find the colored bar inside the colorbar image (bounding box of saturated pixels).
2. Sample each column of the bar (median over the inner rows) -> ordered list of RGB
   colors = the lookup table (LUT).
3. Map LUT column -> value. By default the bar is assumed linear between ``vmin`` at its
   left edge and ``vmax`` at its right edge; ``fit_ticks`` can refine this from the
   positions of known tick labels.
4. Decode: for every pixel find the nearest LUT color in CIE Lab space. Pixels whose
   nearest LUT color is further than ``max_dist`` (land, text, coastlines) become NaN.

To keep decoding a 2048x1024 frame fast, nearest-neighbour results are precomputed once
for a 64x64x64 RGB cube (4 RGB levels per bin), so decoding is a single table lookup.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np

CUBE_BITS = 6  # 64 levels per channel
CUBE_N = 1 << CUBE_BITS
CUBE_SHIFT = 8 - CUBE_BITS


def rgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    """uint8/float RGB (..., 3) -> float32 Lab (..., 3) with L in 0..100."""
    arr = np.asarray(rgb, dtype=np.float32).reshape(-1, 1, 3) / 255.0
    lab = cv2.cvtColor(arr, cv2.COLOR_RGB2LAB)
    return lab.reshape(np.shape(rgb)[:-1] + (3,))


def find_bar_box(rgb: np.ndarray, sat_min: int = 60) -> tuple[int, int, int, int]:
    """Bounding box (x0, x1, y0, y1), exclusive ends, of the saturated colored bar."""
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    mask = (hsv[..., 1] >= sat_min) & (hsv[..., 2] >= 60)
    # The bar is the dominant run of saturated rows; keep rows where most columns qualify.
    row_fill = mask.sum(axis=1)
    rows = np.where(row_fill > 0.5 * row_fill.max())[0]
    if rows.size == 0:
        raise ValueError("no colored bar found")
    y0, y1 = int(rows.min()), int(rows.max()) + 1
    col_fill = mask[y0:y1].sum(axis=0)
    cols = np.where(col_fill > 0.5 * (y1 - y0))[0]
    x0, x1 = int(cols.min()), int(cols.max()) + 1
    return x0, x1, y0, y1


def collapse_runs(colors: np.ndarray, values: np.ndarray, tol: float = 0.5):
    """Merge consecutive columns with (nearly) the same color into one LUT entry at
    their mean value. A saturated bar end (e.g. flat red above ~31 C) would otherwise
    always decode to the run's first value. Returns colors, values, (lo, hi) spans."""
    lab = rgb_to_lab(colors)
    groups: list[list[int]] = [[0]]
    for i in range(1, len(colors)):
        if np.linalg.norm(lab[i] - lab[groups[-1][-1]]) < tol:
            groups[-1].append(i)
        else:
            groups.append([i])
    c = np.array([colors[g[len(g) // 2]] for g in groups], np.uint8)
    v = np.array([values[g].mean() for g in groups], np.float32)
    spans = np.array([(values[g[0]], values[g[-1]]) for g in groups], np.float32)
    return c, v, spans


@dataclass
class Colorbar:
    colors: np.ndarray  # (N, 3) uint8 RGB, ordered low -> high value
    values: np.ndarray  # (N,) float value of each LUT entry
    units: str = ""
    max_dist: float = 12.0  # Lab distance threshold for "this is a data pixel"
    _lab: np.ndarray = field(init=False, repr=False)
    _cube_val: np.ndarray | None = field(default=None, init=False, repr=False)

    def __post_init__(self) -> None:
        self.colors = np.asarray(self.colors, dtype=np.uint8)
        self.values = np.asarray(self.values, dtype=np.float32)
        self._lab = rgb_to_lab(self.colors)

    # -- construction -----------------------------------------------------------------
    @classmethod
    def from_image(
        cls,
        path: str,
        vmin: float,
        vmax: float,
        units: str = "",
        inset: int = 2,
        max_dist: float = 12.0,
    ) -> "Colorbar":
        """Build a LUT from a colorbar image. ``inset`` trims anti-aliased bar edges."""
        bgr = cv2.imread(path, cv2.IMREAD_COLOR)
        if bgr is None:
            raise FileNotFoundError(path)
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        return cls.from_rgb(rgb, vmin, vmax, units=units, inset=inset, max_dist=max_dist)

    @classmethod
    def from_rgb(
        cls,
        rgb: np.ndarray,
        vmin: float,
        vmax: float,
        units: str = "",
        inset: int = 2,
        max_dist: float = 12.0,
    ) -> "Colorbar":
        x0, x1, y0, y1 = find_bar_box(rgb)
        inner = rgb[y0 + inset : y1 - inset, x0 + inset : x1 - inset].astype(np.float32)
        colors = np.median(inner, axis=0).round().astype(np.uint8)  # one color per column
        # Column centers -> values, linear across the full (un-inset) bar width.
        xs = np.arange(x0 + inset, x1 - inset) + 0.5
        values = vmin + (xs - x0) / (x1 - x0) * (vmax - vmin)
        colors, values, spans = collapse_runs(colors, values)
        cb = cls(colors, values, units=units, max_dist=max_dist)
        cb.spans = spans  # type: ignore[attr-defined]
        cb.bar_box = (x0, x1, y0, y1)  # type: ignore[attr-defined]
        return cb

    # -- decoding ---------------------------------------------------------------------
    def nearest(self, rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Exact nearest-LUT search. Returns (value, lab distance) per input color."""
        lab = rgb_to_lab(np.asarray(rgb)).reshape(-1, 3)
        out_v = np.empty(len(lab), np.float32)
        out_d = np.empty(len(lab), np.float32)
        for s in range(0, len(lab), 65536):
            chunk = lab[s : s + 65536]
            d2 = ((chunk[:, None, :] - self._lab[None, :, :]) ** 2).sum(-1)
            idx = d2.argmin(1)
            out_v[s : s + 65536] = self.values[idx]
            out_d[s : s + 65536] = np.sqrt(d2[np.arange(len(idx)), idx])
        shape = np.shape(rgb)[:-1]
        return out_v.reshape(shape), out_d.reshape(shape)

    # Shaded mode: the visualization draws flow streaks whose colors are colorbar colors
    # darkened and contrast-shifted onto a black background (e.g. bar (56,236,131) appears
    # as (0,155,86)). Absolute RGB no longer matches, but HUE survives both scaling and
    # an equal offset on all channels, and this bar's hue runs monotonically from blue
    # (~228 deg) to red (~354 deg, through green and yellow). So: decode by nearest hue,
    # reject dark pixels (background) and grey pixels (land, text).
    shaded: bool = False
    min_bright: int = 55  # max channel below this = background, not data
    min_sat: float = 0.35  # (max-min)/max below this = grey land / text
    max_hue_dist: float = 8.0  # degrees

    @staticmethod
    def hue(rgb: np.ndarray) -> np.ndarray:
        """HSV hue in degrees (0..360) for (..., 3) RGB."""
        f = np.asarray(rgb, np.float32).reshape(-1, 1, 3) / 255.0
        h = cv2.cvtColor(f, cv2.COLOR_RGB2HSV)[..., 0]
        return h.reshape(np.shape(rgb)[:-1])

    def nearest_shaded(self, rgb: np.ndarray) -> np.ndarray:
        rgb = np.asarray(rgb).reshape(-1, 3)
        h = self.hue(rgb)
        lut = self.hue(self.colors)
        out = np.empty(len(h), np.float32)
        for s in range(0, len(h), 65536):
            d = np.abs(h[s : s + 65536, None] - lut[None])
            d = np.minimum(d, 360 - d)
            idx = d.argmin(1)
            v = self.values[idx].copy()
            v[d[np.arange(len(idx)), idx] > self.max_hue_dist] = np.nan
            out[s : s + 65536] = v
        f = rgb.astype(np.float32)
        mx, mn = f.max(1), f.min(1)
        out[(mx < self.min_bright) | ((mx - mn) / np.maximum(mx, 1) < self.min_sat)] = np.nan
        return out

    def _cube(self) -> np.ndarray:
        if self._cube_val is None:
            levels = (np.arange(CUBE_N) << CUBE_SHIFT) + (1 << CUBE_SHIFT) // 2
            r, g, b = np.meshgrid(levels, levels, levels, indexing="ij")
            grid = np.stack([r, g, b], -1).reshape(-1, 3).astype(np.uint8)
            if self.shaded:
                val = self.nearest_shaded(grid)
            else:
                val, dist = self.nearest(grid)
                val[dist > self.max_dist] = np.nan
            self._cube_val = val.reshape(CUBE_N, CUBE_N, CUBE_N)
        return self._cube_val

    def set_shaded(self, on: bool = True) -> "Colorbar":
        self.shaded = on
        self._cube_val = None
        return self

    def decode(self, rgb: np.ndarray) -> np.ndarray:
        """Decode an RGB image (H, W, 3) uint8 to values; non-data pixels -> NaN."""
        q = np.asarray(rgb, dtype=np.uint8) >> CUBE_SHIFT
        return self._cube()[q[..., 0], q[..., 1], q[..., 2]]

    def encode(self, values: np.ndarray) -> np.ndarray:
        """Value -> LUT color (inverse mapping, used by tests and the web legend)."""
        v = np.clip(np.asarray(values, dtype=np.float32), self.values[0], self.values[-1])
        idx = np.abs(v[..., None] - self.values).argmin(-1)
        return self.colors[idx]

    def to_json(self, step: int = 1) -> dict:
        return {
            "units": self.units,
            "values": [round(float(v), 3) for v in self.values[::step]],
            "colors": ["#%02x%02x%02x" % tuple(int(c) for c in col) for col in self.colors[::step]],
        }
