// Usmerjanje mimo časovnih zapor.
//
// Javni Valhalla strežnik dovoli največ 10 km obsega exclude_polygons, zapor pa je
// lahko 50+ km. Zato ne pošljemo vseh zapor, ampak iterativno: izračunamo pot,
// poiščemo mesta, kjer seka ali vozi po aktivni zapori, tam dodamo majhen
// izključitveni kvadrat in ponovimo. Varovani prehodi čez traso ostanejo odprti.

export const VALHALLA_URL = 'https://valhalla1.openstreetmap.de/route';
// Omejitve javnega strežnika (ob lastnem strežniku jih lahko dvignemo).
const MAX_PERIMETER_M = 9500;   // 10000 m obsega poligonov
const MAX_RING_VERTICES = 100;  // 100 oglišč za vse poligone skupaj
const MAX_LOCATIONS = 50;       // 50 izključenih točk
const MAX_ITERATIONS = 14;
const LOC_OFFSET_M = 10;        // točka na prečni cesti, tako daleč od presečišča
const LOC_ALONG_STEP_M = 60;    // točke vzdolž zaprtega odseka
const LOC_ALONG_MAX = 8;
const SQUARE_HALF_M = 15;
const SQUARE_HALF_MAX_M = 60;
const CROSSING_RADIUS_M = 35;   // presečišče tako blizu prehoda je dovoljeno
const ENDPOINT_RADIUS_M = 40;   // konflikti ob startu/cilju se ne dajo obiti
const ENDPOINT_GUARD_M = 150;   // brez izključitev tako blizu starta/cilja, sicer
                                // Valhalla izključi odsek, na katerem stojimo → ni poti
const ALONG_DIST_M = 12;        // pot je »na« zapori, če je tako blizu …
const ALONG_MIN_RUN_M = 40;     // … vsaj toliko metrov zapored
const SAMPLE_STEP_M = 8;

// ---------- geometrija v lokalni ravnini (metri) ----------

export function makeProjection(lat0, lon0) {
  const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
  return {
    fwd: ([lon, lat]) => [(lon - lon0) * kx, (lat - lat0) * ky],
    inv: ([x, y]) => [lon0 + x / kx, lat0 + y / ky],
  };
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function segIntersect(p, p2, q, q2) {
  const r = sub(p2, p), s = sub(q2, q);
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-9) return null;
  const qp = sub(q, p);
  const t = (qp[0] * s[1] - qp[1] * s[0]) / den;
  const u = (qp[0] * r[1] - qp[1] * r[0]) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return [p[0] + t * r[0], p[1] + t * r[1]];
}

function segDist(p, a, b) {
  const ab = sub(b, a), l2 = ab[0] ** 2 + ab[1] ** 2;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / l2)) : 0;
  return dist(p, [a[0] + t * ab[0], a[1] + t * ab[1]]);
}

function bboxOf(pts, pad = 0) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}
const bboxHit = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
const inBbox = (p, b) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];

function densify(pts, step) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], n = Math.max(1, Math.ceil(dist(a, b) / step));
    for (let k = 1; k <= n; k++) out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
  }
  return out;
}

export function decodePolyline6(str) {
  const out = []; let i = 0, lat = 0, lon = 0;
  while (i < str.length) {
    for (const which of [0, 1]) {
      let shift = 0, result = 0, b;
      do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += d; else lon += d;
    }
    out.push([lon / 1e6, lat / 1e6]);
  }
  return out;
}

// ---------- dogodek ----------

export function prepareEvent(geojson) {
  const [lon0, lat0] = geojson.event.center;
  const proj = makeProjection(lat0, lon0);
  const closures = [], crossings = [];
  for (const f of geojson.features) {
    const p = f.properties;
    const base = { ...p, startMs: Date.parse(p.start), endMs: Date.parse(p.end) };
    if (p.kind === 'closure') {
      const xy = f.geometry.coordinates.map(proj.fwd);
      closures.push({ ...base, coords: f.geometry.coordinates, xy, bbox: bboxOf(xy) });
    } else if (p.kind === 'crossing') {
      crossings.push({ ...base, coords: f.geometry.coordinates, xy: proj.fwd(f.geometry.coordinates) });
    }
  }
  return { meta: geojson.event, proj, closures, crossings };
}

export const isActive = (c, t0, t1) => c.startMs < t1 && c.endMs > t0;

// ---------- iskanje konfliktov ----------

