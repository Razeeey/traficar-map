// Smarter Traficar proxy: looks through MANY likely endpoints and
// digs through nested objects to find coordinates, then normalizes to {lat, lng, ...}.
export async function handler(event) {
  const origin = 'https://fioletowe.live';
  const city = (event.queryStringParameters?.city || 'krakow').toLowerCase();

  // Good guesses (includes v1 endpoints and common variants)
  const guesses = [
    `/api/${city}/cars`,
    `/api/${city}/vehicles`,
    `/api/cars?city=${encodeURIComponent(city)}`,
    `/api/vehicles?city=${encodeURIComponent(city)}`,
    `/${city}/cars`,
    `/api/city/${city}/cars`,
    `/api/city/${city}/vehicles`,
    `/api/map/cars?city=${encodeURIComponent(city)}`,
    `/api/map/vehicles?city=${encodeURIComponent(city)}`,
    `/api/markers?city=${encodeURIComponent(city)}`,
    `/api/available-cars?city=${encodeURIComponent(city)}`,
    `/api/cars/available?city=${encodeURIComponent(city)}`,
    // v1 shapes:
    `/api/v1/cars?city=${encodeURIComponent(city)}`,
    `/api/v1/cars/nearby?city=${encodeURIComponent(city)}`,
    `/api/v1/cars/search?city=${encodeURIComponent(city)}`,
    `/api/v1/vehicles?city=${encodeURIComponent(city)}`,
    `/api/v1/map/cars?city=${encodeURIComponent(city)}`,
  ];

  // --- helpers ---------------------------------------------------------------
  const num = (n) => typeof n === 'number' && isFinite(n);
  const fromE6 = (n) => (typeof n === 'number' ? n / 1e6 : n);

  // Try to read lat/lng anywhere in the object (nested)
  function extractLatLng(o) {
    if (!o || typeof o !== 'object') return null;

    // direct keys
    const cand = {
      lat: o.lat ?? o.latitude ?? o.Latitude ?? (o.latE6 != null ? fromE6(o.latE6) : undefined),
      lng: o.lng ?? o.lon ?? o.longitude ?? o.Longitude ?? (o.lonE6 != null ? fromE6(o.lonE6) : undefined),
    };
    if (num(cand.lat) && num(cand.lng)) return { lat: cand.lat, lng: cand.lng };

    // GeoJSON: geometry.coordinates [lng,lat]
    if (o.geometry && Array.isArray(o.geometry.coordinates) && o.geometry.coordinates.length >= 2) {
      const [LNG, LAT] = o.geometry.coordinates;
      if (num(LAT) && num(LNG)) return { lat: LAT, lng: LNG };
    }

    // { location: { lat, lng }} or { position: { lat, lon }} or { gps: {...} }
    const nests = [o.location, o.position, o.gps, o.coords];
    for (const n of nests) {
      const got = extractLatLng(n);
      if (got) return got;
    }

    // Some APIs use x/y or lat/lon strings
    if (o.y && o.x) {
      const LAT = parseFloat(o.y), LNG = parseFloat(o.x);
      if (num(LAT) && num(LNG)) return { lat: LAT, lng: LNG };
    }

    // Search shallow child objects/arrays (one level)
    for (const v of Object.values(o)) {
      if (v && typeof v === 'object') {
        const got = extractLatLng(v);
        if (got) return got;
      }
    }
    return null;
  }

  // Get all arrays we might care about (a few levels deep)
  function collectArrays(root, maxDepth = 3, out = [], seen = new Set()) {
    if (maxDepth < 0 || !root || typeof root !== 'object') return out;
    if (seen.has(root)) return out;
    seen.add(root);

    if (Array.isArray(root)) out.push(root);

    // common array fields
    const candidates = ['cars','vehicles','items','results','features','data','list'];
    for (const k of Object.keys(root)) {
      const v = root[k];
      if (!v || typeof v !== 'object') continue;
      if (Array.isArray(v)) out.push(v);
      if (k === 'features' && Array.isArray(v)) {
        // make GeoJSON more uniform
        out.push(v.map(f => ({ ...f.properties, geometry: f.geometry })));
      }
      collectArrays(v, maxDepth - 1, out, seen);
    }
    return out;
  }

  const tried = [];
  for (const path of [...new Set(guesses)]) {
    const url = origin + path;
    tried.push(url);
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' } });
      if (!r.ok) continue;
      const text = await r.text();
      let data; try { data = JSON.parse(text); } catch { continue; }

      // Skip endpoints that are clearly model lists etc.
      if (data && (data.carModels || data.models) && !data.cars && !data.vehicles) continue;

      // Find an array that actually contains coordinates
      const arrays = collectArrays(data);
      for (const arr of arrays) {
        const withCoords = arr
          .map(item => {
            const pos = extractLatLng(item);
            if (!pos) return null;
            // Pull extra fields if present
            const model = item.model || item.name || item.vehicleModel || (item.properties && item.properties.model);
            const plate = item.plate || item.registration || item.license || item.identifier || (item.properties && item.properties.plate);
            const fuel  = item.fuel || item.fuelLevel || item.fuelPercent || (item.properties && (item.properties.fuel || item.properties.fuelLevel));
            const batt  = item.battery || item.batteryLevel || item.batteryPercent || (item.properties && (item.properties.battery || item.properties.batteryLevel));
            const pct   = (typeof batt === 'number') ? batt : (typeof fuel === 'number' ? fuel : null);
            return { lat: pos.lat, lng: pos.lng, model, plate, pct };
          })
          .filter(Boolean);

        if (withCoords.length > 0) {
          return {
            statusCode: 200,
            headers: {
              'content-type': 'application/json',
              'cache-control': 'no-store',
              'access-control-allow-origin': '*'
            },
            body: JSON.stringify(withCoords)
          };
        }
      }
    } catch { /* try next candidate */ }
  }

  return {
    statusCode: 502,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ error: 'No vehicle array with coordinates found', tried })
  };
}
