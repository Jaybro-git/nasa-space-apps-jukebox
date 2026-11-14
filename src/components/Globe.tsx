"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";

export type LatLon = { lat: number; lon: number };

/** What the Explore tools draw on the globe. */
export type Overlay =
  | { kind: "hline"; lat: number }
  | { kind: "vline"; lon: number }
  | { kind: "box"; lat0: number; lat1: number; lon0: number; lon1: number };

export interface Label {
  name: string;
  lat: number;
  lon: number;
  /** bigger countries show first */
  rank: number;
}

interface Props {
  video: HTMLVideoElement | null;
  /** static texture (Earth atlas) instead of the video */
  image?: string | null;
  /** sharper texture, loaded once zoomed in past 3x */
  imageHi?: string | null;
  /** country borders: polylines of [lon, lat] */
  borders?: number[][][] | null;
  labels?: Label[] | null;
  /** real cloud map (greyscale alpha) drifting just above the surface */
  clouds?: string | null;
  playing: boolean;
  /** Explore probe */
  probe: LatLon | null;
  /** turn the globe so the probe faces you (keyboard moves) */
  follow: boolean;
  overlay: Overlay | null;
  /** 0..1 progress of a sweep along the overlay, null = none */
  playhead: number | null;
  zoom: number;
  onZoom: (z: number) => void;
  /** pointer picking (Explore): hover / press / release on the sphere */
  onPick?: (ll: LatLon, kind: "move" | "down" | "up") => void;
  /** drag-rotation off (e.g. while drawing a box) */
  lockDrag?: boolean;
  onMeridian?: (lon: number) => void;
  label: string;
  theme: "light" | "dark";
}

const DEG = Math.PI / 180;
export const ZOOM_MIN = 1;
export const ZOOM_MAX = 8;
const wrap = (l: number) => ((((l + 180) % 360) + 360) % 360) - 180;
const fmtLon = (l: number) => `${Math.abs(Math.round(wrap(l)))}°${wrap(l) >= 0 ? "E" : "W"}`;
const clampZoom = (z: number) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));

/** Point on the unit sphere for three.js' default SphereGeometry UVs (equirect, u=0 at 180 W). */
function lonLatToVec(lat: number, lon: number, r = 1): THREE.Vector3 {
  const phi = ((lon + 180) / 360) * Math.PI * 2;
  const theta = (90 - lat) * DEG;
  return new THREE.Vector3(-Math.cos(phi) * Math.sin(theta) * r, Math.cos(theta) * r, Math.sin(phi) * Math.sin(theta) * r);
}

function vecToLatLon(v: THREE.Vector3): LatLon {
  const n = v.clone().normalize();
  const lat = 90 - Math.acos(Math.max(-1, Math.min(1, n.y))) / DEG;
  let phi = Math.atan2(n.z, -n.x);
  if (phi < 0) phi += Math.PI * 2;
  return { lat, lon: wrap((phi / (Math.PI * 2)) * 360 - 180) };
}

/** Points along an overlay, for the line geometry and the playhead. */
function overlayPath(o: Overlay): THREE.Vector3[] {
  const r = 1.006;
  const pts: THREE.Vector3[] = [];
  if (o.kind === "hline") for (let lo = -180; lo <= 180; lo += 2) pts.push(lonLatToVec(o.lat, lo, r));
  else if (o.kind === "vline") for (let la = 90; la >= -90; la -= 2) pts.push(lonLatToVec(la, o.lon, r));
  else {
    const { lat0, lat1, lon0, lon1 } = o;
    const seg = (a: LatLon, b: LatLon) => {
      for (let k = 0; k <= 12; k++) pts.push(lonLatToVec(a.lat + ((b.lat - a.lat) * k) / 12, a.lon + ((b.lon - a.lon) * k) / 12, r));
    };
    seg({ lat: lat0, lon: lon0 }, { lat: lat0, lon: lon1 });
    seg({ lat: lat0, lon: lon1 }, { lat: lat1, lon: lon1 });
    seg({ lat: lat1, lon: lon1 }, { lat: lat1, lon: lon0 });
    seg({ lat: lat1, lon: lon0 }, { lat: lat0, lon: lon0 });
  }
  return pts;
}

/** Where the playhead is: along the line, or a meridian sweeping across the box. */
function playheadPoint(o: Overlay, u: number): LatLon {
  if (o.kind === "hline") return { lat: o.lat, lon: -180 + 360 * u };
  if (o.kind === "vline") return { lat: 90 - 180 * u, lon: o.lon };
  return { lat: (o.lat0 + o.lat1) / 2, lon: o.lon0 + (o.lon1 - o.lon0) * u };
}

