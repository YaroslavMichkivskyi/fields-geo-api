# Viewport query: with and without the spatial index

`npm run seed` (50 000 round fields of 7–110 ha across the Poltava region,
65 vertices each), then `npm run explain:viewport`. PostgreSQL 17, PostGIS 3.5,
everything in shared buffers (warm cache). The long hex literal of the
envelope is shortened to `<box>` below.

```sql
SELECT f.id
  FROM fields f
 WHERE f.org_id = $1
   AND f.geom && ST_MakeEnvelope($2, $3, $4, $5, 4326)
```

## A town-sized viewport (~6 x 6 km): 37 of 50 000 fields

Without the GiST index — every row is read and tested:

```
Seq Scan on fields f (actual time=0.148..5.357 rows=37 loops=1)
  Filter: ((geom && '<box>'::geometry) AND (org_id = '…0001'::uuid))
  Rows Removed by Filter: 49963
  Buffers: shared hit=8334
Execution Time: 5.366 ms
```

With `fields_geom_gist`:

```
Bitmap Heap Scan on fields f (actual time=0.027..0.056 rows=37 loops=1)
  Recheck Cond: (geom && '<box>'::geometry)
  Filter: (org_id = '…0001'::uuid)
  Heap Blocks: exact=37
  Buffers: shared hit=39
  ->  Bitmap Index Scan on fields_geom_gist (actual time=0.020..0.020 rows=37 loops=1)
        Index Cond: (geom && '<box>'::geometry)
        Buffers: shared hit=2
Execution Time: 0.074 ms
```

**72× faster, 8 334 → 39 pages read.** The index walk itself touched 2 pages
and found the 37 candidates; then only their 37 table pages were read.

- **Bitmap Index Scan** — walks the R-tree of bounding boxes and collects the
  addresses of matching rows into a bitmap;
- **Bitmap Heap Scan** — reads those table pages in physical order;
- **Recheck Cond** — GiST is a *lossy* index (it stores boxes, not shapes), so
  rows are checked again; for `&&` the recheck is the same box test;
- **Filter: org_id** — applied to the 37 rows only. All 50 000 seeded rows
  belong to one organisation, so the btree on `org_id` would not narrow
  anything and the planner rightly ignores it.

## The whole region: all 50 000 fields match

With or without the index the plan is the same:

```
Seq Scan on fields f (actual time=0.005..6.398 rows=50000 loops=1)
  Filter: ((geom && '<box>'::geometry) AND (org_id = '…0001'::uuid))
  Buffers: shared hit=8334
Execution Time: 7.626 ms
```

The planner knows from the statistics (`ANALYZE`) that the box covers every
row, and reading the table straight through is cheaper than walking an index
to visit every page anyway. An index pays off only for a selective condition —
which a map viewport usually is.

## The whole endpoint

`GET /fields?bbox=…&zoom=…` on the same data (response size, vertices sent):

| viewport | zoom | features | vertices | response |
|---|---|---|---|---|
| ~6 x 6 km | — | 37 | 2 405 | 64 KB |
| ~6 x 6 km | 13 | 37 | 907 | 31 KB |
| ~110 x 110 km | — | 5 000 (truncated) | 325 000 | 8.6 MB |
| ~110 x 110 km | 9 | 5 000 (truncated) | 32 381 | 2.2 MB |
| whole region | 7 | 5 000 (truncated) | 25 000 | 2.1 MB |

`ST_SimplifyPreserveTopology` with a half-pixel tolerance drops what cannot be
seen at that zoom: 10× fewer vertices at zoom 9, every field still present as
a closed ring (at zoom 7 each field is down to 5 vertices). Beyond a few
thousand fields GeoJSON is the wrong format whatever the simplification — that
is what vector tiles are for (M10).

# Overlap report: a spatial self-join

`GET /fields/overlaps` joins `fields` to itself: every pair (a, b) of one
organisation whose interiors overlap, each pair once (`a.id < b.id`). On the
same 50 000 seeded circles (random centres, so many of them overlap):

```sql
SELECT count(*)
  FROM fields a
  JOIN fields b ON b.org_id = a.org_id AND a.id < b.id
   AND ST_Intersects(a.geom, b.geom) AND NOT ST_Touches(a.geom, b.geom)
 WHERE a.org_id = $1
```

