// Smarter Traficar proxy: accepts arrays OR object maps and digs deep for coordinates.
// Returns a flat array of {lat, lng, model, plate, pct}.
export async function handler(event) {
  const origin = 'https://fioletowe.live';
  const city = (event.queryStringParameters?.city || 'krakow').toLowerCase();

  // Candidate endpoints (covers v1 and common variants)
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
    `/api/available-cars?city=${encodeURIComponent(city)}`,
    `/api/cars/available?city=${encodeURIComponent(city)}`,
    `/api/markers?city=${encodeURIComponent(city)}`,
    `/api/v1/cars?city=${encodeURIComponent(city)}`,
    `/api/v1/cars/nearby?city=${encodeURIComponent(city)}`,
    `/api/v1/cars/search?city=${encodeURIComponent(city)}`,
    `/api/v1/vehicles?city=${encodeURIComponent(city)}`,
    `/api/v1/map/cars?city=${encodeURIComponent(city)}`
  ];

  // utils
  const num = (n) => typeof n === 'number' && isFinite(n);
  const fromE6 = (n) => (typeof n === 'number' ? n / 1e6 : n);

  // very tolerant coordinate extractor
  function extractLatLng(o, depth = 0) {
    if (!o || typeof o !== 'object' || depth > 6) return null;

    // direct keys
    const lat = o.lat ?? o.latitude ?? o.Latitude ?? (o.latE6 != null ? fromE6(o.latE6) : undefined);
    const lng = o.lng ?? o.lon ?? o.longitude ?? o.Longitude ?? (o.lonE6 != null ? fromE6(o.lonE6) : undefined);
    if (num(lat) && num(lng)) return { lat, lng };

    // geojson
    if (o.geometry && Array.isArray(o.geometry.coordinates) && o.geometry.coordinates.length >= 2) {
      const [LNG, LAT] = o.geometry.coordinates;
      if (num(LAT) && num(LNG)) return { lat: LAT, lng: LNG };
    }

    // common nests
    for (const k of ['location','position','gps','coords']) {
      if (o[k]) {
        const got = extractLatLng(o[k], depth + 1);
        if (got) return got;
      }
    }

    // Alt names / string nums / x,y
    if (o.y != null && o.x != null) {
      const LAT = parseFloat(o.y), LNG = parseFloat(o.x);
      if (num(LAT) && num(LNG)) return { lat: LAT, lng: LNG };
    }

    // scan shallow children
    for (const v of Object.values(o)) {
      if (v && typeof v === 'object') {
        const got = extractLatLng(v, depth + 1);
        if (got) return got;
      }
    }
    return null;
  }

  // Gather arrays (and also turn object maps into arrays)
  function collectArrays(root, maxDepth = 4, out = [], seen = new Set()) {
    if (maxDepth < 0 || !root || typeof root !== 'object') return out;
    if (seen.has(root)) return out;
    seen.add(root);

    if (Array.isArray(root)) out.push(root);
    else {
      // object map -> array of values (if it looks like a collection)
      const vals = Object.values(root);
      if (vals.length >= 5 && vals.every(v => v && typeof v === 'object')) out.push(vals);
    }

    // common collection keys
    for (const k of ['cars','vehicles','items','results','features','data','list']) {
      const v = root[k];
      if (Array.isArray(v)) out.push(v);
      else if (v && typeof v === 'object') {
        const vals = Object.values(v);
        if (vals.length >= 5 && vals.every(x => x && typeof x === 'object')) out.push(vals);
      }
      // GeoJSON -> flatten
      if (k === 'features' && Array.isArray(root[k])) {
        out.push(root[k].map(f => ({ ...f.properties, geometry: f.geometry })));
      }
    }

    for (const v of Object.values(root)) {
      if (v && typeof v === 'object') collectArrays(v, maxDepth - 1, out, seen);
    }
    return out;
  }

  // normalize a vehicle-like object
  function normalize(item, pos) {
    const model = item.model || item.name || item.vehicleModel || (item.properties && item.properties.model) || 'Vehicle';
    const plate = item.plate || item.registration || item.license || item.identifier || (item.properties && item.properties.plate) || '';
    const fuel  = item.fuel || item.fuelLevel || item.fuelPercent || (item.properties && (item.properties.fuel || item.properties.fuelLevel));
    const batt  = item.battery || item.batteryLevel || item.batteryPercent || (item.properties && (item.properties.battery || item.properties.batteryLevel));
    const pct   = (typeof batt === 'number') ? batt : (typeof fuel === 'number' ? fuel : null);
    return { lat: pos.lat, lng: pos.lng, model, plate, pct };
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

      // Skip obvious model-only endpoints
      if (data && (data.carModels || data.models) && !data.cars && !data.vehicles) continue;

      const arrays = collectArrays(data);
      for (const arr of arrays) {
        const out = [];
        for (const item of arr) {
          const pos = extractLatLng(item);
          if (pos) out.push(normalize(item, pos));
        }
        if (out.length > 0) {
          return {
            statusCode: 200,
            headers: {
              'content-type': 'application/json',
              'cache-control': 'no-store',
              'access-control-allow-origin': '*'
            },
            body: JSON.stringify(out)
          };
        }
      }
    } catch { /* try next */ }
  }

  return {
    statusCode: 502,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ error: 'No vehicle array with coordinates found', tried })
  };
}