const cssVar = (name: string, fallback: string) => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
};

export function Globe(props: Props) {
  const { label } = props;
  const wrapRef = useRef<HTMLDivElement>(null);
  const glRef = useRef<HTMLCanvasElement>(null);
  const bgRef = useRef<HTMLCanvasElement>(null);
  const state = useRef({ q: new THREE.Quaternion(), dragging: false, moved: false, lastX: 0, lastY: 0, lon: 20 });
  const live = useRef(props);
  live.current = props;

  useEffect(() => {
    const wrapEl = wrapRef.current!;
    const canvas = glRef.current!;
    const bg = bgRef.current!;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(2, devicePixelRatio));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    camera.position.set(0, 0, 5);

    const spin = new THREE.Group();
    scene.add(spin);
    // Orientation facing (lat, lon): tilt about screen X after turning lon to the front.
    const facing = (lat: number, lon: number) => {
      const phi = ((lon + 180) / 360) * Math.PI * 2;
      const qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2 - phi);
      const qx = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), lat * DEG);
      return qx.multiply(qy);
    };
    state.current.q.copy(facing(20, 20));
    const view = new THREE.Vector3();
    const inv = new THREE.Quaternion();
    const axisY = new THREE.Vector3(0, 1, 0);

    const material = new THREE.MeshBasicMaterial({ color: 0x2a2724 });
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 64), material);
    spin.add(sphere);

    // Graticule: every 15 degrees, plus a finer 5-degree one that fades in when zoomed.
    const graticule = (step: number, opacity: number) => {
      const pts: THREE.Vector3[] = [];
      for (let la = -90 + step; la < 90; la += step)
        for (let lo = -180; lo < 180; lo += 2) pts.push(lonLatToVec(la, lo, 1.003), lonLatToVec(la, lo + 2, 1.003));
      for (let lo = -180; lo < 180; lo += step)
        for (let la = -90; la < 90; la += 2) pts.push(lonLatToVec(la, lo, 1.003), lonLatToVec(la + 2, lo, 1.003));
      return new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xf2e6d6, transparent: true, opacity }));
    };
    const grat = graticule(15, 0.16);
    const fine = graticule(5, 0);
    spin.add(grat, fine);

    const marker = new THREE.Mesh(new THREE.SphereGeometry(0.03, 16, 12), new THREE.MeshBasicMaterial({ color: 0xe85d04 }));
    marker.visible = false;
    spin.add(marker);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.025, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    head.visible = false;
    spin.add(head);

    // real clouds (NASA MODIS, one day): a slightly larger sphere using the map as alpha
    const cloudMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthWrite: false });
    const cloudMesh = new THREE.Mesh(new THREE.SphereGeometry(1.012, 96, 48), cloudMat);
    cloudMesh.visible = false;
    spin.add(cloudMesh);
    let cloudKey: string | null = null;

    let overlayLine: THREE.Line | null = null;
    let overlayKey = "";
    let bordersObj: THREE.LineSegments | null = null;
    let bordersRef: Props["borders"] = null;

    let texture: THREE.Texture | null = null;
    let texKey: unknown = null;
    let hiLoaded = false;
    const loader = new THREE.TextureLoader();
    let R = 100;
    let cx = 0;
    let cy = 0;
    let w = 0;
    let h = 0;
    let oy = 0;
    let zoomNow = live.current.zoom;
    let ink = "17,17,17";
    let themeKey = "";

    const resize = () => {
      w = wrapEl.clientWidth;
      h = wrapEl.clientHeight;
      R = Math.max(40, Math.min(w, h) / 2 / 1.32);
      cx = w / 2;
      cy = h / 2 - 8;
      renderer.setSize(w, h, false);
      const hw = w / 2 / R;
      const hh = h / 2 / R;
      // shift so the sphere centre sits at (cx, cy)
      oy = (cy - h / 2) / R;
      camera.left = -hw;
      camera.right = hw;
      camera.top = hh + oy;
      camera.bottom = -hh + oy;
      camera.updateProjectionMatrix();
      const dpr = Math.min(2, devicePixelRatio);
      bg.width = w * dpr;
      bg.height = h * dpr;
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrapEl);
    resize();

    /** globe-local point -> screen px (after rotation and zoom); null if on the far side */
    const tmp = new THREE.Vector3();
    const project = (ll: LatLon): { x: number; y: number } | null => {
      tmp.copy(lonLatToVec(ll.lat, ll.lon)).applyQuaternion(state.current.q);
      if (tmp.z < 0.05) return null;
      return { x: w / 2 + tmp.x * R * zoomNow, y: h / 2 + (oy - tmp.y) * R * zoomNow };
    };

    const drawBg = () => {
      const x = bg.getContext("2d")!;
      const dpr = Math.min(2, devicePixelRatio);
      x.setTransform(dpr, 0, 0, dpr, 0, 0);
      x.clearRect(0, 0, w, h);
      const L = ink;
      const Rz = R * zoomNow;
      const deco = Math.max(0, 1 - (zoomNow - 1) * 4); // decorations fade out as you zoom in
      if (deco > 0) {
        x.globalAlpha = deco;
        // perspective floor
        const hy = cy + R * 1.08;
        x.strokeStyle = `rgba(${L},0.07)`;
        x.lineWidth = 1;
        x.beginPath();
        for (let i = -14; i <= 14; i++) {
          x.moveTo(cx + i * R * 0.1, hy);
          x.lineTo(cx + i * R * 0.7, h);
        }
        for (let j = 0; j < 8; j++) {
          const yy = hy + (h - hy) * Math.pow(j / 7, 1.8);
          x.moveTo(0, yy);
          x.lineTo(w, yy);
        }
        x.stroke();
        // crosshair + orbit
        x.setLineDash([3, 6]);
        x.strokeStyle = `rgba(${L},0.08)`;
        x.beginPath();
        x.moveTo(0, cy);
        x.lineTo(w, cy);
        x.moveTo(cx, 0);
        x.lineTo(cx, h);
        x.stroke();
        x.setLineDash([]);
        // degree ring
        const rr = R * 1.16;
        x.strokeStyle = `rgba(${L},0.28)`;
        x.fillStyle = `rgba(${L},0.55)`;
        x.font = "600 10px Manrope, sans-serif";
        x.textAlign = "center";
        x.textBaseline = "middle";
        x.beginPath();
        x.arc(cx, cy, rr, 0, 6.283);
        for (let d = 0; d < 360; d += 5) {
          const a = d * DEG - Math.PI / 2;
          const len = d % 30 === 0 ? 9 : 4;
          x.moveTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
          x.lineTo(cx + Math.cos(a) * (rr + len), cy + Math.sin(a) * (rr + len));
        }
        x.stroke();
        for (let d = 0; d < 360; d += 30) {
          const a = d * DEG - Math.PI / 2;
          x.fillText(`${d}°`, cx + Math.cos(a) * (rr + 22), cy + Math.sin(a) * (rr + 22));
        }
        x.fillStyle = `rgba(${L},0.65)`;
        x.fillText(`MERIDIAN · λ ${fmtLon(state.current.lon)}`, cx, cy + rr + 40);
        x.globalAlpha = 1;
      }
      // rim
      x.lineWidth = 1.4;
      x.strokeStyle = "rgba(220,95,0,0.75)";
      x.beginPath();
      x.arc(cx, h / 2 + (cy - h / 2) * zoomNow, Rz, 0, 6.283);
      x.stroke();
    };

    const needle = document.createElement("canvas");
    needle.className = "globe-needle";
    wrapEl.appendChild(needle);

    const drawTop = (isPlaying: boolean) => {
      const dpr = Math.min(2, devicePixelRatio);
      needle.width = w * dpr;
      needle.height = h * dpr;
      const n = needle.getContext("2d")!;
      n.setTransform(dpr, 0, 0, dpr, 0, 0);
      const s = state.current;
      const { labels, overlay, probe } = live.current;
      // meridian needle (hidden while exploring or zoomed in)
      if (!overlay && !probe && zoomNow < 1.5) {
        n.save();
        n.shadowColor = "rgba(220,95,0,0.9)";
        n.shadowBlur = isPlaying ? 14 : 4;
        n.strokeStyle = `rgba(220,95,0,${isPlaying ? 1 : 0.7})`;
        n.lineWidth = isPlaying ? 2 : 1.2;
        n.beginPath();
        let pen = false;
        for (let la = -90; la <= 90; la += 3) {
          const p = project({ lat: la, lon: s.lon });
          if (!p) {
            pen = false;
            continue;
          }
          if (pen) n.lineTo(p.x, p.y);
          else n.moveTo(p.x, p.y);
          pen = true;
        }
        n.stroke();
        n.restore();
      }
      // country names once zoomed in; more appear the further you zoom
      if (labels && zoomNow >= 2.5) {
        const maxRank = zoomNow < 3.5 ? 1 : zoomNow < 5 ? 2 : 3;
        n.font = `600 ${Math.round(10 + zoomNow)}px Manrope, sans-serif`;
        n.textAlign = "center";
        n.textBaseline = "middle";
        n.lineWidth = 3;
        n.strokeStyle = "rgba(0,0,0,0.7)";
        n.fillStyle = "#fff";
        for (const lb of labels) {
          if (lb.rank > maxRank) continue;
          const p = project(lb);
          if (!p || p.x < 0 || p.y < 0 || p.x > w || p.y > h) continue;
          n.strokeText(lb.name, p.x, p.y);
          n.fillText(lb.name, p.x, p.y);
        }
      }
    };

    let raf = 0;
    let last = performance.now();
    const frame = (ts: number) => {
      const dt = Math.min(0.05, (ts - last) / 1000);
      last = ts;
      const s = state.current;
      const p = live.current;
      const { playing: isPlaying, probe: pr, video: vid, image, imageHi } = p;

      // theme colours (read once per theme change)
      if (p.theme !== themeKey) {
        themeKey = p.theme;
        ink = cssVar("--globe-ink", "17,17,17");
      }

      // texture: static atlas image or the video
      const key = image ?? vid;
      if (key !== texKey) {
        texture?.dispose();
        texture = null;
        hiLoaded = false;
        texKey = key;
        if (image) {
          loader.load(image, (t) => {
            if (texKey !== image) return t.dispose();
            t.colorSpace = THREE.SRGBColorSpace;
            t.anisotropy = renderer.capabilities.getMaxAnisotropy();
            texture?.dispose();
            texture = t;
            material.map = t;
            material.color.set(0xffffff);
            material.needsUpdate = true;
          });
        } else if (vid) {
          texture = new THREE.VideoTexture(vid);
          texture.colorSpace = THREE.SRGBColorSpace;
        }
        material.map = texture;
        material.color.set(texture ? 0xffffff : 0x2a2724);
        material.needsUpdate = true;
      }
      if (image && imageHi && !hiLoaded && zoomNow > 3) {
        hiLoaded = true;
        loader.load(imageHi, (t) => {
          if (texKey !== image) return t.dispose();
          t.colorSpace = THREE.SRGBColorSpace;
          t.anisotropy = renderer.capabilities.getMaxAnisotropy();
          texture?.dispose();
          texture = t;
          material.map = t;
          material.needsUpdate = true;
        });
      }

      // clouds: load once per URL, then drift slowly eastward (about 1 degree every 2 s)
      if ((p.clouds ?? null) !== cloudKey) {
        cloudKey = p.clouds ?? null;
        cloudMat.alphaMap?.dispose();
        cloudMat.alphaMap = null;
        cloudMesh.visible = false;
        if (cloudKey)
          loader.load(cloudKey, (t) => {
            if (cloudKey !== p.clouds) return t.dispose();
            cloudMat.alphaMap = t;
            cloudMat.needsUpdate = true;
            cloudMesh.visible = true;
          });
      }
      if (cloudMesh.visible && !reduce) cloudMesh.rotation.y += dt * 0.009;

      // country borders
      if (p.borders !== bordersRef) {
        bordersRef = p.borders;
        if (bordersObj) {
          spin.remove(bordersObj);
          bordersObj.geometry.dispose();
          bordersObj = null;
        }
        if (p.borders) {
          const pts: THREE.Vector3[] = [];
          for (const line of p.borders) for (let k = 1; k < line.length; k++) pts.push(lonLatToVec(line[k - 1][1], line[k - 1][0], 1.002), lonLatToVec(line[k][1], line[k][0], 1.002));
          bordersObj = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 }));
          spin.add(bordersObj);
        }
      }

      // explore overlay (line / box) + playhead
      const ok = p.overlay ? JSON.stringify(p.overlay) : "";
      if (ok !== overlayKey) {
        overlayKey = ok;
        if (overlayLine) {
          spin.remove(overlayLine);
          overlayLine.geometry.dispose();
          overlayLine = null;
        }
        if (p.overlay) {
          overlayLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(overlayPath(p.overlay)), new THREE.LineBasicMaterial({ color: 0xe85d04 }));
          spin.add(overlayLine);
        }
      }
      if (p.overlay && p.playhead != null) {
        const ll = playheadPoint(p.overlay, p.playhead);
        head.position.copy(lonLatToVec(ll.lat, ll.lon, 1.012));
        head.visible = true;
      } else head.visible = false;

      // zoom (eased)
      const zt = clampZoom(p.zoom);
      zoomNow += (zt - zoomNow) * Math.min(1, dt * 10);
      if (Math.abs(zt - zoomNow) < 0.001) zoomNow = zt;
      camera.zoom = zoomNow;
      camera.updateProjectionMatrix();
      (fine.material as THREE.LineBasicMaterial).opacity = Math.max(0, Math.min(0.14, (zoomNow - 2.5) * 0.12));
      head.scale.setScalar(1 / zoomNow);
      (grat.material as THREE.LineBasicMaterial).opacity = p.borders ? 0.08 : 0.16;

      if (pr) {
        marker.visible = true;
        marker.position.copy(lonLatToVec(pr.lat, pr.lon, 1.01));
        marker.scale.setScalar(1 / zoomNow);
        // keyboard Explore: turn the globe so the probe faces you
        if (p.follow) s.q.slerp(facing(pr.lat, pr.lon), Math.min(1, dt * 4));
      } else {
        marker.visible = false;
      }
      // gentle spin around Earth's axis only when idle, unzoomed and not exploring
      if (!pr && !s.dragging && !reduce && zoomNow < 1.05 && !p.overlay) s.q.multiply(new THREE.Quaternion().setFromAxisAngle(axisY, (isPlaying ? 12 : 2.5) * dt * DEG));
      spin.quaternion.copy(s.q);
      // longitude facing the viewer = view direction in globe coordinates
      inv.copy(s.q).invert();
      view.set(0, 0, 1).applyQuaternion(inv);
      s.lon = wrap((Math.atan2(view.z, -view.x) / Math.PI) * 180 - 180);
      renderer.render(scene, camera);
      drawBg();
      drawTop(isPlaying);

      p.onMeridian?.(wrap(s.lon));
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    // ---- picking ----
    const ray = new THREE.Raycaster();
    const pick = (e: PointerEvent): LatLon | null => {
      const r = wrapEl.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      const hit = ray.intersectObject(sphere, false)[0];
      if (!hit) return null;
      return vecToLatLon(hit.point.clone().applyQuaternion(state.current.q.clone().invert()));
    };

    // ---- drag to rotate, pinch / wheel to zoom ----
    const pointers = new Map<number, { x: number; y: number }>();
    let pinch = 0;
    const down = (e: PointerEvent) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = Math.hypot(a.x - b.x, a.y - b.y);
      }
      const s = state.current;
      s.dragging = true;
      s.moved = false;
      s.lastX = e.clientX;
      s.lastY = e.clientY;
      wrapEl.setPointerCapture(e.pointerId);
      const ll = pick(e);
      if (ll) live.current.onPick?.(ll, "down");
    };
    const move = (e: PointerEvent) => {
      const s = state.current;
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2 && pinch > 0) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        live.current.onZoom(clampZoom(live.current.zoom * (d / pinch)));
        pinch = d;
        return;
      }
      const ll = pick(e);
      if (ll) live.current.onPick?.(ll, "move");
      if (!s.dragging || live.current.lockDrag) return;
      const dx = e.clientX - s.lastX;
      const dy = e.clientY - s.lastY;
      s.lastX = e.clientX;
      s.lastY = e.clientY;
      const len = Math.hypot(dx, dy);
      if (!len) return;
      s.moved = true;
      // trackball: rotate about the screen axis perpendicular to the drag (slower when zoomed)
      const axis = new THREE.Vector3(dy / len, dx / len, 0);
      s.q.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, len / (R * zoomNow)));
    };
    const up = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = 0;
      state.current.dragging = false;
      const ll = pick(e);
      if (ll) live.current.onPick?.(ll, "up");
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      live.current.onZoom(clampZoom(live.current.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    };
    wrapEl.addEventListener("pointerdown", down);
    wrapEl.addEventListener("pointermove", move);
    wrapEl.addEventListener("pointerup", up);
    wrapEl.addEventListener("pointercancel", up);
    wrapEl.addEventListener("wheel", wheel, { passive: false });

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      wrapEl.removeEventListener("pointerdown", down);
      wrapEl.removeEventListener("pointermove", move);
      wrapEl.removeEventListener("pointerup", up);
      wrapEl.removeEventListener("pointercancel", up);
      wrapEl.removeEventListener("wheel", wheel);
      needle.remove();
      texture?.dispose();
      renderer.dispose();
    };
  }, []);

  return (
    <div ref={wrapRef} className="globe" role="img" aria-label={label} data-zoom={props.zoom.toFixed(2)}>
      <canvas ref={bgRef} className="globe-layer" aria-hidden="true" />
      <canvas ref={glRef} className="globe-layer" aria-hidden="true" />
    </div>
  );
}
