// Pre-record the voice guide's fixed texts with Fish Audio (build time only: the API key
// never reaches the browser). Reads FISH_API_KEY (and optional FISH_VOICE_ID) from
// .env.local (FISH_MODEL optional, default: the free model), the texts from src/voice/script.json, and writes public/voice/*.mp3 plus
// public/voice/manifest.json. Unchanged texts are skipped.
//
//   node scripts/voice.mjs            generate / update clips
//   node scripts/voice.mjs --list     list candidate English voices and exit
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "voice");
const API = "https://api.fish.audio";

function env() {
  const out = { ...process.env };
  const f = join(ROOT, ".env.local");
  if (existsSync(f))
    for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !out[m[1]]) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  return out;
}

const { FISH_API_KEY: KEY, FISH_VOICE_ID, FISH_MODEL } = env();
// the free text-to-speech model (no API credit needed); set FISH_MODEL to use a paid one
const MODEL = FISH_MODEL || "s2.1-pro-free";
if (!KEY) {
  console.error("FISH_API_KEY missing: put it in .env.local (never commit it).");
  process.exit(1);
}
const auth = { Authorization: `Bearer ${KEY}` };

/** Public English voices, best rated first. */
async function voices() {
  const r = await fetch(`${API}/model?page_size=40&language=en&sort_by=score`, { headers: auth });
  if (!r.ok) throw new Error(`model list: ${r.status} ${await r.text()}`);
  const { items } = await r.json();
  return items.map((m) => ({ id: m._id, title: m.title, tags: m.tags ?? [], desc: (m.description ?? "").slice(0, 80) }));
}

/** A calm narrator: prefer narration / audiobook / calm / documentary tags or titles. */
function pickVoice(list) {
  const score = (v) => {
    const t = `${v.title} ${v.tags.join(" ")} ${v.desc}`.toLowerCase();
    let s = 0;
    for (const [w, p] of [["narrat", 5], ["documentary", 4], ["audiobook", 4], ["calm", 3], ["soft", 2], ["warm", 2], ["professional", 1]]) if (t.includes(w)) s += p;
    for (const w of ["anime", "meme", "trump", "cartoon", "villain", "asmr", "sexy"]) if (t.includes(w)) s -= 10;
    return s;
  };
  return [...list].sort((a, b) => score(b) - score(a))[0];
}

function segments(text) {
  const parts = text.split(/\{tone:(low|high)\}/);
  const out = [];
  for (let k = 0; k < parts.length; k += 2) out.push(parts[k].trim());
  return out;
}

async function tts(text, voice) {
  const r = await fetch(`${API}/v1/tts`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json", model: MODEL },
    body: JSON.stringify({ text, reference_id: voice, format: "mp3", mp3_bitrate: 64, normalize: true, latency: "normal" }),
  });
  if (!r.ok) throw new Error(`tts: ${r.status} ${await r.text()}`);
  return Buffer.from(await r.arrayBuffer());
}

if (process.argv.includes("--list")) {
  for (const v of await voices()) console.log(v.id, "|", v.title, "|", v.tags.join(","), "|", v.desc);
  process.exit(0);
}

mkdirSync(OUT, { recursive: true });
const script = JSON.parse(readFileSync(join(ROOT, "src", "voice", "script.json"), "utf8"));
const manifestPath = join(OUT, "manifest.json");
const old = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : { clips: {} };
let voice = FISH_VOICE_ID || old.voice;
if (!voice) {
  const v = pickVoice(await voices());
  voice = v.id;
  console.log(`voice: ${v.title} (${v.id})`);
}
const manifest = { voice, model: MODEL, clips: {} };
for (const [id, text] of Object.entries(script)) {
  const segs = segments(text);
  for (let k = 0; k < segs.length; k++) {
    if (!segs[k]) continue;
    const key = `${id}#${k}`;
    const hash = createHash("sha1").update(`${voice}|${MODEL}|64|${segs[k]}`).digest("hex").slice(0, 12);
    const file = `/voice/${id}-${k}.mp3`;
    if (old.clips?.[key]?.hash === hash && existsSync(join(ROOT, "public", file))) {
      manifest.clips[key] = old.clips[key];
      continue;
    }
    process.stdout.write(`${key} … `);
    writeFileSync(join(ROOT, "public", file), await tts(segs[k], voice));
    manifest.clips[key] = { file, hash };
    console.log("ok");
  }
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
console.log(`${Object.keys(manifest.clips).length} clips in public/voice/manifest.json`);
