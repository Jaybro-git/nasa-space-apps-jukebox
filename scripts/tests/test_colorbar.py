"""Colorbar decoder tests: pixel -> value round trip, tolerance, NaN rejection.

Uses the real SVS colorbar (sst_ecco2_cbar.png, 0..32 C) when it has been downloaded,
plus a synthetic bar so the tests also run on a clean checkout."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from lib.colorbar import Colorbar, find_bar_box

REAL_CBAR = Path(__file__).resolve().parents[2] / "data-raw" / "sst" / "sst_ecco2_cbar.png"


def synthetic_bar_image() -> np.ndarray:
    """White canvas, black frame, blue->cyan->green->yellow->red bar (like the SST bar)."""
    img = np.full((60, 300, 3), 255, np.uint8)
    stops = np.array([[40, 80, 255], [40, 230, 230], [60, 230, 80], [250, 250, 40], [250, 20, 20]], float)
    xs = np.linspace(0, len(stops) - 1, 260)
    lo = np.floor(xs).astype(int).clip(0, len(stops) - 2)
    t = (xs - lo)[:, None]
    row = ((1 - t) * stops[lo] + t * stops[lo + 1]).round().astype(np.uint8)
    img[18:42, 20:280] = 0  # border
    img[20:40, 20:280] = row[None, :, :]
    return img


@pytest.fixture(scope="module", params=["synthetic", "real"])
def cbar(request) -> Colorbar:
    if request.param == "real":
        if not REAL_CBAR.exists():
            pytest.skip("real colorbar not downloaded (run scripts/build_all.py)")
        return Colorbar.from_image(str(REAL_CBAR), 0.0, 32.0, units="°C")
    return Colorbar.from_rgb(synthetic_bar_image(), 0.0, 32.0, units="°C")


def test_bar_box_synthetic():
    x0, x1, y0, y1 = find_bar_box(synthetic_bar_image())
    assert (x0, x1) == (20, 280)
    assert 18 <= y0 <= 20 and 40 <= y1 <= 42


def test_values_monotonic_and_span(cbar: Colorbar):
    assert np.all(np.diff(cbar.values) > 0)
    lo = getattr(cbar, "spans", None)
    first, last = (lo[0][0], lo[-1][1]) if lo is not None else (cbar.values[0], cbar.values[-1])
    assert first == pytest.approx(0.0, abs=0.5)
    assert last == pytest.approx(32.0, abs=0.5)


def test_round_trip_exact(cbar: Colorbar):
    """Every LUT color decodes back to (nearly) its own value."""
    vals, dist = cbar.nearest(cbar.colors)
    # Neighbouring LUT columns can share a color; tolerate +-1 column of value.
    step = float(np.median(np.diff(cbar.values)))
    assert np.max(np.abs(vals - cbar.values)) <= 2 * step + 1e-6
    assert np.all(dist < 1e-3) or np.max(dist) < 0.5


def test_round_trip_cube_lookup(cbar: Colorbar):
    """Fast cube lookup agrees with exact search within 0.5 units."""
    img = cbar.colors[None, :, :]
    fast = cbar.decode(img)[0]
    assert np.all(np.isfinite(fast))
    err = np.abs(fast - cbar.values)
    assert np.median(err) < 0.1
    assert err.max() < 0.6  # 6-bit RGB cube, worst in the low-contrast yellow band


def test_raw_bar_columns_decode():
    """Every column of the real bar image decodes to its own position's value, except
    inside flat (saturated) runs where the error is bounded by half the run width."""
    if not REAL_CBAR.exists():
        pytest.skip("real colorbar not downloaded")
    import cv2

    rgb = cv2.cvtColor(cv2.imread(str(REAL_CBAR)), cv2.COLOR_BGR2RGB)
    cb = Colorbar.from_image(str(REAL_CBAR), 0.0, 32.0)
    x0, x1, y0, y1 = cb.bar_box
    row = rgb[(y0 + y1) // 2, x0 + 2 : x1 - 2]
    truth = 0.0 + (np.arange(x0 + 2, x1 - 2) + 0.5 - x0) / (x1 - x0) * 32.0
    got = cb.decode(row[None])[0]
    half_run = max((hi - lo) / 2 for lo, hi in cb.spans)
    assert np.all(np.isfinite(got))
    err = np.abs(got - truth)
    assert np.median(err) < 0.2
    assert err.max() < half_run + 0.6
    # the saturated red end is a documented limit, not a silent error
    assert half_run < 1.0


def test_encode_decode(cbar: Colorbar):
    targets = np.array([1.0, 5.0, 12.5, 20.0, 27.0, 31.0], np.float32)
    back = cbar.decode(cbar.encode(targets)[None])[0]
    np.testing.assert_allclose(back, targets, atol=0.5)


def test_noise_tolerance(cbar: Colorbar):
    """+-3 RGB jitter (compression noise) moves decoded values by < 1 unit."""
    rng = np.random.default_rng(0)
    noisy = (cbar.colors.astype(int) + rng.integers(-3, 4, cbar.colors.shape)).clip(0, 255).astype(np.uint8)
    fast = cbar.decode(noisy[None])[0]
    ok = np.isfinite(fast)
    assert ok.mean() > 0.95
    assert np.median(np.abs(fast[ok] - cbar.values[ok])) < 0.5
    assert np.max(np.abs(fast[ok] - cbar.values[ok])) < 2.0


@pytest.mark.parametrize("rgb", [(0, 0, 0), (255, 255, 255), (128, 128, 128), (200, 200, 200), (90, 60, 40)])
def test_non_data_colors_rejected(cbar: Colorbar, rgb):
    """Land / background / text colors are far from the bar -> NaN."""
    px = np.array([[rgb]], np.uint8)
    assert np.isnan(cbar.decode(px)[0, 0])
