import { DEMO_ORG_ID } from '../database/migrations/1795400001000-CreateFields';
import { POLYGON_MIN_ZOOM } from './tiles.schema';

/**
 * GET /map — MapLibre GL over GET /tiles, served by the API itself so the
 * tiles come from the same origin (no CORS). The organisation is
 * ?org=<uuid>, Demo farm by default; MapLibre sends it as the x-org-id
 * header through transformRequest. Basemap: OpenStreetMap raster tiles.
 */
export const MAP_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fields map</title>
<link rel="stylesheet" href="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css">
<script src="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js"></script>
<style>
  html, body, #map { margin: 0; height: 100%; }
  #info { position: absolute; top: 8px; left: 8px; z-index: 1; padding: 6px 10px;
          background: #fff; font: 13px system-ui, sans-serif; border-radius: 4px; box-shadow: 0 1px 4px #0003; }
</style>
</head>
<body>
<div id="info"></div>
<div id="map"></div>
<script>
  const org = new URLSearchParams(location.search).get('org') || '${DEMO_ORG_ID}';
  const map = new maplibregl.Map({
    container: 'map',
    center: [34.55, 49.59],
    zoom: 9,
    hash: true,
    transformRequest: (url) =>
      url.startsWith(location.origin + '/tiles/') ? { url, headers: { 'x-org-id': org } } : { url },
    style: {
      version: 8,
      sources: {
        osm: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256,
               attribution: '&copy; OpenStreetMap contributors' },
        fields: { type: 'vector', tiles: [location.origin + '/tiles/{z}/{x}/{y}.mvt'], maxzoom: 16 },
      },
      layers: [
        { id: 'osm', type: 'raster', source: 'osm' },
        { id: 'clusters', type: 'circle', source: 'fields', 'source-layer': 'clusters', maxzoom: ${POLYGON_MIN_ZOOM},
          paint: { 'circle-color': '#2e7d32', 'circle-opacity': 0.7, 'circle-stroke-color': '#fff', 'circle-stroke-width': 1,
                   'circle-radius': ['interpolate', ['linear'], ['get', 'count'], 1, 3, 50, 10, 500, 22] } },
        { id: 'fields-fill', type: 'fill', source: 'fields', 'source-layer': 'fields', minzoom: ${POLYGON_MIN_ZOOM},
          paint: { 'fill-color': '#7cb342', 'fill-opacity': 0.35 } },
        { id: 'fields-line', type: 'line', source: 'fields', 'source-layer': 'fields', minzoom: ${POLYGON_MIN_ZOOM},
          paint: { 'line-color': '#33691e', 'line-width': 1 } },
      ],
    },
  });
  const info = document.getElementById('info');
  const show = () => { info.textContent = 'zoom ' + map.getZoom().toFixed(1) +
    (map.getZoom() < ${POLYGON_MIN_ZOOM} ? ' - clusters' : ' - field polygons'); };
  map.on('load', show);
  map.on('zoomend', show);
  map.on('click', 'fields-fill', (e) => {
    const p = e.features[0].properties;
    new maplibregl.Popup().setLngLat(e.lngLat)
      .setText(p.name + (p.crop ? ', ' + p.crop : '') + ': ' + p.areaHa + ' ha').addTo(map);
  });
  map.on('click', 'clusters', (e) => {
    const p = e.features[0].properties;
    new maplibregl.Popup().setLngLat(e.lngLat).setText(p.count + ' fields, ' + p.areaHa + ' ha').addTo(map);
  });
</script>
</body>
</html>
`;
