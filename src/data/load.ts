import type { Atlas, Dataset, DatasetMeta, Features, GridData, Rules, Terrain } from "./types";

export interface IndexEntry {
  id: string;
  title: string;
  kind: DatasetMeta["kind"];
  kindLabel: string;
  svsId: number;
  period: string;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return (await res.json()) as T;
}

export const loadIndex = () => getJson<{ datasets: IndexEntry[] }>("/data/index.json").then((d) => d.datasets);

/** countries.json written by scripts/datasets/earth.py */
export interface CountriesFile {
  w: number;
  h: number;
  names: string[];
  labels: Atlas["labels"];
  /** run-length encoded raster, row-major from 90 N / 180 W: [value, count, value, count, ...]; value 0 = none, k = names[k - 1] */
  rle: number[];
}

/** Decode the country raster once and return an O(1) lookup. */
export function countryLookup(c: CountriesFile): (lat: number, lon: number) => string | null {
  const cells = new Uint16Array(c.w * c.h);
  let k = 0;
  for (let r = 0; r < c.rle.length; r += 2) {
    cells.fill(c.rle[r], k, k + c.rle[r + 1]);
    k += c.rle[r + 1];
  }
  return (lat, lon) => {
    const i = Math.min(c.w - 1, Math.max(0, Math.floor((((((lon + 180) % 360) + 360) % 360) / 360) * c.w)));
    const j = Math.min(c.h - 1, Math.max(0, Math.floor(((90 - lat) / 180) * c.h)));
    const v = cells[j * c.w + i];
    return v ? c.names[v - 1] ?? null : null;
  };
}

/** terrain.json written by scripts/datasets/earth.py */
export interface TerrainFile {
  w: number;
  h: number;
  /** metres, row-major from 90 N / 180 W; negative = ocean depth */
  elev: number[];
  /** run-length encoded 0/1 ice mask, same layout */
  ice: number[];
}

/** Decode the terrain grid once and return an O(1) lookup. */
export function terrainLookup(t: TerrainFile): (lat: number, lon: number) => Terrain {
  const ice = new Uint8Array(t.w * t.h);
  let k = 0;
  for (let r = 0; r < t.ice.length; r += 2) {
    ice.fill(t.ice[r], k, k + t.ice[r + 1]);
    k += t.ice[r + 1];
  }
  return (lat, lon) => {
    const i = Math.min(t.w - 1, Math.max(0, Math.floor((((((lon + 180) % 360) + 360) % 360) / 360) * t.w)));
    const j = Math.min(t.h - 1, Math.max(0, Math.floor(((90 - lat) / 180) * t.h)));
    return { elev: t.elev[j * t.w + i], ice: ice[j * t.w + i] === 1 };
  };
}

const cache = new Map<string, Promise<Dataset>>();

export function loadDataset(id: string): Promise<Dataset> {
  if (!cache.has(id)) {
    const base = `/data/${id}`;
    cache.set(
      id,
      getJson<DatasetMeta>(`${base}/meta.json`).then(async (meta) => {
        const st = meta.still;
        if (st) {
          // a single still image: no features over time, plus outlines and a region lookup
          const [grid, rules, borders, regions, terrain] = await Promise.all([
            getJson<GridData>(`${base}/grid.json`),
            getJson<Rules>(`${base}/rules.json`),
            st.borders ? getJson<{ lines: number[][][] }>(st.borders) : null,
            st.regions ? getJson<CountriesFile>(st.regions) : null,
            st.terrain ? getJson<TerrainFile>(st.terrain) : null,
          ]);
          const atlas: Atlas = {
            image: st.image,
            imageHi: st.imageHi,
            borders: borders?.lines ?? null,
            labels: regions?.labels?.length ? regions.labels : null,
            regionAt: regions ? countryLookup(regions) : () => null,
            regionWord: st.regionWord,
            landMap: !!st.landMap,
            terrainAt: terrain ? terrainLookup(terrain) : null,
          };
          return { meta, features: { frames: [{ t: 0 }] }, grid, rules, atlas };
        }
        const [features, grid, rules] = await Promise.all([getJson<Features>(`${base}/features.json`), getJson<GridData>(`${base}/grid.json`), getJson<Rules>(`${base}/rules.json`)]);
        return { meta, features, grid, rules };
      }),
    );
  }
  return cache.get(id)!;
}

/** Value of one Explore grid cell in real units; null = no data. */
export function gridValue(ds: Dataset, frameIdx: number, i: number, j: number): number | null {
  const { w, min, max, noData } = ds.meta.grid;
  const frame = ds.grid.frames[Math.max(0, Math.min(ds.grid.frames.length - 1, frameIdx))];
  const q = frame?.[j * w + i];
  if (q == null || q === noData) return null;
  return min + (q / 254) * (max - min);
}
