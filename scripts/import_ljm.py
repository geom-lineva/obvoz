#!/usr/bin/env python3
"""Uvoz zapor NLB Ljubljanskega maratona v splošni format dogodka Obvoz.

Vir: interaktivni zemljevid na strani »Časovnica zapor in prehodi«, ki ima
odseke (koordinate + ura začetka/konca) vgrajene v $.flVars.

    python3 scripts/import_ljm.py
"""
import json, math, re, urllib.request
from pathlib import Path

URL = ("https://ljubljanskimaraton.si/info-za-tekace/"
       "promet-parkiranja-prevozi-obvozi-zapore/casovnica-zapor-in-prehodi")
DAYS = {"sobota": "2026-10-17", "nedelja": "2026-10-18"}
EVENT_ID = "ljubljanski-maraton-2026"
ROOT = Path(__file__).resolve().parent.parent


def hhmm(date, x):
    h, m = divmod(int(x), 100)
    if h == 24:  # 24:00 -> naslednji dan 00:00 zapišemo kot 23:59
        h, m = 23, 59
    return f"{date}T{h:02d}:{m:02d}"


def length_m(c):
    k = math.cos(math.radians(46))
    return sum(math.hypot((b[0] - a[0]) * k * 111320, (b[1] - a[1]) * 110540)
               for a, b in zip(c, c[1:]))


def main():
    req = urllib.request.Request(URL, headers={"User-Agent": "Mozilla/5.0 (obvoz importer)"})
    html = urllib.request.urlopen(req, timeout=30).read().decode("utf8")
    data = json.loads(re.search(r"\$\.flVars = (\{.*?\});\s*\}\);", html, re.S).group(1))
    m = next(iter(data["map"].values()))

    feats = []
    for day, date in DAYS.items():
        for z in m["zapore"][day]:
            c = [[p["lng"], p["lat"]] for p in z["coordinates"]]
            feats.append({
                "type": "Feature",
                "properties": {
                    "kind": "closure",
                    "name": z["name"],
                    "note": re.split(r"<br", z["description"])[0].strip(),
                    "start": hhmm(date, z["timeStart"]),
                    "end": hhmm(date, z["timeEnd"]),
                    "length_m": round(length_m(c)),
                },
                "geometry": {"type": "LineString", "coordinates": c},
            })

    seen = set()
    for route in m["routes"].values():
        for p in route["points"]:
            if p[3] != "crossing" or p[0] in seen:
                continue
            seen.add(p[0])
            feats.append({
                "type": "Feature",
                "properties": {
                    "kind": "crossing",
                    "name": p[0],
                    "note": "Varovan prehod čez traso, čakanje do 20 min.",
                    "start": hhmm(DAYS["nedelja"], p[-2]),
                    "end": hhmm(DAYS["nedelja"], p[-1]),
                },
                "geometry": {"type": "Point", "coordinates": [p[2], p[1]]},
            })

    event = {
        "type": "FeatureCollection",
        "event": {
            "id": EVENT_ID,
            "name": "NLB Ljubljanski maraton 2026",
            "timezone": "Europe/Ljubljana",
            "days": list(DAYS.values()),
            "defaultTime": "2026-10-18T10:00",
            "center": [14.505, 46.058],
            "zoom": 13,
            "source": URL,
            "sourceVersion": m["kmlVersion"],
        },
        "features": feats,
    }
    out = ROOT / "events" / f"{EVENT_ID}.geojson"
    out.write_text(json.dumps(event, ensure_ascii=False, indent=1))
    n = sum(f["properties"]["kind"] == "closure" for f in feats)
    print(f"{out.name}: {n} zapor, {len(feats) - n} prehodov")


if __name__ == "__main__":
    main()
