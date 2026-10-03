# Obvoz – načrtovalec poti mimo zapor cest

Statična spletna stran (brez strežnika, brez ključev). Lokalno:

```bash
python3 -m http.server 8140 --directory obvoz
```

## Kako deluje

- **Usmerjanje:** javni Valhalla (`valhalla1.openstreetmap.de`, FOSSGIS, brezplačno, fair-use).
- **Zapore:** pot se izračuna, nato se preveri, kje seka ali vozi po zapori, ki je aktivna
  med odhodom in prihodom. Tam se dodajo `exclude_locations` (oz. majhni `exclude_polygons`)
  in pot se izračuna znova (`routing.js`). To je potrebno, ker javni strežnik dovoli le
  50 točk / 10 km obsega / 100 oglišč, zapor pa je lahko 50+ km.
- **Prehodi** (`kind: crossing`) so med zaporo prehodni (z opozorilom o čakanju).
- Če poti ni (npr. start znotraj zaprte zanke), predlaga prvi kasnejši odhod, ko se zapora odpre.
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

## Za produkcijo

Pri večjem prometu javni Valhalla ni primeren (fair-use). Lasten Valhalla v Dockerju
(OSM izvleček Slovenije z Geofabrika) – v `valhalla.json` dvigni `service_limits`
za `exclude_polygons` in v `routing.js` spremeni `VALHALLA_URL` ter omejitve.
