#!/usr/bin/env python3
"""Uvoz zapor za EP v cestnem kolesarstvu 2026 (2.–7. 10., Ljubljana–Šenčur).

Viri (organizator SLO BIKE, roadslovenia2026.si):
  - GPX tras za vsako dirko (stran »Race programme«),
  - časovnice prehoda (PDF »Cas_...«: kilometri in ure pri 4 hitrostih),
  - stran »Zapore in parkirišča« (zaključni krog 8.00–19.00, trajne zapore, Ljubljana).

Kaj nastane:
  - zaključni krog Šenčur–Olševek–Možjanca–Cerklje–Šenčur: zaprt 8.00–19.00 na dneve dirk,
  - trajne zapore (Pipanova, Tupaliče–Možjanca–Štefanja Gora–Grad, Velesovska),
  - drseče zapore na trasi Ljubljana–…–Cerklje: vsak km je zaprt od prihoda najhitrejših
    –15 min do prihoda najpočasnejših +10 min (policija: posamezna zapora do 30 min),
  - nevtralni del in startni prostor v Ljubljani.

    python3 scripts/import_ep2026.py && python3 scripts/build_graph.py ep-kolesarstvo-2026 --car-only
"""
import json, math, re, subprocess, tempfile, urllib.parse, urllib.request, xml.etree.ElementTree as ET
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EVENT_ID = "ep-kolesarstvo-2026"
UP = "https://roadslovenia2026.si/wp-content/uploads/2026"
UA = {"User-Agent": "Mozilla/5.0 (obvoz importer)"}
BEFORE, AFTER = timedelta(minutes=15), timedelta(minutes=10)

# Dirke iz Ljubljane (proga + krogi). Časovnica: None = oceni iz hitrosti.
LINE_RACES = [
    {"name": "Moški U23", "date": "2026-10-02", "start": "13:30", "gpx": "07/EP_cesta_M_U23_2.10.26.gpx",
     "cas": None, "speeds": (39, 45), "neutral_km": 9.1},
    {"name": "Ženske elite", "date": "2026-10-03", "start": "13:30", "gpx": "07/EP_cesta_%C5%BD_Elite_3.10.26.gpx",
     "cas": "08/UEC-2026-Cas_women_elite_03102026.pdf"},
    {"name": "Moški elite", "date": "2026-10-04", "start": "12:30", "gpx": "07/EP_cesta_M_Elite_4.10.26.gpx",
     "cas": "09/UEC-2026-Cas_men_elite_04102026-2.pdf"},
]
CIRCUIT_GPX = "07/EP_kronometer_7.10.26.gpx"   # en krog, 22,1 km, start/cilj Šenčur
CIRCUIT_DAYS = {  # dan → (od, do, opomba)
    "2026-10-02": ("08:00", "19:00", "uradno"), "2026-10-03": ("08:00", "19:00", "uradno"),
    "2026-10-04": ("08:00", "19:00", "uradno"),
    "2026-10-06": ("08:00", "19:00", "ocena – ekipna štafeta; organizator ure ni objavil"),
    "2026-10-07": ("08:00", "19:00", "ocena – vožnja na čas; organizator ure ni objavil"),
}
# Trajne zapore kot km-razponi na krogu (preverjeno s kraji na trasi).
LONG_TERM = [
    ("Pipanova cesta (Šenčur–Visoko), ciljni prostor", 0.0, 2.3, "2026-09-29T00:00", "2026-10-09T23:59"),
    ("Cesta Tupaliče–Možjanca–Štefanja Gora–Grad", 5.3, 15.3, "2026-10-01T00:00", "2026-10-07T23:59"),
    ("Velesovska cesta (do Sajovčevega naselja), približno", 20.8, 22.1, "2026-09-29T00:00", "2026-10-07T23:59"),
]
# Startni prostor v Ljubljani: Slovenska (Aškerčeva–Šubičeva), Igriška, Erjavčeva
LJ_START = {"2026-10-02": ("09:30", "14:30"), "2026-10-03": ("09:30", "14:30"), "2026-10-04": ("08:00", "13:30")}
# Uradni opis: Kongresni trg – Tromostovje – Kopitarjeva – Komenskega – Tavčarjeva – Slovenska –
# Bleiweisova – Celovška – Šentvid. (Kopitarjeva se pri iskanju pripne napačno, zato jo prepusti usmerjanju.)
NEUTRAL_WAYPOINTS = ["Kongresni trg, Ljubljana", "Tromostovje, Ljubljana", "Komenskega ulica, Ljubljana",
                     "Tavčarjeva ulica, Ljubljana", "Gosposvetska cesta, Ljubljana", "Celovška cesta 25, Ljubljana"]


