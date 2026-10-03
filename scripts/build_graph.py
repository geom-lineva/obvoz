#!/usr/bin/env python3
"""Iz OpenStreetMap (Overpass) zgradi kompaktno cestno omrežje za dogodek.

Okvir = vse zapore dogodka + rob (privzeto 4 km). Rezultat: events/<id>.graph.json,
ki ga brskalnik naloži in po njem sam računa poti (graph.js).

    python3 scripts/build_graph.py ljubljanski-maraton-2026 [--margin-km 4]
"""
import argparse, json, math, re, urllib.parse, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OVERPASS = "https://overpass-api.de/api/interpreter"

CAR, BIKE, FOOT = 1, 2, 4
# razred → (dovoljeni načini, privzeta hitrost km/h za avto)
CLASSES = {
    "motorway": (CAR, 90), "motorway_link": (CAR, 50),
    "trunk": (CAR, 70), "trunk_link": (CAR, 40),
    "primary": (CAR | BIKE | FOOT, 50), "primary_link": (CAR | BIKE | FOOT, 35),
    "secondary": (CAR | BIKE | FOOT, 45), "secondary_link": (CAR | BIKE | FOOT, 30),
    "tertiary": (CAR | BIKE | FOOT, 40), "tertiary_link": (CAR | BIKE | FOOT, 30),
    "unclassified": (CAR | BIKE | FOOT, 35), "residential": (CAR | BIKE | FOOT, 30),
    "living_street": (CAR | BIKE | FOOT, 10), "service": (CAR | BIKE | FOOT, 15),
    "pedestrian": (FOOT | BIKE, 0), "footway": (FOOT, 0), "path": (FOOT | BIKE, 0),
    "cycleway": (BIKE | FOOT, 0), "steps": (FOOT, 0), "track": (BIKE | FOOT, 0),
}
NO = {"no", "private"}


def bbox_of_event(ev, margin_km):
    xs, ys = [], []
    for f in ev["features"]:
        g = f["geometry"]
        pts = g["coordinates"] if g["type"] == "LineString" else [g["coordinates"]]
        for lon, lat in pts:
            xs.append(lon); ys.append(lat)
    dlat = margin_km / 110.54
    dlon = margin_km / (111.32 * math.cos(math.radians(sum(ys) / len(ys))))
    return min(ys) - dlat, min(xs) - dlon, max(ys) + dlat, max(xs) + dlon


def simplify(nids, coords, keep, tol):
    """Douglas–Peucker v metrih; vozlišča, kjer se cesta stika z drugo, ostanejo."""
    k = 111320 * math.cos(math.radians(coords[nids[0]][1]))
    xy = [(coords[n][0] * k, coords[n][1] * 110540) for n in nids]
    out = {0, len(nids) - 1} | {i for i, n in enumerate(nids) if keep(n)}
    anchors = sorted(out)
    def dp(i, j):
        (ax, ay), (bx, by) = xy[i], xy[j]
        L = math.hypot(bx - ax, by - ay) or 1e-9
        best, bi = 0, -1
        for m in range(i + 1, j):
            d = abs((bx - ax) * (ay - xy[m][1]) - (ax - xy[m][0]) * (by - ay)) / L
            if d > best: best, bi = d, m
        if best > tol:
            out.add(bi); dp(i, bi); dp(bi, j)
    for i, j in zip(anchors, anchors[1:]):
        dp(i, j)
    return [nids[i] for i in sorted(out)]


