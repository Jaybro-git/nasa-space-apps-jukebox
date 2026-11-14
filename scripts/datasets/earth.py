"""Earth atlas — NASA Blue Marble Next Generation (Dec 2004, topography + bathymetry shading,
public domain) with Natural Earth 1:50m country borders (public domain).

Case: A STILL MAP FOR EXPLORING. No time axis. The probe hears land (a tone) versus ocean
(silence), a tick when it crosses a border, and the country name is spoken.

Outputs in public/data/earth/:
  earth.jpg       4096 x 2048 texture
  earth-hi.jpg    6144 x 3072 texture, loaded only when zoomed in past 3x
  borders.json    {lines: [[[lon, lat], ...], ...]} simplified country outlines
  countries.json  2048 x 1024 country raster (run-length encoded) + names + label points
  grid.json       1-degree land fraction (ocean = no data), for the Explore tools
  terrain.json    1-degree elevation / ocean depth in metres (NOAA ETOPO1, ice surface) and
                  an ice / glacier mask (white land in the Blue Marble, plus Antarctica), for
                  the Explore soundscape: surf, deep ocean, land, wind on mountains, glaciers
  meta.json, rules.json
"""

from __future__ import annotations

import json
import zipfile
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from lib.fetch import PUBLIC_DATA, RAW, download, log
from sources import EARTH

ID = "earth"
RW, RH = 2048, 1024  # country raster
GW, GH = 360, 180  # explore grid (1 degree)
SIMPLIFY_DEG = 0.08

Image.MAX_IMAGE_PIXELS = None  # the 21600 x 10800 source is a trusted NASA file


def rasterize(features: list[dict]) -> tuple[np.ndarray, list[str], list[dict]]:
    """Country index raster (0 = none, k = names[k-1]) plus label points."""
    img = np.zeros((RH, RW), np.uint16)
    names: list[str] = []
    labels: list[dict] = []
    # big countries first, small ones last, so enclaves (Lesotho, Vatican...) end up on top
    order = sorted(features, key=lambda f: float(f["properties"].get("LABELRANK") or 9))
    for f in order:
        p = f["properties"]
        name = p.get("NAME_EN") or p.get("NAME") or p.get("ADMIN")
        if not name:
            continue
        names.append(name)
        k = len(names)
        g = f["geometry"]
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        for poly in polys:
            rings = [np.array([[(lon + 180) / 360 * RW, (90 - lat) / 180 * RH] for lon, lat in ring], np.float32) for ring in poly]
            pts = [np.round(r).astype(np.int32) for r in rings]
            cv2.fillPoly(img, pts[:1], k)
            if len(pts) > 1:  # holes (lakes / enclaves): give them back
                cv2.fillPoly(img, pts[1:], 0)
        rank = int(p.get("LABELRANK") or 9)
        labels.append({"name": name, "lat": round(float(p.get("LABEL_Y") or 0), 2), "lon": round(float(p.get("LABEL_X") or 0), 2), "rank": 1 if rank <= 2 else 2 if rank <= 4 else 3})
    return img, names, labels


def rle(a: np.ndarray) -> list[int]:
    flat = a.ravel()
    change = np.flatnonzero(np.diff(flat)) + 1
    starts = np.concatenate([[0], change])
    ends = np.concatenate([change, [flat.size]])
    out: list[int] = []
    for s, e in zip(starts, ends):
        out += [int(flat[s]), int(e - s)]
    return out


def border_lines(features: list[dict]) -> list[list[list[float]]]:
    lines = []
    for f in features:
        g = f["geometry"]
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        for poly in polys:
            ring = np.array(poly[0], np.float32)
            if len(ring) < 4:
                continue
            simp = cv2.approxPolyDP(ring.reshape(-1, 1, 2), SIMPLIFY_DEG, True).reshape(-1, 2)
            if len(simp) < 3:
                continue
            pts = [[round(float(x), 2), round(float(y), 2)] for x, y in simp]
            lines.append(pts + [pts[0]])
    return lines


def terrain(etopo_zip: Path, blue_marble: Path) -> dict:
    """1-degree mean elevation (m, negative = ocean depth) and an ice mask (RLE of 0/1)."""
    tif = etopo_zip.with_suffix(".tif")
    if not tif.exists():
        with zipfile.ZipFile(etopo_zip) as z:
            z.extract(tif.name, tif.parent)
    z = cv2.imread(str(tif), cv2.IMREAD_UNCHANGED).astype(np.float32)  # int16 metres, 1 arc-minute
    elev = cv2.resize(z, (GW, GH), interpolation=cv2.INTER_AREA)
    # ice: bright, grey-white land in the cloud-free Blue Marble, plus all of Antarctica
    rgb = np.asarray(Image.open(blue_marble).convert("RGB").resize((GW, GH), Image.LANCZOS))
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV).astype(np.float32)
    white = (hsv[..., 2] > 180) & (hsv[..., 1] < 40)
    lat = 90 - (np.arange(GH) + 0.5) / GH * 180
    ice = ((white | (lat[:, None] < -62)) & (elev > 0)).astype(np.uint16)
    return {"w": GW, "h": GH, "elev": [int(round(v / 10) * 10) for v in elev.ravel()], "ice": rle(ice)}