def get(url, data=None):
    req = urllib.request.Request(url, data=data, headers={**UA, **({"Content-Type": "application/json"} if data else {})})
    return urllib.request.urlopen(req, timeout=120).read()


def gpx_points(raw):
    return [[float(e.get("lon")), float(e.get("lat"))] for e in ET.fromstring(raw).iter()
            if e.tag.split("}")[-1] in ("trkpt", "rtept")]


def dist(a, b):
    k = math.cos(math.radians((a[1] + b[1]) / 2))
    return math.hypot((b[0] - a[0]) * k * 111320, (b[1] - a[1]) * 110540)


def cumulative(pts):
    c = [0.0]
    for a, b in zip(pts, pts[1:]):
        c.append(c[-1] + dist(a, b))
    return c


def slice_km(pts, cum, km0, km1):
    out = [p for p, c in zip(pts, cum) if km0 * 1000 <= c <= km1 * 1000]
    return out if len(out) >= 2 else None


def timetable(path_suffix):
    """[(to_finish_km, t_slow, t_fast, place, comment)] iz PDF časovnice."""
    with tempfile.NamedTemporaryFile(suffix=".pdf") as f:
        f.write(get(f"{UP}/{path_suffix}")); f.flush()
        txt = subprocess.run(["pdftotext", "-layout", f.name, "-"], capture_output=True, text=True).stdout
    rows = []
    for line in txt.splitlines():
        m = re.search(r"(\d+,\d)\s+(\d+,\d)\s+(\d{1,2}:\d\d)\s+(\d{1,2}:\d\d)\s+(\d{1,2}:\d\d)\s+(\d{1,2}:\d\d)", line)
        if not m:
            continue
        parts = [x for x in re.split(r"\s{2,}", line[:m.start()].strip()) if not re.fullmatch(r"[↑→←\s\d,]*", x)]
        has_comment = not line[:1].isspace()   # stolpec »Comments« je čisto levo
        comment = parts[0] if has_comment and parts else ""
        place = (parts[1] if len(parts) > 1 else "") if has_comment else (parts[0] if parts else "")
        rows.append((float(m.group(2).replace(",", ".")), m.group(3), m.group(6), place, comment))
    return rows


def at(date, hhmm):
    return datetime.fromisoformat(f"{date}T{int(hhmm.split(':')[0]):02d}:{hhmm.split(':')[1]}")


def fmt(t):
    return t.strftime("%Y-%m-%dT%H:%M")


def closure(name, note, coords, start, end):
    return {"type": "Feature", "properties": {"kind": "closure", "name": name, "note": note,
            "start": start, "end": end, "length_m": round(sum(dist(a, b) for a, b in zip(coords, coords[1:])))},
            "geometry": {"type": "LineString", "coordinates": [[round(x, 6), round(y, 6)] for x, y in coords]}}


def chunks(pts, cum, km0, km1, step=1.0):
    k = km0
    while k < km1 - 0.05:
        seg = slice_km(pts, cum, k, min(k + step, km1))
        if seg:
            yield k, min(k + step, km1), seg
        k += step


def geocode(q):
    r = json.loads(get("https://photon.komoot.io/api/?limit=1&lat=46.05&lon=14.5&q=" + urllib.parse.quote(q)))
    return r["features"][0]["geometry"]["coordinates"]


