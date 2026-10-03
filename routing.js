// Dogodek: zapore in prehodi v lokalni ravnini (metri) + časovni pogoji.

export function makeProjection(lat0, lon0) {
  const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
  return {
    fwd: ([lon, lat]) => [(lon - lon0) * kx, (lat - lat0) * ky],
    inv: ([x, y]) => [lon0 + x / kx, lat0 + y / ky],
  };
}

function bboxOf(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return [x0, y0, x1, y1];
}

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