function findConflicts(routeXY, closures, crossings, endpoints, alongCheck) {
  const nearCrossing = (p) => crossings.find((c) => dist(p, c.xy) < CROSSING_RADIUS_M);
  const nearEnd = (p, r = ENDPOINT_RADIUS_M) => endpoints.some((e) => dist(p, e) < r);
  const conflicts = [], usedCrossings = new Set();
  let atEndpoint = false;
  const routeBbox = bboxOf(routeXY, ALONG_DIST_M);
  const cand = closures.filter((c) => bboxHit(c.bbox, routeBbox));

  // 1) pot seka zaporo
  for (let i = 1; i < routeXY.length; i++) {
    const a = routeXY[i - 1], b = routeXY[i], sb = bboxOf([a, b]);
    for (const c of cand) {
      if (!bboxHit(c.bbox, sb)) continue;
      for (let j = 1; j < c.xy.length; j++) {
        const pt = segIntersect(a, b, c.xy[j - 1], c.xy[j]);
        if (!pt) continue;
        const cr = nearCrossing(pt);
        if (cr) { usedCrossings.add(cr); continue; }
        if (nearEnd(pt)) { atEndpoint = true; continue; }
        const u = sub(b, a), L = Math.hypot(...u) || 1;
        const ux = [u[0] / L, u[1] / L];
        const block = [[pt[0] - ux[0] * LOC_OFFSET_M, pt[1] - ux[1] * LOC_OFFSET_M],
                       [pt[0] + ux[0] * LOC_OFFSET_M, pt[1] + ux[1] * LOC_OFFSET_M]]
          .filter((q) => !nearEnd(q, ENDPOINT_GUARD_M));
        if (!block.length && nearEnd(pt, ENDPOINT_GUARD_M)) { atEndpoint = true; continue; }
        conflicts.push({ xy: pt, closure: c, type: 'cross', block });
      }
    }
  }

  // 2) pot vozi po zapori (za pešce ne velja – pločniki so odprti)
  if (alongCheck) {
    const samples = densify(routeXY, SAMPLE_STEP_M);
    const flags = samples.map((p) => {
      for (const c of cand) {
        if (!inBbox(p, [c.bbox[0] - ALONG_DIST_M, c.bbox[1] - ALONG_DIST_M, c.bbox[2] + ALONG_DIST_M, c.bbox[3] + ALONG_DIST_M])) continue;
        for (let j = 1; j < c.xy.length; j++) if (segDist(p, c.xy[j - 1], c.xy[j]) < ALONG_DIST_M) return c;
      }
      return null;
    });
    let s = -1;
    for (let i = 0; i <= flags.length; i++) {
      if (i < flags.length && flags[i]) { if (s < 0) s = i; continue; }
      if (s >= 0 && (i - s) * SAMPLE_STEP_M >= ALONG_MIN_RUN_M) {
        const mid = samples[(s + i - 1) >> 1];
        if (nearEnd(mid)) atEndpoint = true;
        else if (!nearCrossing(mid)) {
          const k = Math.max(1, Math.round(LOC_ALONG_STEP_M / SAMPLE_STEP_M));
          let block = [];
          for (let j = s + 1; j < i - 1; j += k) if (!nearEnd(samples[j], ENDPOINT_GUARD_M) && !nearCrossing(samples[j])) block.push(samples[j]);
          if (block.length > LOC_ALONG_MAX) block = block.filter((_, n) => n % Math.ceil(block.length / LOC_ALONG_MAX) === 0);
          if (!block.length && nearEnd(mid, ENDPOINT_GUARD_M)) { atEndpoint = true; s = -1; continue; }
          conflicts.push({ xy: mid, closure: flags[(s + i - 1) >> 1], type: 'along', block });
        }
      }
      s = -1;
    }
  }

  // združi bližnje
  const merged = [];
  for (const c of conflicts) if (!merged.some((m) => dist(m.xy, c.xy) < 25)) merged.push(c);
  return { conflicts: merged, usedCrossings: [...usedCrossings], atEndpoint };
}

// ---------- Valhalla ----------

async function valhalla(from, to, costing, polygons, excludeLocs, signal) {
  const body = {
    locations: [{ lon: from[0], lat: from[1] }, { lon: to[0], lat: to[1] }],
    costing,
    language: 'sl-SI',
    directions_options: { units: 'kilometers' },
  };
  if (polygons.length) body.exclude_polygons = polygons;
  if (excludeLocs.length) body.exclude_locations = excludeLocs.map(([lon, lat]) => ({ lon, lat }));
  const res = await fetch(VALHALLA_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal,
  });
  const json = await res.json();
  if (!res.ok || !json.trip) {
    const err = new Error(json.error || `HTTP ${res.status}`);
    err.code = json.error_code; throw err;
  }
  const leg = json.trip.legs[0];
  return {
    coords: decodePolyline6(leg.shape),
    timeS: json.trip.summary.time,
    lengthKm: json.trip.summary.length,
    maneuvers: leg.maneuvers,
  };
}

