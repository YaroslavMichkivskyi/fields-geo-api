# fields-geo-api

Spatial backend for an agritech platform: farm fields as polygons, soil samples
as points, rivers as lines. It accepts and returns **GeoJSON** (RFC 7946) and
does all spatial work in **PostgreSQL + PostGIS**: validation and repair of
drawn boundaries, areas in hectares, viewport queries for the map, overlap
detection between fields, proximity search, point-in-field joins, buffer
zones and bulk import.

> Status: in progress — see [Roadmap](#roadmap).

## Goal

A practice project to refresh three technologies end to end on one realistic domain:

- **PostGIS** — spatial types, indexes and functions (`ST_*`) in PostgreSQL;
- **GeoJSON** — the exchange format between the map client and the API;
- **NestJS on Fastify** — the HTTP layer, instead of the default Express adapter.

Every milestone is a working endpoint with tests, plus notes on the queries
and their plans in `docs/`.

## Stack

| | |
|---|---|
| API | NestJS on **Fastify** (`@nestjs/platform-fastify`), TypeScript |
| Database | PostgreSQL 17 + PostGIS 3.5 (Docker image `postgis/postgis`) |
| Data access | TypeORM (migrations, connection) + hand-written parameterised SQL for spatial queries |
| GeoJSON tooling | `@turf/turf` (client-side checks, cross-checking PostGIS results), Zod (input schemas) |
| Tests | Jest, `app.inject()` (Fastify) against a real PostGIS test database |

## Data model

```
organizations (id, name)
fields        (id, org_id → organizations, name, crop, season,
               geom geometry(MultiPolygon, 4326),        -- GiST index
               area_ha numeric GENERATED (ST_Area(geom::geography) / 10000))
soil_samples  (id, org_id, taken_at, ph, humus, geom geometry(Point, 4326))
warehouses    (id, org_id, name, geom geometry(Point, 4326))
water_bodies  (id, name, geom geometry(LineString, 4326))  -- rivers / canals
```

All geometries are stored in WGS 84 (SRID 4326), the coordinate system of
GeoJSON. Distances and areas are computed on the spheroid (`geography`) or in
a metric projection (UTM 35N / 36N for Ukraine) where a planar operation is needed.

## API

| Method | Path | What |
|---|---|---|
| `POST` | `/fields` | create a field from a GeoJSON Feature (Polygon / MultiPolygon); validates, repairs or rejects invalid rings, warns about overlaps |
| `GET` | `/fields?bbox=minLng,minLat,maxLng,maxLat&zoom=` | FeatureCollection of fields in the map viewport, simplified for the zoom level |
| `GET` | `/fields/:id` | one field as a Feature (area, perimeter, label point) |
| `GET` | `/fields/:id/overlaps` | fields of the same organisation overlapping this one, with the overlap geometry and area |
| `GET` | `/fields/near?lng=&lat=` or `?warehouse=` + `&radius_km=` / `&limit=` | fields within a radius / the N nearest, with distances in metres |
| `POST` | `/warehouses` | a warehouse from a GeoJSON Feature (Point) |
| `GET` | `/fields/extent` | bounding box of all fields of the organisation ("zoom to my fields") |
| `GET` | `/fields/overlaps` | every overlapping pair of fields of the organisation once, biggest overlap first |
| `POST` | `/soil-samples` | batch of sample points; each is assigned to the field that covers it |
| `GET` | `/fields/:id/soil-stats` | aggregates of the samples inside a field |
| `GET` | `/soil-samples/unassigned` | samples that fell in no field, with the nearest field and the distance to it |
| `GET` | `/fields/:id/water-zones?buffer_m=50` | part of the field inside the protection zone of nearby water and the remaining sprayable area |
| `POST` | `/water-bodies` | a river / stream / canal as a GeoJSON line, with its size class (reference data) |
| `POST` | `/fields/import` | bulk import of a FeatureCollection with per-feature errors |
| `GET` | `/tiles/:z/:x/:y.mvt` | Mapbox Vector Tiles of fields (`ST_AsMVT`) |

The organisation is taken from the `x-org-id` header; every query is scoped to it.
A field of another organisation answers 404, not 403, so its existence does not leak.

Input is validated before it reaches the database: a Feature with a Polygon or
MultiPolygon, `[longitude, latitude]` positions within range, closed rings of
at least 4 positions, no legacy `crs` member, and every position inside the
service area (Ukraine) — which catches the classic `[lat, lng]` swap.
Boundaries are stored as `MultiPolygon` and returned with 6 decimals (~11 cm).

Then PostGIS checks the geometry itself (`BoundaryService`, one query):
repeated points are dropped, a self-intersecting outline (a "bow tie", a spike)
is repaired with `ST_MakeValid` into the parts it encloses, rings are turned
counter-clockwise (RFC 7946), and the answer lists what was changed in
`warnings`. A hole outside its shell, an outline that encloses nothing and a
field under 100 m² are rejected with 422 — repairing those would invent land.
A `CHECK (ST_IsValid(geom))` constraint keeps invalid boundaries out of the
table whatever writes to it.

Every Feature carries its measurements in `properties`: `areaHa` (a stored
generated column, measured on the WGS 84 spheroid), `perimeterM` and
`labelPoint` (a point guaranteed inside the field, for the map label).
Why the spheroid and not degrees, Web Mercator or Turf:
[docs/measurements.md](docs/measurements.md).

The map asks for its viewport: `GET /fields?bbox=…&zoom=…` returns the fields
whose bounding box overlaps the screen (`&&`, answered from the GiST index),
with boundaries simplified to half a screen pixel for the zoom level
(`ST_SimplifyPreserveTopology`); measurements still describe the real
boundary. At most 5 000 Features per answer, `truncated: true` when cut off.
Plans and response sizes on 50 000 seeded fields:
[docs/explain.md](docs/explain.md).
Two fields overlap when their interiors share land: `ST_Intersects AND NOT
ST_Touches` (neighbours along a common boundary do not count), and the overlap
is larger than GPS noise — over 10 m² and over 0.5 % of the smaller field. A
`POST` answer lists the existing fields the new one overlaps (`overlaps`, a
warning, not an error); `GET /fields/:id/overlaps` returns each overlap as a
MultiPolygon with its area and share of both fields; `GET /fields/overlaps`
is the organisation-wide report (a spatial self-join). Why the database does
not forbid overlaps: [docs/explain.md](docs/explain.md#why-not-forbid-overlaps-in-the-database).

`GET /fields/near` measures from a point or a warehouse to the nearest edge
of each field, in metres on the spheroid (0 when the point is inside):
`radius_km` gives every field within it (`ST_DWithin`), `limit` the N nearest
(KNN, `<->` walking the index), both together the N nearest within the radius.
Both are answered from a GiST index on `geom::geography`; why that and not
`ST_Distance < r`, nor a second geography column:
[docs/explain.md](docs/explain.md#proximity-within-a-radius-the-n-nearest).

Soil samples arrive as a FeatureCollection of Points (date, pH, humus) and are
stored in one statement: the batch travels as one JSON parameter, and every
point is placed in the field that covers it (`ST_Covers`, so a sample on the
boundary still counts; a field with the point strictly inside wins over one
that only touches it). A field drawn later adopts the samples taken inside it
before; samples in no field are listed with the nearest field and how far
outside they are. Plan of the point-in-polygon join:
[docs/explain.md](docs/explain.md#point-in-polygon-placing-soil-samples-in-fields).

No pesticides may be sprayed within the protection strip of water (Water Code
of Ukraine, art. 88: 25 m along small rivers, 50 m medium, 100 m large).
`GET /fields/:id/water-zones` buffers nearby rivers in metres
(`ST_Buffer` on geography), unites the strips and splits the field into the
restricted part (`ST_Intersection`) and the sprayable rest (`ST_Difference`),
as map layers with their areas. `buffer_m` overrides the width. Why the buffer
is never done in degrees:
[docs/explain.md](docs/explain.md#water-protection-zones-buffer-intersection-difference).

`POST /fields/import` takes a FeatureCollection of up to 5 000 fields (KML /
Shapefile converted with `ogr2ogr`) and answers with a line per Feature: what
was imported, what was repaired, and for the rest the index, the name and the
reason. `mode=partial` (default) stores every valid Feature; `mode=atomic`
stores nothing if anything is wrong. Whatever the size of the file it is a
fixed number of queries — one check of all boundaries, one INSERT, one UPDATE
for the soil samples the new fields adopt. Conversion commands, the choice
between the modes and timings: [docs/import.md](docs/import.md).

Responses use `application/geo+json`; requests may use it or `application/json`.

```bash
curl -X POST localhost:3000/fields \
  -H 'x-org-id: 00000000-0000-0000-0000-000000000001' \
  -H 'content-type: application/geo+json' \
  -d '{"type":"Feature","properties":{"name":"North field","crop":"wheat"},
       "geometry":{"type":"Polygon","coordinates":[[[34.55,49.59],[34.559,49.59],
       [34.559,49.5935],[34.55,49.5935],[34.55,49.59]]]}}'
```

The id above is the "Demo farm" organisation created by the migrations.

## Running locally

```bash
cp .env.example .env          # connection settings (Windows cmd: copy .env.example .env)
docker compose up -d --wait   # PostGIS on localhost:5433 (dev + test databases)
npm install
npm run migration:run         # enables the postgis extension, then the schema
npm run start:dev             # http://localhost:3000/health
npm test                      # migrates the test database, then e2e tests (Fastify inject)
```

```bash
npm run seed                  # 50 000 synthetic fields around the Poltava region (Demo farm)
npm run explain:viewport      # EXPLAIN ANALYZE of the viewport query, with / without the index
npm run explain:near          # radius and nearest-N queries, written several ways
npm run compare:area          # one area measured six ways
npm run migration:revert      # undo the last migration
```

## Project structure

```
src/
  geo/          GeoJSON schemas (Zod), coordinate checks, SQL helpers
  fields/       controller, service, repository (spatial SQL)
  soil/         soil samples and the point-in-field join
  water/        water bodies and buffer zones
  tiles/        vector tiles
  database/     data source, migrations, seed
test/           e2e tests (Fastify inject)
docs/           query notes, EXPLAIN plans
```

## Roadmap

- [x] M0 — project skeleton: NestJS + Fastify, Docker PostGIS, TypeORM migrations
- [x] M1 — GeoJSON in / out: `fields` table, create and read Features and FeatureCollections
- [x] M2 — geometry validation and repair (`ST_IsValid`, `ST_MakeValid`)
- [x] M3 — measurements: area, perimeter, label point; geometry vs geography
- [x] M4 — viewport queries, GiST index, simplification by zoom, extent
- [x] M5 — overlap detection between fields
- [x] M6 — proximity: radius search and nearest-N (KNN)
- [x] M7 — soil samples: point-in-polygon join and stats
- [x] M8 — water protection zones: buffers, intersection, difference
- [x] M9 — bulk import of a FeatureCollection
- [ ] M10 — vector tiles (`ST_AsMVT`)
