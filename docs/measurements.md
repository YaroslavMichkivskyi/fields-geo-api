# Measuring fields: which area is right

Coordinates are stored in WGS 84 degrees (SRID 4326). A degree is not a fixed
length: a degree of latitude is ~111 km everywhere, a degree of longitude is
~111 km × cos(latitude) — ~72 km in Poltava. So an area needs either the
spheroid (`geography`) or a projection into metres.

Same polygons, measured six ways (`npm run compare:area`, PostGIS 3.5, PROJ 7.2,
Turf 7). The reference is `ST_Area(geom::geography)` — the WGS 84 spheroid.

| polygon | spheroid (ha) | sphere | Turf | UTM 35N | UTM 36N | Web Mercator | ST_Area(geometry) |
|---|---|---|---|---|---|---|---|
| Poltava, 0.01° square | **80.4088** | 80.2291 (-0.22%) | 80.1440 (-0.33%) | 80.9339 (0.65%) | 80.3694 (-0.05%) | 191.2 (137.76%) | 0.0001 "deg²" |
| Poltava, ~10 x 10 km | **10033.1040** | 10010.6905 (-0.22%) | 10000.1868 (-0.33%) | 10097.1135 (0.64%) | 10027.8626 (-0.05%) | 23806.2 (137.28%) | 0.012465 "deg²" |
| Lviv, 0.01° square | **80.0659** | 79.8870 (-0.22%) | 79.7984 (-0.33%) | 80.0932 (0.03%) | 80.8271 (0.95%) | 192.0 (139.81%) | 0.0001 "deg²" |
| Odesa, 0.01° square | **85.4772** | 85.2863 (-0.22%) | 85.2591 (-0.26%) | 85.5793 (0.12%) | 85.4742 (-0.00%) | 179.7 (110.24%) | 0.0001 "deg²" |

## What it shows

- **`ST_Area(geometry)` in SRID 4326 is meaningless** — square degrees. Every
  0.01° square is "0.0001", although the real areas differ by 7 % between
  Lviv and Odesa (meridians converge to the north).
- **Web Mercator (EPSG:3857) more than doubles the area** at 46–50° N: it
  stretches both axes by 1 / cos(latitude). Fine for drawing map tiles,
  never for measuring.
- **A sphere** (`geography` with `use_spheroid = false`) is ~0.2 % low: the
  Earth is flattened, the sphere is not.
- **Turf** measures on a sphere too, ~0.3 % low. Good enough for a live preview
  while the user draws, not for the number that goes into a contract.
- **UTM** is a metric projection that is accurate inside its own 6° zone and
  degrades outside it: Poltava (34.5° E) is in zone 36N (30–36° E) — -0.05 %;
  measured in zone 35N it is +0.65 %. Lviv (24° E) is the other way round.
  A projection must match the region.

## What the API uses

- `area_ha` — `round(ST_Area(geom::geography) / 10000, 4)`, a STORED generated
  column: computed by Postgres on every write, never stale, sortable and
  indexable.
- `perimeterM` — `ST_Perimeter(geom::geography)`, computed on read.
- `labelPoint` — `ST_PointOnSurface(geom)`, not `ST_Centroid`: the centroid of a
  concave ("C"-shaped) field can fall outside it, where a label would mark the
  neighbour's land.

Use a UTM zone instead of `geography` when an operation is only planar
(buffers, offsets in metres) and the data stays inside one zone — it is faster
and exact enough there.