```
Nested Loop (actual time=161.337..861.462 rows=14136 loops=3)
  ->  Parallel Seq Scan on fields a (rows=16667 loops=3)
  ->  Index Scan using fields_geom_gist on fields b (actual time=0.031..0.041 rows=1 loops=50000)
        Index Cond: (geom && a.geom)
        Filter: (org_id = … AND (a.id < id) AND st_intersects(a.geom, geom) AND (NOT st_touches(a.geom, geom)))
        Rows Removed by Filter: 2
Execution Time: 1117.832 ms
```

- **Nested Loop + Index Scan** — for each of the 50 000 fields a, the GiST
  index finds the few fields b whose boxes touch a's box (`Index Cond: geom && a.geom`
  — `ST_Intersects` adds that box test by itself, which is why it can use the index).
  Without the index this would be 50 000 × 50 000 = 2.5 · 10⁹ exact tests.
- **Filter** — the exact tests run only on those candidates: ~3 per field.
  `a.id < b.id` throws away half of them: (A, B) and (B, A) are one pair, and
  (A, A) is not a pair at all.
- **Parallel** — 2 workers split the outer scan.

42 409 pairs share interior points; computing `ST_Intersection` and its area
for each and applying the noise thresholds (> 10 m² and > 0.5 % of the
smaller field) leaves 40 714 real overlaps, the whole query 3.3 s. The
intersection, not the join, is the expensive part — so the report is capped at
5 000 pairs, biggest first, with `truncated`. For a real organisation (hundreds
of fields, few overlaps) it is milliseconds.

## Why not forbid overlaps in the database

`EXCLUDE USING gist (org_id WITH =, geom WITH &&)` (with `btree_gist`) is the
natural tool for "no two rows may overlap" — but an exclusion constraint
compares with an *operator*, and the only spatial one GiST supports there is
`&&`, the box test. It would reject two neighbouring fields whose boxes
overlap while the fields only share a boundary — nearly every pair of
neighbours. Exact rules (`ST_Overlaps`, an area threshold) need a trigger,
which costs every insert a query and still races between concurrent
transactions unless the table is locked. And an overlap is often a fact to
resolve with people (two farms claim the same land, a lease changed hands),
not an input error — so the API warns (`overlaps` in the `POST` answer) and
reports, and does not refuse.

# Proximity: within a radius, the N nearest

`npm run explain:near` on the 50 000 seeded fields: a point in Poltava
(34.55, 49.59), radius 5 km — 72 fields. The long hex literal of the point is
shortened to `<point>`.

| query | plan | rows read | time |
|---|---|---|---|
| `ST_Distance(geom::geography, p) < 5000` | Parallel Seq Scan | 50 000 | 712 ms |
| `ST_DWithin(geom::geography, p, 5000)`, only the GiST on `geom` | Parallel Seq Scan | 50 000 | 766 ms |
| `ST_DWithin(geom::geography, p, 5000)` + index on `(geom::geography)` | Bitmap Index Scan | 145 | **5.8 ms** |
| the same on a stored `geog` column + its index | Bitmap Index Scan | 145 | 4.8 ms |
| `ORDER BY geom::geography <-> p LIMIT 5` | Index Scan, `Order By` | 5 | **0.3 ms** |

**`ST_Distance < r` never uses an index.** It is a function computed for a
row and then compared: the planner sees an arbitrary expression. `ST_DWithin`
is written so that PostGIS adds an index condition of its own:

```
Index Cond: ((geom)::geography && _st_expand('<point>'::geography, '5000'::double precision))
Filter:     st_dwithin((geom)::geography, '<point>'::geography, '5000'::double precision, true)
```

The point's box grown by 5 km (`_st_expand`) is tested against the boxes in
the index (145 candidates), then the exact distance runs on those only
(72 kept, `Rows Removed by Filter: 73`).

**An index serves one expression.** The GiST index on `geom` stays unused
by `ST_DWithin(geom::geography, …)`: the query tests a different expression
(`geom::geography`) and a different operator class (geography, on the
sphere). Two ways to give it an index:

| | table | geography index |
|---|---|---|
| expression index | 65 MB | 3560 kB |
| stored column + index | 131 MB | 3520 kB |

- **expression index** `CREATE INDEX … USING GIST ((geom::geography))` — the
  index is the same size, the table is unchanged; the query must spell the
  expression exactly as the index does, and the cast runs again for each
  candidate row (the 1 ms difference above);
- **stored column** `geog geography GENERATED ALWAYS AS (geom::geography) STORED`
  — no cast at query time, simpler queries, but every boundary is stored
  twice: the table doubles, and so do backup, replication and cache
  pressure.

The API takes the expression index: 1 ms per query is not worth 65 MB of
duplicate data per 50 000 fields.

**KNN** — `ORDER BY a <-> b LIMIT n` is answered by walking the GiST tree
nearest box first (`Order By` in the Index Scan): 11 pages read and the scan
stops after 5 rows, whatever the size of the table. It must be the
**geography** operator: `<->` on `geometry` in SRID 4326 measures degrees,
and here a degree of longitude is 72 km while a degree of latitude is 111 km —
`test/near.e2e-spec.ts` has a field 3.6 km east (0.05°) that geometry KNN
ranks behind a field 4.4 km north (0.04°). Geography `<->` orders on the
sphere; the `distanceM` returned is `ST_Distance` on the spheroid (a few
tenths of a percent apart, never enough to reorder fields that matter).

# Point in polygon: placing soil samples in fields

`POST /soil-samples` places every point of the batch in the field that covers
it with a `LEFT JOIN LATERAL` — for each point, a subquery over `fields` that
may refer to that point. On the 50 000 seeded fields, 1 000 random points
across the region (372 of them land in a field):

```sql
SELECT pts.i, fld.id
  FROM pts
  LEFT JOIN LATERAL (
    SELECT f.id FROM fields f
     WHERE f.org_id = $1 AND ST_Covers(f.geom, pts.geom)
     ORDER BY ST_Contains(f.geom, pts.geom) DESC, f.created_at, f.id
     LIMIT 1) fld ON true
```

```
Nested Loop Left Join (actual time=19.399..158.890 rows=1000 loops=1)
  ->  Seq Scan on pts (rows=1000 loops=1)
  ->  Limit (actual time=0.140..0.140 rows=0 loops=1000)
        ->  Sort  Sort Key: (st_contains(f.geom, pts.geom)) DESC, f.created_at, f.id
              ->  Index Scan using fields_geom_gist on fields f (actual time=0.120..0.138 rows=0 loops=1000)
                    Index Cond: (geom ~ pts.geom)
                    Filter: ((org_id = …) AND st_covers(geom, pts.geom))
```

- `ST_Covers` adds its own index condition, `geom ~ point` — "the field's box
  contains the point" (`~` is the box-contains operator). The GiST index answers
  it for each of the 1 000 points: ~0.14 ms per point, 2 885 pages for the whole
  batch. Without the index it would be 1 000 × 50 000 exact tests.
- `LEFT JOIN` keeps the points that fall in no field (`fld.id` is NULL);
  `LIMIT 1` + `ORDER BY` picks one field when a point is covered by two — on a
  shared boundary or where fields overlap: one that has the point strictly
  inside (`ST_Contains`) wins over one that only has it on its edge, then the
  oldest.

**`ST_Covers` vs `ST_Contains`.** Both ask "is the point in the polygon", and
differ only on the boundary: by DE-9IM, `Contains` needs the point to touch the
polygon's *interior*, so a point exactly on the edge is not contained; `Covers`
only needs it not to be outside. A sample is often taken on the track along
the edge of a field — with `Contains` it would be lost.

The field of a sample is stored (`soil_samples.field_id`), not recomputed on
read: stats are a `GROUP BY` on an indexed column. When a field is drawn later
around old samples, the same test runs the other way — `UPDATE soil_samples …
FROM fields … WHERE ST_Covers(f.geom, s.geom) AND s.field_id IS NULL` — in the
transaction that inserts the field, over a partial GiST index that holds only
the samples still without a field.

# Water protection zones: buffer, intersection, difference