def land_grid(countries: np.ndarray) -> list[int]:
    land = (countries > 0).astype(np.float32)
    frac = cv2.resize(land, (GW, GH), interpolation=cv2.INTER_AREA)
    q = np.round(frac * 254).astype(np.int32)
    q[frac < 0.2] = 255  # ocean = no data: silence in Explore
    return q.ravel().tolist()


def run() -> None:
    out = PUBLIC_DATA / ID
    out.mkdir(parents=True, exist_ok=True)
    lo = download(EARTH["blue_marble"], RAW / ID / "world.topo.200412.3x5400x2700.jpg")
    hi = download(EARTH["blue_marble_hi"], RAW / ID / "world.topo.200412.3x21600x10800.jpg")
    gj = download(EARTH["countries"], RAW / ID / "ne_50m_admin_0_countries.geojson")

    Image.open(lo).convert("RGB").resize((4096, 2048), Image.LANCZOS).save(out / "earth.jpg", quality=84, optimize=True, progressive=True)
    Image.open(hi).convert("RGB").resize((6144, 3072), Image.LANCZOS).save(out / "earth-hi.jpg", quality=78, optimize=True, progressive=True)
    Image.open(lo).convert("RGB").resize((1024, 512), Image.LANCZOS).save(out / "poster.jpg", quality=80)

    features = json.loads(Path(gj).read_text(encoding="utf-8"))["features"]
    countries, names, labels = rasterize(features)
    (out / "countries.json").write_text(json.dumps({"w": RW, "h": RH, "names": names, "labels": labels, "rle": rle(countries)}, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    (out / "borders.json").write_text(json.dumps({"lines": border_lines(features)}, separators=(",", ":")), encoding="utf-8")
    (out / "grid.json").write_text(json.dumps({"frames": [land_grid(countries)]}, separators=(",", ":")), encoding="utf-8")
    etopo = download(EARTH["etopo1"], RAW / ID / "ETOPO1_Ice_c_geotiff.zip")
    (out / "terrain.json").write_text(json.dumps(terrain(etopo, lo), separators=(",", ":")), encoding="utf-8")

    meta = {
        "id": ID,
        "title": "Earth: Countries (Blue Marble)",
        "svsId": 0,
        "svsUrl": EARTH["page"],
        "kind": "atlas",
        "kindLabel": "Still map: land, ocean and country borders",
        "sourceLabel": "NASA Blue Marble Next Generation",
        "description": "NASA's Blue Marble: a cloud-free picture of the whole Earth (December 2004) with country borders and a real cloud layer. Explore it by ear as a soundscape: surf on shallow seas, a deep rumble over the deep ocean, a warm tone on land that rises with height, wind on the mountains and icy shimmer on glaciers. A soft tick marks a border and the country's name is spoken.",
        "units": "",
        "range": [0, 1],
        "period": "December 2004 composite",
        "projection": "equirectangular",
        "aspect": 2.0,
        "video": {"src": "", "width": 4096, "height": 2048, "duration": 0, "fps": 0, "poster": f"/data/{ID}/poster.jpg"},
        "caveats": [
            "Borders are Natural Earth 1:50m: generalized, and some are disputed. They are shown for orientation only.",
            "Elevation and depth are 1-degree means of NOAA ETOPO1, so single peaks and trenches are smoothed.",
            "Ice is read from white land in the December Blue Marble (so it includes winter snow) plus Antarctica.",
            "Clouds are one real day (MODIS, 15 July 2024), shown for context; they do not affect the sound.",
        ],
        "grid": {"w": GW, "h": GH, "min": 0, "max": 1, "noData": 255, "label": "land fraction"},
        "still": {
            "image": f"/data/{ID}/earth.jpg",
            "imageHi": f"/data/{ID}/earth-hi.jpg",
            "borders": f"/data/{ID}/borders.json",
            "regions": f"/data/{ID}/countries.json",
            "regionWord": "country",
            "landMap": True,
            "terrain": f"/data/{ID}/terrain.json",
        },
    }
    (out / "meta.json").write_text(json.dumps(meta, indent=1, ensure_ascii=False), encoding="utf-8")
    rules = out / "rules.json"
    if not rules.exists():
        rules.write_text(json.dumps({
            "readouts": [],
            "legend": [
                {"text": "A tone means land. Silence means ocean.", "demo": {"target": "pitch", "from": 0.8, "to": 1}},
                {"text": "A soft tick means you crossed a border into another country.", "demo": {"target": "ticks", "from": 0, "to": 1}},
            ],
            "mappings": [],
            "narration": [],
            "explore": {"valueLabel": "", "decimals": 0, "noData": "ocean"},
        }, indent=2), encoding="utf-8")
    log(ID, "countries:", len(names), "border lines:", len(json.loads((out / "borders.json").read_text())["lines"]))