// ---------- glavna funkcija ----------

export async function planRoute(ev, { from, to, departMs, costing, avoidCrossings = false, signal, onProgress }) {
  const { proj } = ev;
  const endpoints = [proj.fwd(from), proj.fwd(to)];
  const squares = [];   // {xy, half} – zadnja možnost, ko točke ne zaležejo
  const locs = [];      // xy točk za exclude_locations
  const perimeter = () => squares.reduce((s, q) => s + 8 * q.half, 0);
  const toRing = ({ xy: [x, y], half: h }) =>
    [[x - h, y - h], [x + h, y - h], [x + h, y + h], [x - h, y + h], [x - h, y - h]].map(proj.inv);

  let baseline = null, route = null, last = null, status = 'ok', error = null;
  for (let it = 0; it < MAX_ITERATIONS; it++) {
    onProgress?.(it);
    try {
      route = await valhalla(from, to, costing, squares.map(toRing), locs.map(proj.inv), signal);
    } catch (e) {
      if (e.name === 'AbortError' || !last) throw e;
      status = 'no-route'; error = e.message; route = last.route; break;
    }
    if (!baseline) baseline = route;

    const t1 = departMs + route.timeS * 1000;
    const active = ev.closures.filter((c) => isActive(c, departMs, t1));
    // Varovani prehodi so med zaporo prehodni (s čakanjem), razen če se jim želimo izogniti.
    const crossings = avoidCrossings ? [] : ev.crossings;
    const found = findConflicts(route.coords.map(proj.fwd), active, crossings, endpoints, costing !== 'pedestrian');
    last = { route, ...found, activeCount: active.length, iterations: it + 1 };
    if (!found.conflicts.length) break;

    let added = false;
    for (const c of found.conflicts) {
      const repeat = locs.some((l) => dist(l, c.xy) < 30) || squares.some((q) => dist(q.xy, c.xy) < q.half * 2);
      if (!repeat && c.block.length && locs.length + c.block.length <= MAX_LOCATIONS) {
        locs.push(...c.block); added = true; continue;
      }
      // točke niso pomagale (ali jih zmanjka) → kvadrat čez mesto konflikta
      const near = squares.find((q) => dist(q.xy, c.xy) < q.half * 2);
      if (near) {
        if (near.half < SQUARE_HALF_MAX_M && perimeter() + 8 * near.half * 0.8 <= MAX_PERIMETER_M) {
          near.half = Math.min(SQUARE_HALF_MAX_M, near.half * 1.8); added = true;
        }
      } else if ((squares.length + 1) * 5 <= MAX_RING_VERTICES && perimeter() + 8 * SQUARE_HALF_M <= MAX_PERIMETER_M) {
        squares.push({ xy: c.xy, half: SQUARE_HALF_M }); added = true;
      }
    }
    if (!added) { status = 'limit'; break; }
    if (it === MAX_ITERATIONS - 1) status = 'limit';
  }
  if (last.conflicts.length === 0 && status !== 'no-route') status = 'ok';

  return {
    status, error, baseline,
    route: last.route,
    conflicts: last.conflicts.map((c) => ({ ...c, coords: proj.inv(c.xy) })),
    usedCrossings: last.usedCrossings,
    atEndpoint: last.atEndpoint,
    activeCount: last.activeCount,
    iterations: last.iterations,
    squares: squares.map(toRing),
    excluded: locs.map(proj.inv),
  };
}

// Če poti ni (npr. start je znotraj zaprte zanke), poskusi z odhodom ob koncih
// zapor, ki so v napoto. Vrne prvi odhod, pri katerem je pot čista.
export async function findLaterDeparture(ev, opts, result, maxTries = 4) {
  const ends = [...new Set(result.conflicts.map((c) => c.closure.endMs))]
    .filter((t) => t > opts.departMs).sort((a, b) => a - b);
  for (const t of ends.slice(0, maxTries)) {
    const r = await planRoute(ev, { ...opts, departMs: t, onProgress: null });
    if (r.status === 'ok') return { departMs: t, result: r };
  }
  return null;
}