`GET /fields/:id/water-zones` splits a field into the part inside the
protection strips of nearby rivers (no pesticides — Water Code of Ukraine,
art. 88: 25 m for small rivers, 50 m medium, 100 m large) and the sprayable rest:

```sql
near AS (SELECT … FROM water_bodies w, f
          WHERE ST_DWithin(w.geom::geography, f.geom::geography, 100)),      -- the widest strip
zone AS (SELECT ST_Union(ST_Buffer(n.geom::geography, n.zone_m)::geometry) AS g
           FROM near n WHERE n.distance_m <= n.zone_m),
…  ST_Intersection(f.geom, zone.g)   -- under the strip
…  ST_Difference(f.geom, zone.g)     -- sprayable
```

With 500 temporary rivers across the seeded region (inserted and rolled back),
for a field a river crosses:

```
Index Scan using water_bodies_geog_gist on water_bodies w (actual time=6.422..6.588 rows=2 loops=1)
  Index Cond: ((geom)::geography && _st_expand((f_1.geom)::geography, '100'::double precision))
  Filter: (st_dwithin(…, '100'::double precision, true) AND (st_distance(…) <= (zone_m)::double precision))
Execution Time: 14.272 ms
```

- The search distance is a **constant** (100 m, or `buffer_m`): only then can
  `ST_DWithin` grow the field's box by it and ask the index. A per-row distance
  (`zone_m` of each river) is applied afterwards, on the two candidates.
- `ST_Buffer(geom::geography, 50)` is a strip of 50 **metres**: for geography
  PostGIS projects the line to a suitable planar system, buffers there and
  projects back. Checked against a hand calculation: a medium river 20 m from the
  edge takes 3.3351 ha off the field, 30 m × the 1 112 m edge = 3.3366 ha.
- `ST_Buffer(geom, 0.00045)` on geometry in 4326 buffers in **degrees**:
  0.00045° is 50.0 m to the north but 32.5 m to the east here (a degree of
  longitude is 72 km at this latitude, of latitude 111 km) — an ellipse, not a
  strip (`test/water.e2e-spec.ts`).
- Several rivers → `ST_Union` of their strips first, so where strips overlap
  the area is not subtracted twice.
- `ST_Difference` can split the field: a stream across the middle leaves a
  MultiPolygon of two sprayable pieces.

# Vector tiles: ST_TileEnvelope, ST_AsMVTGeom, ST_AsMVT

`GET /tiles/:z/:x/:y.mvt` returns a Mapbox Vector Tile: protobuf, geometry
already in the tile's own coordinates (0..4096), several layers, attributes
per feature. One query does all of it:

```sql
WITH b AS (SELECT ST_TileEnvelope($2, $3, $4) AS env,                                  -- the tile in Web Mercator
                  ST_Transform(ST_TileEnvelope($2, $3, $4, margin => 64.0/4096), 4326) AS q),  -- + buffer, in WGS 84
t AS (
  SELECT f.id, f.name, f.crop, f.season, f.area_ha::float8 AS "areaHa",
         ST_AsMVTGeom(ST_Transform(f.geom, 3857), b.env, 4096, 64, true) AS geom   -- clip + snap to the 4096 grid
    FROM fields f, b
   WHERE f.org_id = $1 AND f.geom && b.q)                                         -- the GiST index on geom
SELECT ST_AsMVT(t.*, 'fields', 4096, 'geom') FROM t WHERE t.geom IS NOT NULL       -- encode the layer
```

- **SRID 3857** (Web Mercator) is the projection of the tile pyramid;
  geometry is stored in 4326, so it is transformed per feature — but the
  filter compares the stored `geom` with the tile box turned into 4326, so
  the index is used (the edges of a Mercator tile are meridians and
  parallels, the box is exact in both systems).
- `ST_AsMVTGeom` clips to the tile plus a **buffer** of 64 units (the outline
  continues a little past the edge, so the stroke shows no seam where tiles
  meet) and snaps every vertex to the 4096 grid — that is the simplification;
  an outline that collapses below one cell comes back NULL and is dropped.
