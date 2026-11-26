# Bulk import of fields

`POST /fields/import` takes a GeoJSON FeatureCollection of up to 5 000 fields —
typically a farm moving from another system, or an export from a GIS desktop
tool — and answers with a line per Feature.

## Getting GeoJSON out of KML / Shapefile

Farms and agronomists usually have **KML** (Google Earth), **Shapefile**
(`.shp` + `.dbf` + `.shx` + `.prj`, from QGIS / ArcGIS / the land cadastre) or
GeoPackage. GDAL's `ogr2ogr` converts any of them, reprojecting to WGS 84 on the way:

```bash
# KML → GeoJSON
docker run --rm -v "$PWD:/data" ghcr.io/osgeo/gdal \
  ogr2ogr -f GeoJSON -t_srs EPSG:4326 -lco RFC7946=YES /data/fields.geojson /data/fields.kml

# Shapefile (often in a projected system, e.g. UCS-2000 / Gauss-Kruger, and cp1251 attributes)
docker run --rm -v "$PWD:/data" ghcr.io/osgeo/gdal \
  ogr2ogr -f GeoJSON -t_srs EPSG:4326 -lco RFC7946=YES \
          --config SHAPE_ENCODING CP1251 \
          -sql "SELECT NAME AS name, CULTURE AS crop FROM fields" \
          /data/fields.geojson /data/fields.shp

curl -X POST 'localhost:3000/fields/import?mode=partial' \
  -H 'x-org-id: 00000000-0000-0000-0000-000000000001' \
  -H 'content-type: application/geo+json' \
  --data-binary @fields.geojson
```

- `-t_srs EPSG:4326` — reproject: a Shapefile from the cadastre is in metres
  of a national projection, GeoJSON must be longitude / latitude.
- `-lco RFC7946=YES` — write RFC 7946 GeoJSON: WGS 84, counter-clockwise outer
  rings, coordinates limited to 7 decimals, no `crs` member (which the API rejects).
- `SHAPE_ENCODING` — attributes of Ukrainian shapefiles are often cp1251; without
  it names come out as mojibake.
- `-sql` — map the source attribute names to the API's `properties` (`name`, `crop`, `season`).

## What the endpoint does

1. **Envelope** — a FeatureCollection with 1–5 000 Features, else 400.
2. **Shape of every Feature**, one by one with the same Zod schema as `POST /fields`:
   Polygon / MultiPolygon, closed rings, `[lng, lat]` inside Ukraine, a name.
   A broken Feature becomes an error line `{ index, name, stage: 'schema', messages }`;
   the rest of the file is not affected.
3. **Geometry of every boundary in ONE query** — the M2 pipeline (drop repeated
   points, `ST_IsValid`, repair self-intersections with `ST_MakeValid`, reject a
   hole outside its shell / an empty or < 100 m² result, counter-clockwise) over a
   JSON array numbered `WITH ORDINALITY`. Rejected → `stage: 'geometry'`.
4. **One INSERT for all fields** — the batch is one JSON parameter unpacked by
   `json_to_recordset`; ids are generated in the query so every stored row maps
   back to its position in the file. Then **one UPDATE** adopts the soil samples
   that lie inside the new fields (`DISTINCT ON (sample)` picks one field when a
   sample is in two). Both in one transaction.

A fixed number of queries whatever the size of the file — never one per Feature.

## Partial or all-or-nothing

| `mode` | Behaviour | When |
|---|---|---|
| `partial` (default) | valid Features are stored, the others are listed with their index and reason; 201. Nothing valid → 422 | a person uploads a file: 3 broken boundaries out of 2 000 should not block the other 1 997; they fix three and re-upload only those |
| `atomic` | any error → 422 with **every** error, nothing stored | a system syncs its data: the copy must be complete or not change at all, and the import can simply be repeated |

Partial is the default because the typical importer is a person with a file
from somewhere else, and a list of what to fix is more useful than a refusal.
Even in partial mode the valid part is written in one transaction: either all
valid fields appear, or (on a database error) none.

Not done here, and worth doing next: idempotency (an `Idempotency-Key` header or
a per-file hash, so a retried upload does not create every field twice); a
warning for imported fields that overlap existing ones (M5) — set-based, as one
self-join of the new ids against the table; an asynchronous job (queue + status
endpoint) for files larger than one request should carry.

## Cost

5 000 round fields of 64 vertices, 7.1 MB of GeoJSON, `test/import.e2e-spec.ts`:
**7.9 s, ~1.6 ms per field**. Measured in the database on the same shapes:

| stage | time |
|---|---|
| check + repair + measure 5 000 boundaries (one query) | ~2.3 s |
| INSERT 5 000 rows (generated `area_ha`, `CHECK ST_IsValid`, 2 GiST indexes) | ~1.0 s |
| — of which maintaining the two GiST indexes | ~0.4 s |

The rest (~4.5 s, estimated) is receiving and parsing 7 MB of JSON and
validating ~325 000 positions with Zod in Node. Fastify's default body limit
(1 MB) is raised to 20 MB in `createAdapter()` for this endpoint's sake.
