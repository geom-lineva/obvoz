# Obvoz – načrtovalec poti mimo zapor cest

Statična spletna stran (brez strežnika, brez ključev). Lokalno:

```bash
python3 -m http.server 8140 --directory obvoz
```

## Kako deluje

- **Usmerjanje teče v brskalniku** po cestnem omrežju OpenStreetMap (`events/<id>.graph.json`,
  zgradi ga `scripts/build_graph.py`). Brez zunanjega usmerjevalnika, brez omejitev, ~50 ms na pot.
- **Zapore so časovne:** odsek je neprevozen le, če je zaprt ob uri, ko bi do njega prišli
  (časovno odvisen A*, `graph.js`). Odsek šteje za zaprt, če seka zaporo ali je od nje < 12 m.
- **Prehodi** (`kind: crossing`) so med zaporo prevozni s pribitkom 5 min za čakanje
  (prikaz: +20 min zgornja meja). Z »Izogni se prehodom« se jim pot izogne, če gre.
- Če poti ni (start/cilj v zaprti zanki ali na zaprti cesti), predlaga prvi kasnejši odhod.
- Omejitve: zavijalne prepovedi (turn restrictions) niso upoštevane; časi vožnje so ocena
  (omejitev hitrosti × 0,8), brez prometa.
- **Iskanje naslovov:** Photon (komoot). **Karta:** OpenStreetMap.

## Format dogodka (`events/<id>.geojson`)

```jsonc
{
  "type": "FeatureCollection",
  "event": { "id": "...", "name": "...", "timezone": "Europe/Ljubljana",
             "days": ["2026-10-18"], "defaultTime": "2026-10-18T10:00",
             "center": [lon, lat], "zoom": 13, "source": "https://..." },
  "features": [
    { "type": "Feature", "geometry": { "type": "LineString", "coordinates": [[lon, lat], ...] },
      "properties": { "kind": "closure", "name": "Dunajska cesta", "note": "med X in Y",
                      "start": "2026-10-18T08:45", "end": "2026-10-18T15:00" } },
    { "type": "Feature", "geometry": { "type": "Point", "coordinates": [lon, lat] },
      "properties": { "kind": "crossing", "name": "...", "start": "...", "end": "..." } }
  ]
}
```

Časi so lokalni (brez časovnega pasu). Dogodek dodaš še v `events/index.json`.

## Novi dogodki

| Vir podatkov | Orodje |
|---|---|
| Ljubljanski maraton (zemljevid na njihovi strani) | `python3 scripts/import_ljm.py` |
| GPX trase + start + hitrosti (kolesarske dirke, teki brez časovnice) | `python3 scripts/gpx_rolling_closure.py trasa.gpx --id ... --name ... --start 2026-10-04T12:00 --fast 48 --slow 38` |
| Ročno risanje | geojson.io → izvozi LineString-e, dodaj `kind/start/end` |

Po vsakem novem dogodku zgradi še cestno omrežje: `python3 scripts/build_graph.py <id>`.

## Za produkcijo

Graf za Ljubljano je ~5,7 MB (~2 MB stisnjeno). Za večja območja (npr. kolesarska dirka čez
pol Slovenije) ga zmanjšaj: odstrani pešpoti, poenostavi geometrijo ali razdeli na ploščice.
