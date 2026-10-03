// Usmerjanje v brskalniku po cestnem omrežju OSM (events/<id>.graph.json).
//
// Zapore so časovne: odsek ceste je neprevozen le, če je zaprt ob uri, ko bi
// do njega prišli (časovno odvisen Dijkstra/A*). Varovani prehodi čez traso so
// med zaporo prevozni s pribitkom za čakanje, razen če se jim želimo izogniti.

const CAR = 1, BIKE = 2, FOOT = 4;
const MODE = { auto: CAR, bicycle: BIKE, pedestrian: FOOT };
const BIKE_KMH = 16, FOOT_KMH = 4.8;
const CAR_SPEED_FACTOR = 0.8;       // mestna vožnja: semaforji, križišča
const NODE_NEAR_CLOSURE_M = 12;     // vozlišče na zaprti cesti
const SEG_NEAR_CLOSURE_M = 12;      // sredina odseka na zaprti cesti
const CROSSING_RADIUS_M = 40;       // odseki tako blizu prehoda so izjema
const CROSSING_PENALTY_S = 300;     // pričakovano čakanje na prehodu (za izbiro poti)
const SNAP_RADIUS_M = 250;
const SNAP_CANDIDATES = 6;
const GRID_M = 60;

// ---------- pomožno ----------

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function segsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const rX = bx - ax, rY = by - ay, sX = dx - cx, sY = dy - cy;
  const den = rX * sY - rY * sX;
  if (Math.abs(den) < 1e-9) return false;
  const t = ((cx - ax) * sY - (cy - ay) * sX) / den;
  const u = ((cx - ax) * rY - (cy - ay) * rX) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

class Grid {
  constructor(size) { this.size = size; this.cells = new Map(); }
  key(ix, iy) { return ix * 100003 + iy; }
  add(x0, y0, x1, y1, item) {
    const s = this.size;
    for (let ix = Math.floor(Math.min(x0, x1) / s); ix <= Math.floor(Math.max(x0, x1) / s); ix++)
      for (let iy = Math.floor(Math.min(y0, y1) / s); iy <= Math.floor(Math.max(y0, y1) / s); iy++) {
        const k = this.key(ix, iy);
        let c = this.cells.get(k); if (!c) this.cells.set(k, (c = [])); c.push(item);
      }
  }
  query(x0, y0, x1, y1, out = new Set()) {
    const s = this.size;
    for (let ix = Math.floor(Math.min(x0, x1) / s); ix <= Math.floor(Math.max(x0, x1) / s); ix++)
      for (let iy = Math.floor(Math.min(y0, y1) / s); iy <= Math.floor(Math.max(y0, y1) / s); iy++) {
        const c = this.cells.get(this.key(ix, iy)); if (c) for (const it of c) out.add(it);
      }
    return out;
  }
}

