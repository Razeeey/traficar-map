// Auto-discover a Traficar endpoint that returns VEHICLES with coordinates (not just carModels).
export async function handler(event) {
  const origin = 'https://fioletowe.live';
  const city = (event.queryStringParameters?.city || 'krakow').toLowerCase();

  // Start with good guesses
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
    `/api/cars/available?city=${encodeURIComponent(city)}`
  ];

  // Try to read OpenAPI to add more paths if available
  try {
    const specRes = await fetch(`${origin}/api/openapi.json`, { headers: { accept: 'application/json' } });
    if (specRes.ok) {
      const spec = await specRes.json();
      const paths = spec?.paths || {};
      for (const p of Object.keys(paths)) {
        const item = paths[p];
        if (!item?.get) continue;
        const lower = p.toLowerCase();
        if (lower.includes('car') || lower.includes('vehicle') || lower.includes('marker')) {
          let path = p.replace('{city}', city);
          guesses.push(path);
          // also try with ?city= if path doesn't already have it
          if (!path.toLowerCase().includes('city=')) {
            guesses.push(path + (path.includes('?') ? '&' : '?') + 'city=' + encodeURIComponent(city));
          }
        }
      }
    }
  } catch (_) {
    // ignore – we'll just use the static guesses above
  }

  // Helper to extract arrays and test for coordinates
  const getCandidateArrays = (data) => {
    const arrays = [];
    if (Array.isArray(data)) arrays.push(data);
    if (data && Array.isArray(data.cars)) arrays.push(data.cars);
    if (data && Array.isArray(data.items)) arrays.push(data.items);
    if (data && Array.isArray(data.results)) arrays.push(data.results);
    if (data && Array.isArray(data.features)) {
      arrays.push(data.features.map(f => ({ ...f.properties, geometry: f.geometry })));
    }
    return arrays;
  };

  const hasCoords = (v) => {
    const lat = v.lat ?? v.latitude ?? v.latE6 ?? (v.location && (v.location.lat ?? v.location.latitude)) ??
                (v.geometry && v.geometry.coordinates && v.geometry.coordinates[1]);
    const lon = v.lng ?? v.lon ?? v.longitude ?? v.lonE6 ?? (v.location && (v.location.lng ?? v.location.lon ?? v.location.longitude)) ??
                (v.geometry && v.geometry.coordinates && v.geometry.coordinates[0]);
    const num = (n) => typeof n === 'number' && isFinite(n);
    return (num(lat) || num(v?.latE6)) && (num(lon) || num(v?.lonE6));
  };

  const normalize = (v) => {
    const lat = v.lat ?? v.latitude ?? (v.latE6 != null ? v.latE6 / 1e6 :
                (v.location && (v.location.lat ?? v.location.latitude)) ??
                (v.geometry && v.geometry.coordinates && v.geometry.coordinates[1]));
    const lng = v.lng ?? v.lon ?? v.longitude ?? (v.lonE6 != null ? v.lonE6 / 1e6 :
                (v.location && (v.location.lng ?? v.location.lon ?? v.location.longitude)) ??
                (v.geometry && v.geometry.coordinates && v.geometry.coordinates[0]));
    return { ...v, lat, lng };
  };

  const tried = [];
  // Try each candidate until one returns an array with coords
  for (const p of [...new Set(guesses)]) {
    const url = origin + p;
    tried.push(url);
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' } });
      if (!r.ok) continue;
      const text = await r.text();
      let data;
      try { data = JSON.parse(text); } catch { continue; }

      // Skip known non-vehicle payloads (like {carModels:[...]})
      if (data && data.carModels && !data.cars) continue;

      const arrays = getCandidateArrays(data);
      for (const arr of arrays) {
        const withCoords = arr.filter(hasCoords);
        if (withCoords.length > 0) {
          const normalized = withCoords.map(normalize);
          return {
            statusCode: 200,
            headers: {
              'content-type': 'application/json',
              'cache-control': 'no-store',
              'access-control-allow-origin': '*'
            },
            body: JSON.stringify(normalized)
          };
        }
      }
    } catch (_) { /* try next */ }
  }

  return {
    statusCode: 502,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ error: 'No vehicle array with coordinates found', tried })
  };
}
