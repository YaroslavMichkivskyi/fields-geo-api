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
