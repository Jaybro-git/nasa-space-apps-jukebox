/** Location wording for narration and Explore mode. Basins are coarse lat/lon boxes. */

export function formatLat(lat: number): string {
  const a = Math.round(Math.abs(lat));
  return a === 0 ? "the equator" : `${a}° ${lat >= 0 ? "N" : "S"}`;
}

export function formatLon(lon: number): string {
  const a = Math.round(Math.abs(lon));
  return a === 0 || a === 180 ? `${a}°` : `${a}° ${lon >= 0 ? "E" : "W"}`;
}

/** Spoken form: "14 degrees north, 140 degrees west". */
export function spokenLatLon(lat: number, lon: number): string {
  const la = Math.round(Math.abs(lat));
  const lo = Math.round(Math.abs(lon));
  const ns = la === 0 ? "the equator" : `${la} degrees ${lat >= 0 ? "north" : "south"}`;
  const ew = lo === 0 || lo === 180 ? `${lo} degrees longitude` : `${lo} degrees ${lon >= 0 ? "east" : "west"}`;
  return `${ns}, ${ew}`;
}

/** Ocean basin name for an ocean point (approximate boxes, good enough for narration). */
export function oceanBasin(lat: number, lon: number): string {
  if (lat > 66) return "the Arctic Ocean";
  if (lat < -55) return "the Southern Ocean";
  if (lon >= 20 && lon < 120 && lat < 30) return "the Indian Ocean";
  if (lon >= -100 && lon < 20 && lat >= 8) return "the Atlantic";
  if (lon >= -70 && lon < 20 && lat < 8) return "the Atlantic";
  if (lon >= 120 || lon < -160) return "the western Pacific";
  if (lon >= 20 && lon < 120) return "Asian waters";
  return "the eastern Pacific";
}

export function placeName(lat: number | null | undefined, lon: number | null | undefined): string {
  if (lat == null || lon == null) return "somewhere on the map";
  return `in ${oceanBasin(lat, lon)} near ${formatLat(lat)}, ${formatLon(lon)}`;
}

/** Grid cell (i, j) on an equirectangular w x h grid -> cell-centre lat/lon. */
export function cellLatLon(i: number, j: number, w: number, h: number): { lat: number; lon: number } {
  return { lat: 90 - ((j + 0.5) / h) * 180, lon: -180 + ((i + 0.5) / w) * 360 };
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2007-05-14" -> "mid May 2007"; "2015" -> "2015". */
export function spokenDate(iso: string | undefined): string {
  if (!iso) return "";
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/.exec(iso);
  if (!m) return iso;
  const [, y, mo, d] = m;
  if (!mo) return y;
  const month = MONTHS[Number(mo) - 1];
  if (!d) return `${month} ${y}`;
  const day = Number(d);
  const part = day <= 10 ? "early" : day <= 20 ? "mid" : "late";
  return `${part} ${month} ${y}`;
}

/** Coarse continent / region boxes for land-dominated data (lightning). Approximate. */
const LAND_BOXES: { name: string; lat: [number, number]; lon: [number, number] }[] = [
  { name: "Central America and the Caribbean", lat: [7, 23], lon: [-95, -60] },
  { name: "North America", lat: [15, 72], lon: [-170, -50] },
  { name: "South America", lat: [-56, 13], lon: [-82, -34] },
  { name: "Europe", lat: [36, 72], lon: [-25, 45] },
  { name: "Africa", lat: [-36, 36], lon: [-20, 52] },
  { name: "the Maritime Continent", lat: [-11, 10], lon: [95, 155] },
  { name: "Australia", lat: [-45, -11], lon: [110, 155] },
  { name: "South Asia", lat: [5, 35], lon: [60, 95] },
  { name: "East Asia", lat: [10, 55], lon: [95, 145] },
  { name: "Asia", lat: [0, 72], lon: [45, 180] },
];

export function landRegion(lat: number, lon: number): string | null {
  for (const b of LAND_BOXES) if (lat >= b.lat[0] && lat <= b.lat[1] && lon >= b.lon[0] && lon <= b.lon[1]) return b.name;
  return null;
}

/** "over Africa near 5° N, 20° E" (falls back to the ocean basin). */
export function regionName(lat: number | null | undefined, lon: number | null | undefined): string {
  if (lat == null || lon == null) return "somewhere on the map";
  const land = landRegion(lat, lon);
  return `${land ? `over ${land}` : `over ${oceanBasin(lat, lon)}`} near ${formatLat(lat)}, ${formatLon(lon)}`;
}