def valhalla_line(waypoints):
    body = json.dumps({"locations": [{"lon": x, "lat": y} for x, y in waypoints], "costing": "bicycle"}).encode()
    trip = json.loads(get("https://valhalla1.openstreetmap.de/route", body))["trip"]
    out = []
    for leg in trip["legs"]:
        s, i, lat, lon = leg["shape"], 0, 0, 0
        while i < len(s):
            for which in (0, 1):
                shift = res = 0
                while True:
                    b = ord(s[i]) - 63; i += 1; res |= (b & 0x1F) << shift; shift += 5
                    if b < 0x20: break
                d = ~(res >> 1) if res & 1 else res >> 1
                if which == 0: lat += d
                else: lon += d
            out.append([lon / 1e6, lat / 1e6])
    return out, trip["summary"]["length"]


def overpass_lines(query):
    req = urllib.request.Request("https://overpass-api.de/api/interpreter",
                                 data=urllib.parse.urlencode({"data": query}).encode(),
                                 headers={"User-Agent": "obvoz importer"})
    data = json.loads(urllib.request.urlopen(req, timeout=180).read())
    nodes = {e["id"]: [e["lon"], e["lat"]] for e in data["elements"] if e["type"] == "node"}
    return [(e.get("tags", {}).get("name", ""), [nodes[n] for n in e["nodes"] if n in nodes])
            for e in data["elements"] if e["type"] == "way"]


