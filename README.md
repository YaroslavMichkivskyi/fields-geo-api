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
| `GET` | `/fields/near?lng=&lat=&radius_km=` / `&limit=` | fields within a radius / the N nearest, with distances in metres |
| `GET` | `/fields/extent` | bounding box of all fields of the organisation ("zoom to my fields") |
| `POST` | `/soil-samples` | batch of sample points; each is assigned to the field that covers it |
| `GET` | `/fields/:id/soil-stats` | aggregates of the samples inside a field |
| `GET` | `/fields/:id/water-zones?buffer_m=50` | part of the field inside the protection zone of nearby water and the remaining sprayable area |
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

Seed data (synthetic fields, samples and rivers around the Poltava region)
arrives with M4 as `npm run seed`.

```bash
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
- [ ] M3 — measurements: area, perimeter, label point; geometry vs geography
- [ ] M4 — viewport queries, GiST index, simplification by zoom, extent
- [ ] M5 — overlap detection between fields
- [ ] M6 — proximity: radius search and nearest-N (KNN)
- [ ] M7 — soil samples: point-in-polygon join and stats
- [ ] M8 — water protection zones: buffers, intersection, difference
- [ ] M9 — bulk import of a FeatureCollection
- [ ] M10 — vector tiles (`ST_AsMVT`)
