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