def main():
    feats = []

    # --- zaključni krog ---
    circ = gpx_points(get(f"{UP}/{CIRCUIT_GPX}"))
    ccum = cumulative(circ)
    for day, (t0, t1, note) in CIRCUIT_DAYS.items():
        for k0, k1, seg in chunks(circ, ccum, 0, ccum[-1] / 1000, 2.0):
            feats.append(closure(f"Zaključni krog Šenčur–Možjanca–Cerklje, km {k0:.0f}–{k1:.0f}",
                                 f"Popolna zapora v času tekmovanj ({note}).", seg, f"{day}T{t0}", f"{day}T{t1}"))
    for name, k0, k1, s, e in LONG_TERM:
        seg = slice_km(circ, ccum, k0, k1)
        feats.append(closure(name, "Popolna zapora ves čas prvenstva.", seg, s, e))

    # --- dirke iz Ljubljane ---
    for race in LINE_RACES:
        pts = gpx_points(get(f"{UP}/{race['gpx']}"))
        cum = cumulative(pts); L = cum[-1] / 1000
        # kje proga prvič pride na krog (prva točka v ~100 m mreži kroga po vsaj 50 km)
        cgrid = {(round(x, 3), round(y, 3)) for x, y in circ}
        entry = next(c / 1000 for p, c in zip(pts, cum)
                     if c > 50000 and (round(p[0], 3), round(p[1], 3)) in cgrid)
        start = at(race["date"], race["start"])

        if race["cas"]:
            rows = timetable(race["cas"])
            total = next(r[0] for r in rows if "OFFICIAL" in r[4].upper())
            neutral = [r for r in rows if r[0] > total + 0.05]
            line = [r for r in rows if r[0] <= total + 0.05]
            scale = L / total

            def times_at(s_km):  # s_km na GPX → (prvi, zadnji, kraj)
                tf = total - s_km / scale
                for a, b in zip(line, line[1:]):
                    if a[0] >= tf >= b[0]:
                        f = (a[0] - tf) / ((a[0] - b[0]) or 1)
                        ta_f, tb_f = at(race["date"], a[2]), at(race["date"], b[2])
                        ta_s, tb_s = at(race["date"], a[1]), at(race["date"], b[1])
                        return ta_f + (tb_f - ta_f) * f, ta_s + (tb_s - ta_s) * f, a[3]
                r = line[-1]; return at(race["date"], r[2]), at(race["date"], r[1]), r[3]
            neutral_end_fast = at(race["date"], line[0][2])
        else:
            slow, fast = race["speeds"]
            off = start + timedelta(hours=race["neutral_km"] / 25)   # nevtralno ~25 km/h

            def times_at(s_km):
                return off + timedelta(hours=s_km / fast), off + timedelta(hours=s_km / slow), ""
            neutral_end_fast = off

        for k0, k1, seg in chunks(pts, cum, 0, entry, 1.0):
            f0, _, place = times_at(k0)
            _, s1, _ = times_at(k1)
            feats.append(closure(f"{race['name']}: km {k0:.0f}–{k1:.0f}{' (' + place + ')' if place else ''}",
                                 "Kratkotrajna zapora ob prehodu kolesarjev (policija, do ~30 min). Čas iz uradne časovnice."
                                 if race["cas"] else "Kratkotrajna zapora ob prehodu kolesarjev. Čas ocenjen iz hitrosti.",
                                 seg, fmt(f0 - BEFORE), fmt(s1 + AFTER)))

        # nevtralni del: Kongresni trg → Šentvid (geometrija iz OSM po uradnem opisu)
        wps = [geocode(q) for q in NEUTRAL_WAYPOINTS] + [pts[0]]
        nline, nkm = valhalla_line(wps)
        feats.append(closure(f"{race['name']}: nevtralni del Kongresni trg–Šentvid",
                             f"Spremljana vožnja po Ljubljani (~{nkm:.1f} km).", nline,
                             fmt(start - timedelta(minutes=20)), fmt(neutral_end_fast + AFTER)))

    # --- startni prostor v Ljubljani ---
    ways = overpass_lines('[out:json];'
                          'way(46.040,14.490,46.060,14.515)["highway"~"^(primary|secondary|tertiary|residential|unclassified|living_street|pedestrian)$"]["name"~"^(Slovenska cesta|Igriška ulica|Erjavčeva cesta|Aškerčeva cesta|Šubičeva ulica)$"];'
                          '(._;>;);out body qt;')
    def lat_of(name):  # zemljepisna širina križišča s Slovensko
        sl = {tuple(p) for n, c in ways if n == "Slovenska cesta" for p in c}
        hits = [p[1] for n, c in ways if n == name for p in c if tuple(p) in sl]
        return sum(hits) / len(hits)
    lo, hi = sorted([lat_of("Aškerčeva cesta"), lat_of("Šubičeva ulica")])
    start_lines = [c for n, c in ways if n in ("Igriška ulica", "Erjavčeva cesta")]
    start_lines += [s for s in ([p for p in c if lo - 1e-5 <= p[1] <= hi + 1e-5] for n, c in ways if n == "Slovenska cesta") if len(s) >= 2]
    for day, (t0, t1) in LJ_START.items():
        for c in start_lines:
            feats.append(closure("Startni prostor Ljubljana (Slovenska/Igriška/Erjavčeva)",
                                 "Popolna zapora ob startu dirk.", c, f"{day}T{t0}", f"{day}T{t1}"))

    lons = [p[0] for f in feats for p in f["geometry"]["coordinates"]]
    lats = [p[1] for f in feats for p in f["geometry"]["coordinates"]]
    event = {
        "type": "FeatureCollection",
        "event": {"id": EVENT_ID, "name": "EP v cestnem kolesarstvu 2026", "timezone": "Europe/Ljubljana",
                  "days": [f"2026-10-0{d}" for d in range(2, 8)], "defaultTime": "2026-10-03T14:30",
                  "center": [(min(lons) + max(lons)) / 2, (min(lats) + max(lats)) / 2], "zoom": 11,
                  "source": "https://roadslovenia2026.si/zapore-in-parkirisca/"},
        "features": feats,
    }
    out = ROOT / "events" / f"{EVENT_ID}.geojson"
    out.write_text(json.dumps(event, ensure_ascii=False, indent=1))
    idx_path = ROOT / "events" / "index.json"
    idx = [e for e in json.loads(idx_path.read_text()) if e["id"] != EVENT_ID]
    idx.append({"id": EVENT_ID, "name": event["event"]["name"]})
    idx_path.write_text(json.dumps(idx, ensure_ascii=False, indent=1))
    print(f"{out.name}: {len(feats)} odsekov zapor")


if __name__ == "__main__":
    main()