- MVT feature ids must be integers; the uuid travels as a property `id`.
- Empty tile → **204**; `Cache-Control: private, max-age=60` (tiles are per
  organisation and change when a field is drawn) and an **ETag**, so a map
  panning back revalidates with `If-None-Match` and gets 304.

## Polygons only from zoom 10; clusters below

One tile in the middle of the 50 000 seeded fields (`npm run explain:tiles`,
best of 3, the database alone):

| zoom | polygons: features | size | gzip | time | clusters: points | size | gzip | time |
|---|---|---|---|---|---|---|---|---|
| 6 | 24 802 | 3 170 KB | 1 360 KB | 534 ms | 167 | 5.0 KB | 2.2 KB | 246 ms |
| 7 | 23 830 | 3 611 KB | 1 459 KB | 561 ms | 663 | 18.7 KB | 7.2 KB | 244 ms |
| 8 | 10 135 | 1 682 KB | 696 KB | 320 ms | 1 029 | 28.2 KB | 10.8 KB | 112 ms |
| 9 | 2 603 | 456 KB | 201 KB | 107 ms | 916 | 24.4 KB | 9.3 KB | 27 ms |
| **10** | 668 | 122 KB | 60 KB | 41 ms | 463 | 12.2 KB | 4.6 KB | 9 ms |
| 11 | 186 | 36 KB | 21 KB | 12 ms | 142 | 3.9 KB | 1.6 KB | 4 ms |
| 12 | 50 | 9.6 KB | 7.0 KB | 4 ms | 41 | 1.1 KB | 0.6 KB | 2 ms |
| 14 | 6 | 1.3 KB | 1.2 KB | 1 ms | 5 | 177 B | 151 B | 1 ms |
| 16 | 4 | 478 B | 432 B | 0.9 ms | 1 | 64 B | 85 B | 1 ms |

A map shows ~12–20 tiles at once. At zoom 7 polygons would be 3.6 MB a tile
for fields two pixels wide — so from zoom 10 the tile carries the polygons
(layer `fields`), below it **clusters** (layer `clusters`): each field goes
to a cell of a 32 × 32 grid by its centroid (`ST_SnapToGrid` in metres of
3857), one point per cell with `count` and `areaHa`. The grid is anchored at
a cell corner and a tile is exactly 32 cells, so a field crossing a tile
edge is counted in exactly one tile (`test/tiles.e2e-spec.ts` sums the four
child tiles). At zoom 6–7 a cluster tile still reads ~24 000 fields (~250 ms):
for a farm that size the next step is a cache (tiles keyed by org + z/x/y,
dropped when a field changes) or a pre-aggregated table per region.

Plan of a zoom 14 tile — the GiST index, 6 rows, 0.36 ms:

```
Aggregate (actual time=0.329..0.330 rows=1 loops=1)
  ->  Index Scan using fields_geom_gist on fields f (actual time=0.063..0.188 rows=6 loops=1)
        Index Cond: (geom && '0103...'::geometry)
        Filter: ((org_id = '00000000-0000-0000-0000-000000000001'::uuid) AND (st_asmvtgeom(...) IS NOT NULL))
Execution Time: 0.356 ms
```

## GeoJSON or tiles

| | `GET /fields?bbox&zoom` (GeoJSON) | `GET /tiles/z/x/y.mvt` |
|---|---|---|
| unit | one answer per viewport | fixed grid of tiles, the same URLs for everybody panning there |
| caching | hardly: every viewport is a different bbox | per tile: browser, CDN, ETag |
| size | text coordinates; zoom 12, the 49 fields of one tile: 78 KB, 27 KB simplified for the zoom | binary, integer deltas on a 4096 grid: 9.6 KB (zoom 10: 1 026 / 249 KB vs 122 KB) |
| client | any code: features are data, editable, measurable | a renderer (MapLibre / Mapbox / OpenLayers); geometry is quantised and clipped at tile edges |
| fits | editing a field, a few hundred features, analysis, export | showing thousands – millions of features, smooth zoom |

The map shows tiles; when the user clicks a field to edit it, the client asks
`GET /fields/:id` for the exact GeoJSON outline — a tile's outline is cut at
the tile edge and rounded to the grid, it is not for editing or measuring.
