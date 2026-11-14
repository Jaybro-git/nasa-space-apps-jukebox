"""Still-map helpers: country raster + run-length encoding (earth.py) and the aerosol
colour classifier (aerosols.py). Synthetic inputs, so they run on a clean checkout."""

from __future__ import annotations

import cv2
import numpy as np

from datasets import aerosols, earth


def square(name: str, lon0: float, lat0: float, lon1: float, lat1: float, rank: int = 1) -> dict:
    ring = [[lon0, lat0], [lon1, lat0], [lon1, lat1], [lon0, lat1], [lon0, lat0]]
    return {"properties": {"NAME_EN": name, "LABELRANK": rank, "LABEL_X": (lon0 + lon1) / 2, "LABEL_Y": (lat0 + lat1) / 2}, "geometry": {"type": "Polygon", "coordinates": [ring]}}


def lookup(img: np.ndarray, names: list[str], lat: float, lon: float) -> str | None:
    i = int((lon + 180) / 360 * img.shape[1])
    j = int((90 - lat) / 180 * img.shape[0])
    v = int(img[j, i])
    return names[v - 1] if v else None


def test_rasterize_and_enclave_on_top():
    big = square("Bigland", -20, -20, 20, 20, rank=1)
    small = square("Smallia", -2, -2, 2, 2, rank=6)  # an enclave: drawn after the big one
    img, names, labels = earth.rasterize([small, big])
    assert lookup(img, names, 10, 10) == "Bigland"
    assert lookup(img, names, 0, 0) == "Smallia"
    assert lookup(img, names, 50, 50) is None
    assert {lb["name"]: lb["rank"] for lb in labels} == {"Bigland": 1, "Smallia": 3}


def test_rle_round_trip():
    a = np.array([[0, 0, 1, 1, 1], [2, 2, 0, 0, 0]], np.uint16)
    r = earth.rle(a)
    assert r == [0, 2, 1, 3, 2, 2, 0, 3]
    flat = np.concatenate([np.full(r[k + 1], r[k]) for k in range(0, len(r), 2)])
    assert (flat.reshape(a.shape) == a).all()


def test_land_grid_marks_ocean_as_no_data():
    countries = np.zeros((earth.RH, earth.RW), np.uint16)
    countries[:, : earth.RW // 2] = 1  # western hemisphere is land
    g = np.array(earth.land_grid(countries)).reshape(earth.GH, earth.GW)
    assert (g[:, : earth.GW // 2 - 1] == 254).all()
    assert (g[:, earth.GW // 2 + 1 :] == 255).all()


def test_aerosol_classes_by_colour():
    # one swatch per legend colour (Aerosols_cbar.png), plus grey land and dark ocean
    rgb = {
        1: (210, 96, 74),  # black carbon
        2: (195, 156, 219),  # dust
        3: (134, 170, 168),  # sea salt
        4: (83, 220, 53),  # sulfate
        0: (110, 110, 110),  # land
        -1: (15, 25, 35),  # ocean
    }
    img = np.zeros((1, len(rgb), 3), np.uint8)
    for k, c in enumerate(rgb.values()):
        img[0, k] = c
    t, s = aerosols.classify(cv2.cvtColor(img, cv2.COLOR_RGB2BGR))
    assert list(t[0]) == [1, 2, 3, 4, 0, 0]
    assert (s[0, :4] > 0.3).all() and (s[0, 4:] == 0).all()
