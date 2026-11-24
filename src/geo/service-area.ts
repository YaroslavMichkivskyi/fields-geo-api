/**
 * Where the platform works: a rough bounding box of Ukraine, [lng, lat].
 * Coordinates outside it are almost always a mistake, most often
 * [lat, lng] sent instead of GeoJSON's [lng, lat].
 */
export const SERVICE_AREA = {
  minLng: 22.0,
  minLat: 44.0,
  maxLng: 40.5,
  maxLat: 52.5,
} as const;

export function inServiceArea(lng: number, lat: number): boolean {
  return (
    lng >= SERVICE_AREA.minLng &&
    lng <= SERVICE_AREA.maxLng &&
    lat >= SERVICE_AREA.minLat &&
    lat <= SERVICE_AREA.maxLat
  );
}