class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v, top = v[0], lk = k.pop(), lv = v.pop();
    if (k.length) {
      let i = 0; const n = k.length;
      while (true) {
        let c = 2 * i + 1; if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break; k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

// ---------- gradnja omrežja ----------

export function buildNetwork(raw, ev) {
  const { proj } = ev;
  const n = raw.nodes.length / 2, [ox, oy] = raw.origin;
  const lon = new Float64Array(n), lat = new Float64Array(n), x = new Float64Array(n), y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    lon[i] = (raw.nodes[2 * i] + ox) / 1e6; lat[i] = (raw.nodes[2 * i + 1] + oy) / 1e6;
    [x[i], y[i]] = proj.fwd([lon[i], lat[i]]);
  }

  // neusmerjeni odseki
  const sa = [], sb = [], sWay = [];
  raw.ways.forEach((w, wi) => { for (let j = 1; j < w[0].length; j++) { sa.push(w[0][j - 1]); sb.push(w[0][j]); sWay.push(wi); } });
  const S = sa.length;
  const segLen = new Float64Array(S);
  for (let s = 0; s < S; s++) segLen[s] = Math.hypot(x[sb[s]] - x[sa[s]], y[sb[s]] - y[sa[s]]);

  // CSR sosednost: vsak odsek dvakrat (naprej/nazaj), načini preverjeni ob iskanju
  const deg = new Int32Array(n + 1);
  for (let s = 0; s < S; s++) { deg[sa[s] + 1]++; deg[sb[s] + 1]++; }
  for (let i = 0; i < n; i++) deg[i + 1] += deg[i];
  const fill = deg.slice(0, n), adjTo = new Int32Array(2 * S), adjSeg = new Int32Array(2 * S), adjFwd = new Uint8Array(2 * S);
  for (let s = 0; s < S; s++) {
    let k = fill[sa[s]]++; adjTo[k] = sb[s]; adjSeg[k] = s; adjFwd[k] = 1;
    k = fill[sb[s]]++; adjTo[k] = sa[s]; adjSeg[k] = s; adjFwd[k] = 0;
  }

  // indeks vozlišč za pripenjanje točk
  const nodeGrid = new Grid(150);
  for (let i = 0; i < n; i++) nodeGrid.add(x[i], y[i], x[i], y[i], i);

  // ---- zapore → seznami zapor po odsekih ----
  const cGrid = new Grid(GRID_M);
  ev.closures.forEach((c, ci) => {
    for (let j = 1; j < c.xy.length; j++) {
      const [ax, ay] = c.xy[j - 1], [bx, by] = c.xy[j];
      cGrid.add(ax - 20, ay - 20, bx + 20, by + 20, ci * 100000 + j);
    }
  });
  const nearClosures = (px, py, r) => {
    const out = [];
    for (const id of cGrid.query(px - r, py - r, px + r, py + r)) {
      const ci = Math.floor(id / 100000), j = id % 100000, c = ev.closures[ci];
      if (segDist(px, py, c.xy[j - 1][0], c.xy[j - 1][1], c.xy[j][0], c.xy[j][1]) < r && !out.includes(ci)) out.push(ci);
    }
    return out;
  };
  const nodeClosures = new Map();
  const nodeClosed = (i) => {
    let r = nodeClosures.get(i);
    if (!r) nodeClosures.set(i, (r = nearClosures(x[i], y[i], NODE_NEAR_CLOSURE_M)));
    return r;
  };

  const segDrive = new Map();   // s → [ci…]  avto/kolo: po zapori ali čez njo
  const segWalk = new Map();    // s → [ci…]  peš: samo prečkanje
  const segCrossing = new Map();// s → index prehoda, če je odsek izjema
  for (let s = 0; s < S; s++) {
    const a = sa[s], b = sb[s];
    const ax = x[a], ay = y[a], bx = x[b], by = y[b];
    const cand = cGrid.query(ax - 15, ay - 15, bx + 15, by + 15);
    if (!cand.size) continue;
    const drive = new Set(), walk = new Set();
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    for (const id of cand) {
      const ci = Math.floor(id / 100000), j = id % 100000, c = ev.closures[ci];
      const [cx, cy] = c.xy[j - 1], [dx, dy] = c.xy[j];
      if (segsIntersect(ax, ay, bx, by, cx, cy, dx, dy)) { drive.add(ci); walk.add(ci); }
      else if (segDist(mx, my, cx, cy, dx, dy) < SEG_NEAR_CLOSURE_M) drive.add(ci);
    }
    for (const ci of nodeClosed(a)) drive.add(ci);
    for (const ci of nodeClosed(b)) drive.add(ci);
    if (drive.size) segDrive.set(s, [...drive]);
    if (walk.size) segWalk.set(s, [...walk]);
    if (drive.size || walk.size) {
      const cr = ev.crossings.findIndex((c) => segDist(c.xy[0], c.xy[1], ax, ay, bx, by) < CROSSING_RADIUS_M);
      if (cr >= 0) segCrossing.set(s, cr);
    }
  }

  return { raw, n, lon, lat, x, y, sa, sb, sWay, segLen, deg, adjTo, adjSeg, adjFwd, nodeGrid, segDrive, segWalk, segCrossing };
}

// ---------- iskanje poti ----------

function edgeAllowed(net, k, mode) {
  const w = net.raw.ways[net.sWay[net.adjSeg[k]]];
  const [, modes, oneway, bikeContra] = w;
  if (!(modes & mode)) return false;
  if (mode === FOOT || !oneway) return true;
  if (mode === BIKE && bikeContra) return true;
  return net.adjFwd[k] ? oneway === 1 : oneway === -1;
}

function edgeSeconds(net, s, mode) {
  const w = net.raw.ways[net.sWay[s]];
  const kmh = mode === CAR ? (w[4] || 30) * CAR_SPEED_FACTOR : mode === BIKE ? BIKE_KMH : FOOT_KMH;
  return net.segLen[s] / (kmh / 3.6);
}

function snap(net, px, py, mode) {
  // najbližje vozlišče na vsaki od najbližjih cest (ena sama izolirana
  // parkirna pot ne sme pobrati vseh kandidatov)
  const r = SNAP_RADIUS_M, byWay = new Map();
  for (const i of net.nodeGrid.query(px - r, py - r, px + r, py + r)) {
    const d = Math.hypot(net.x[i] - px, net.y[i] - py);
    if (d > r) continue;
    for (let k = net.deg[i]; k < net.deg[i + 1]; k++) {
      const wi = net.sWay[net.adjSeg[k]];
      if (!(net.raw.ways[wi][1] & mode)) continue;
      const cur = byWay.get(wi);
      if (!cur || d < cur[0]) byWay.set(wi, [d, i]);
    }
  }
  return [...byWay.values()].sort((a, b) => a[0] - b[0]).slice(0, SNAP_CANDIDATES);
}

/**
 * @returns {null | {coords, timeS, lengthKm, usedCrossings:number[], maneuvers, snapGapM}}
 */
export function route(net, ev, { from, to, departMs, costing, closures = true, avoidCrossings = false }) {
  const mode = MODE[costing];
  const [fx, fy] = ev.proj.fwd(from), [tx, ty] = ev.proj.fwd(to);
  const approachMs = mode === CAR ? 1.5 : FOOT_KMH / 3.6; // približek do prve ceste
  const sources = snap(net, fx, fy, mode), targets = snap(net, tx, ty, mode);
  if (!sources.length || !targets.length) return null;
  const targetCost = new Map(targets.map(([d, i]) => [i, d / approachMs]));
  const vmax = mode === CAR ? 90 / 3.6 : mode === BIKE ? BIKE_KMH / 3.6 : FOOT_KMH / 3.6;
  const h = (i) => Math.hypot(net.x[i] - tx, net.y[i] - ty) / vmax;

  const blockMap = !closures ? null : mode === FOOT ? net.segWalk : net.segDrive;
  const best = new Float64Array(net.n).fill(Infinity);  // čas vožnje + pribitki
  const drive = new Float64Array(net.n);                 // čisti čas (za uro prihoda)
  const prevK = new Int32Array(net.n).fill(-1);
  const done = new Uint8Array(net.n);
  const heap = new Heap();
  for (const [d, i] of sources) { const c = d / approachMs; if (c < best[i]) { best[i] = c; drive[i] = c; heap.push(c + h(i), i); } }

  let goal = -1, goalCost = Infinity;
  while (heap.size) {
    const u = heap.pop();
    if (done[u]) continue; done[u] = 1;
    if (best[u] + h(u) >= goalCost) break;
    const tc = targetCost.get(u);
    if (tc != null && best[u] + tc < goalCost) { goalCost = best[u] + tc; goal = u; }
    for (let k = net.deg[u]; k < net.deg[u + 1]; k++) {
      const v = net.adjTo[k];
      if (done[v] || !edgeAllowed(net, k, mode)) continue;
      const s = net.adjSeg[k];
      let extra = 0;
      const blockers = blockMap?.get(s);
      if (blockers) {
        const t = departMs + drive[u] * 1000;
        if (blockers.some((ci) => { const c = ev.closures[ci]; return c.startMs <= t && t < c.endMs; })) {
          if (avoidCrossings || !net.segCrossing.has(s)) continue;
          extra = CROSSING_PENALTY_S;
        }
      }
      const dt = edgeSeconds(net, s, mode), nb = best[u] + dt + extra;
      if (nb < best[v]) { best[v] = nb; drive[v] = drive[u] + dt; prevK[v] = k; heap.push(nb + h(v), v); }
    }
  }
  if (goal < 0) return null;

  // rekonstrukcija
  const ks = [];
  for (let v = goal; prevK[v] >= 0; ) { const k = prevK[v]; ks.push(k); v = findFrom(net, k); }
  ks.reverse();
  const startNode = ks.length ? findFrom(net, ks[0]) : goal;
  const nodes = [startNode, ...ks.map((k) => net.adjTo[k])];
  const used = new Set();
  let lengthM = 0;
  for (const k of ks) lengthM += net.segLen[net.adjSeg[k]];
  // prehodi: odseki-izjeme, ki so bili ob prihodu zaprti
  if (blockMap) {
    for (const k of ks) {
      const s = net.adjSeg[k], t = departMs + drive[findFrom(net, k)] * 1000;
      const bl = blockMap.get(s);
      if (bl && net.segCrossing.has(s) && bl.some((ci) => ev.closures[ci].startMs <= t && t < ev.closures[ci].endMs)) used.add(net.segCrossing.get(s));
    }
  }
  const coords = [from, ...nodes.map((i) => [net.lon[i], net.lat[i]]), to];
  return {
    coords,
    timeS: drive[goal] + targetCost.get(goal),
    lengthKm: lengthM / 1000,
    usedCrossings: [...used].map((i) => ev.crossings[i]),
    maneuvers: maneuvers(net, ks, nodes),
    snapGapM: Math.max(sources.find(([, i]) => i === startNode)?.[0] ?? 0, targets.find(([, i]) => i === goal)?.[0] ?? 0),
  };
}

// izhodiščno vozlišče usmerjene povezave k
function findFrom(net, k) {
  const s = net.adjSeg[k];
  return net.adjFwd[k] ? net.sa[s] : net.sb[s];
}

// ---------- navodila ----------

function bearing(net, a, b) { return Math.atan2(net.x[b] - net.x[a], net.y[b] - net.y[a]) * 180 / Math.PI; }

function maneuvers(net, ks, nodes) {
  if (!ks.length) return [{ instruction: 'Cilj je tik ob izhodišču.', length: 0 }];
  const name = (k) => net.raw.names[net.raw.ways[net.sWay[net.adjSeg[k]]][5]] || '';
  const out = [];
  let i = 0;
  while (i < ks.length) {
    const nm = name(ks[i]); let j = i, len = 0;
    while (j < ks.length && name(ks[j]) === nm) { len += net.segLen[net.adjSeg[ks[j]]]; j++; }
    const street = nm || 'neimenovano cesto';
    let instr;
    if (i === 0) instr = `Začnite na ${street}.`;
    else {
      let d = bearing(net, nodes[i], nodes[i + 1]) - bearing(net, nodes[i - 1], nodes[i]);
      d = ((d + 540) % 360) - 180;
      const turn = Math.abs(d) < 25 ? 'Nadaljujte naravnost' : Math.abs(d) < 60 ? (d > 0 ? 'Rahlo desno' : 'Rahlo levo')
        : Math.abs(d) < 150 ? (d > 0 ? 'Zavijte desno' : 'Zavijte levo') : 'Obrnite';
      instr = `${turn} na ${street}.`;
    }
    // zelo kratke neimenovane odseke (priključki) pripni k naslednjemu
    if (!nm && len < 40 && j < ks.length && out.length) { out[out.length - 1].length += len / 1000; i = j; continue; }
    out.push({ instruction: instr, length: len / 1000 });
    i = j;
  }
  out.push({ instruction: 'Prispeli ste na cilj.', length: 0 });
  return out;
}

// ---------- glavna funkcija za aplikacijo ----------

export function plan(net, ev, opts) {
  const baseline = route(net, ev, { ...opts, closures: false });
  const r = route(net, ev, opts);
  return { baseline, route: r };
}

// Prvi odhod (v korakih po 15 min, do 8 h), pri katerem pot obstaja.
export function laterDeparture(net, ev, opts, stepMin = 15, maxH = 8) {
  for (let t = opts.departMs + stepMin * 60000; t <= opts.departMs + maxH * 3600000; t += stepMin * 60000) {
    const r = route(net, ev, { ...opts, departMs: t });
    if (r) return { departMs: t, route: r };
  }
  return null;
}
