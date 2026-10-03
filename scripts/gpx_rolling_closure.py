#!/usr/bin/env python3
"""Iz GPX trase + startne ure ustvari »drsečo« zaporo (kolesarske dirke, teki).

Trasa se razreže na odseke (privzeto 1 km). Vsak odsek je zaprt od
(čas prihoda prvega - before) do (čas prihoda zadnjega + after), pri čemer
se prihod računa iz hitrosti najhitrejših in najpočasnejših udeležencev.

Primer (kolesarska cestna dirka, start 12:00, 38-48 km/h):
    python3 scripts/gpx_rolling_closure.py trasa.gpx \\
        --id ep-kolesarstvo-cestna --name "EP v kolesarstvu – cestna dirka" \\
        --start 2026-10-04T12:00 --fast 48 --slow 38 --before 45 --after 15

Rezultat: events/<id>.geojson (doda se tudi v events/index.json).
"""
import argparse, json, math, xml.etree.ElementTree as ET
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def read_gpx(path):
    pts = []
    for el in ET.parse(path).iter():
        if el.tag.split("}")[-1] in ("trkpt", "rtept"):
            pts.append([float(el.get("lon")), float(el.get("lat"))])
    return pts


def dist(a, b):
    k = math.cos(math.radians((a[1] + b[1]) / 2))
    return math.hypot((b[0] - a[0]) * k * 111320, (b[1] - a[1]) * 110540)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("gpx")
    ap.add_argument("--id", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--start", required=True, help="lokalni čas starta, YYYY-MM-DDTHH:MM")
    ap.add_argument("--fast", type=float, required=True, help="km/h najhitrejših")
    ap.add_argument("--slow", type=float, required=True, help="km/h najpočasnejših")
    ap.add_argument("--before", type=int, default=30, help="min zapore pred prvim")
    ap.add_argument("--after", type=int, default=15, help="min zapore po zadnjem")
    ap.add_argument("--chunk", type=float, default=1000, help="dolžina odseka v m")
    a = ap.parse_args()

    pts = read_gpx(a.gpx)
    t0 = datetime.fromisoformat(a.start)
    feats, cur, d0, d = [], [pts[0]], 0.0, 0.0
    for p, q in zip(pts, pts[1:]):
        d += dist(p, q)
        cur.append(q)
        if d - d0 >= a.chunk or q is pts[-1]:
            first = t0 + timedelta(hours=d0 / 1000 / a.fast) - timedelta(minutes=a.before)
            last = t0 + timedelta(hours=d / 1000 / a.slow) + timedelta(minutes=a.after)
            feats.append({
                "type": "Feature",
                "properties": {
                    "kind": "closure",
                    "name": f"km {d0 / 1000:.0f}–{d / 1000:.0f}",
                    "note": "Ocenjena drseča zapora (iz GPX in hitrosti).",
                    "start": first.strftime("%Y-%m-%dT%H:%M"),
                    "end": last.strftime("%Y-%m-%dT%H:%M"),
                    "length_m": round(d - d0),
                },
                "geometry": {"type": "LineString", "coordinates": cur},
            })
            cur, d0 = [q], d

    lons = [p[0] for p in pts]; lats = [p[1] for p in pts]
    days = sorted({f["properties"]["start"][:10] for f in feats} |
                  {f["properties"]["end"][:10] for f in feats})
    event = {
        "type": "FeatureCollection",
        "event": {
            "id": a.id, "name": a.name, "timezone": "Europe/Ljubljana",
            "days": days, "defaultTime": a.start,
            "center": [(min(lons) + max(lons)) / 2, (min(lats) + max(lats)) / 2],
            "zoom": 11, "source": Path(a.gpx).name,
        },
        "features": feats,
    }
    out = ROOT / "events" / f"{a.id}.geojson"
    out.write_text(json.dumps(event, ensure_ascii=False, indent=1))

    idx_path = ROOT / "events" / "index.json"
    idx = json.loads(idx_path.read_text()) if idx_path.exists() else []
    idx = [e for e in idx if e["id"] != a.id] + [{"id": a.id, "name": a.name}]
    idx_path.write_text(json.dumps(idx, ensure_ascii=False, indent=1))
    print(f"{out.name}: {len(feats)} odsekov, {d / 1000:.1f} km")


if __name__ == "__main__":
    main()