def speed_of(tags, default):
    m = re.match(r"(\d+)", tags.get("maxspeed", ""))
    return int(m.group(1)) if m else default


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("event_id")
    ap.add_argument("--margin-km", type=float, default=4)
    ap.add_argument("--car-only", action="store_true",
                    help="samo ceste za avto (za velika območja; kolo/peš se ne ponudita)")
    ap.add_argument("--simplify-m", type=float, default=0,
                    help="poenostavi obliko cest (Douglas–Peucker), križišča ostanejo")
    a = ap.parse_args()
    ev = json.loads((ROOT / "events" / f"{a.event_id}.geojson").read_text())
    s, w, n, e = bbox_of_event(ev, a.margin_km)

    classes = [c for c, (m, _) in CLASSES.items() if not a.car_only or m & CAR]
    q = (f'[out:json][timeout:180];way["highway"~"^({"|".join(classes)})$"]'
         f"({s:.5f},{w:.5f},{n:.5f},{e:.5f});(._;>;);out body qt;")
    req = urllib.request.Request(OVERPASS, data=urllib.parse.urlencode({"data": q}).encode(),
                                 headers={"User-Agent": "obvoz graph builder"})
    data = json.loads(urllib.request.urlopen(req, timeout=240).read())

    coords = {el["id"]: (el["lon"], el["lat"]) for el in data["elements"] if el["type"] == "node"}
    used, ways, names = {}, [], {}
    for el in data["elements"]:
        if el["type"] != "way":
            continue
        t = el.get("tags", {})
        hw = t["highway"]
        modes, vdef = CLASSES[hw]
        if hw == "service" and t.get("service") in {"parking_aisle", "driveway"}:
            modes &= ~CAR
        if t.get("access") in NO or t.get("motor_vehicle") in NO or t.get("motorcar") in NO:
            modes &= ~CAR
        if t.get("bicycle") in NO: modes &= ~BIKE
        if t.get("bicycle") in {"yes", "designated"}: modes |= BIKE
        if t.get("foot") in NO: modes &= ~FOOT
        if t.get("foot") in {"yes", "designated"}: modes |= FOOT
        if t.get("access") in NO and t.get("foot") not in {"yes", "designated"}: modes &= ~FOOT
        if a.car_only:
            modes &= CAR
        if t.get("area") == "yes" or not modes:
            continue
        ow = t.get("oneway")
        oneway = 1 if ow in {"yes", "true", "1"} else -1 if ow == "-1" else 0
        if t.get("junction") in {"roundabout", "circular"} or hw.startswith("motorway"):
            oneway = oneway or 1
        bike_contra = t.get("oneway:bicycle") == "no" or t.get("cycleway") in {"opposite", "opposite_lane"}
        name = t.get("name") or t.get("ref") or ""
        ni = names.setdefault(name, len(names))
        nids = [n for n in el["nodes"] if n in coords]
        if len(nids) < 2:
            continue
        ways.append([nids, modes, oneway, int(bike_contra),
                     speed_of(t, vdef) if modes & CAR else 0, ni, list(CLASSES).index(hw)])

    if a.simplify_m:
        refs = {}
        for way in ways:
            for n in way[0]:
                refs[n] = refs.get(n, 0) + 1
        for way in ways:
            way[0] = simplify(way[0], coords, lambda n: refs[n] > 1, a.simplify_m)
    for way in ways:
        way[0] = [used.setdefault(n, len(used)) for n in way[0]]

    # koordinate v mikrostopinjah, relativno na jugozahodni vogal (krajši zapis)
    ox, oy = round(w * 1e6), round(s * 1e6)
    flat = [0] * (2 * len(used))
    for nid, i in used.items():
        lon, lat = coords[nid]
        flat[2 * i] = round(lon * 1e6) - ox; flat[2 * i + 1] = round(lat * 1e6) - oy
    out = ROOT / "events" / f"{a.event_id}.graph.json"
    out.write_text(json.dumps({
        "bbox": [w, s, e, n], "origin": [ox, oy], "classes": list(CLASSES),
        "modes": ["auto"] if a.car_only else ["auto", "bicycle", "pedestrian"],
        "names": sorted(names, key=names.get), "nodes": flat, "ways": ways,
        "source": "© OpenStreetMap contributors (ODbL), Overpass API",
    }, ensure_ascii=False, separators=(",", ":")))
    print(f"{out.name}: {len(used)} vozlišč, {len(ways)} cest, {out.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
