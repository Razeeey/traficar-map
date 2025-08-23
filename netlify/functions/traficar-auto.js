// Robust Traficar proxy: v1 endpoint, multiple zoneIds, no geo-filter, deep coord extraction.
export async function handler(event) {
  const origin = 'https://fioletowe.live';
  const zoneParam = event.queryStringParameters?.zoneId; // optional override (e.g. ?zoneId=1)
  const zoneIds = zoneParam ? [Number(zoneParam)] : Array.from({ length: 15 }, (_, i) => i + 1);

  const headers = {
    'accept': 'application/json',
    // Some backends only respond if these are present:
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
    'referer': `${origin}/`
  };

  // Try both shapes for each zone (with and without lastUpdate)
  const buildUrls = (id) => ([
    `${origin}/api/v1/cars?zoneId=${id}`,
    `${origin}/api/v1/cars?zoneId=${id}&lastUpdate=0`
  ]);
  const urls = zoneIds.flatMap(buildUrls);

  const num = (n) => typeof n === 'number' && isFinite(n);
  const toNum = (v) => (typeof v === 'string' ? parseFloat(v) : v);
  const fromE6Maybe = (v) => {
    const n = toNum(v);
    if (!num(n)) return undefined;
    // Heuristic: if value looks like E6 (e.g. 50412345) reduce
    return Math.abs(n) > 1000 ? n / 1e6 : n;
  };

  // Flexible, recursive coordinate finder
  function extractLatLng(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 6) return null;

    // 1) Common direct keys
    let lat = obj.lat ?? obj.latitude ?? obj.Latitude ?? obj.latE6 ?? obj.latitudeE6;
    let lng = obj.lng ?? obj.lon ?? obj.longitude ?? obj.Longitude ?? obj.lonE6 ?? obj.longitudeE6;

    lat = fromE6Maybe(lat);
    lng = fromE6Maybe(lng);
    if (num(lat) && num(lng)) return { lat, lng };

    // 2) GeoJSON geometry.coordinates [lng,lat]
    const g = obj.geometry;
    if (g && Array.isArray(g.coordinates) && g.coordinates.length >= 2) {
      const LON = toNum(g.coordinates[0]);
      const LAT = toNum(g.coordinates[1]);
      if (num(LAT) && num(LON)) return { lat: LAT, lng: LON };
    }

    // 3) Common nested containers
    for (const key of ['location', 'position', 'gps', 'coords']) {
      if (obj[key]) {
        const got = extractLatLng(obj[key], depth + 1);
        if (got) return got;
      }
    }

    // 4) Any keys containing 'lat'/'lon' (fallback)
    let anyLat, anyLon;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'object') continue;
      if (k.toLowerCase().includes('lat')) anyLat = fromE6Maybe(v);
      if (k.toLowerCase().includes('lon') || k.toLowerCase().includes('lng')) anyLon = fromE6Maybe(v);
    }
    if (num(anyLat) && num(anyLon)) return { lat: anyLat, lng: anyLon };

    // 5) Explore nested objects/arrays shallowly
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object') {
        const got = extractLatLng(v, depth + 1);
        if (got) return got;
      }
    }
    return null;
  }

  const normalize = (item, pos) => {
    const model = item.model || item.name || item.vehicleModel || (item.properties && item.properties.model) || 'Vehicle';
    const plate = item.plate || item.registration || item.license || item.identifier || (item.properties && item.properties.plate) || '';
    const fuel  = item.fuel || item.fuelLevel || item.fuelPercent || (item.properties && (item.properties.fuel || item.properties.fuelLevel));
    const batt  = item.battery || item.batteryLevel || item.batteryPercent || (item.properties && (item.properties.battery || item.properties.batteryLevel));
    const pct   = (typeof batt === 'number') ? batt : (typeof fuel === 'number' ? fuel : null);
    return { lat: pos.lat, lng: pos.lng, model, plate, pct };
  };

  // Fetch all URLs, keep the first non-empty result to avoid duplicates
  const tried = [];
  let collected = [];
  for (const u of urls) {
    tried.push(u);
    try {
      const r = await fetch(u, { headers });
      if (!r.ok) continue;
      const text = await r.text();
      let data; try { data = JSON.parse(text); } catch { continue; }

      // Convert object maps -> array candidates
      const arrays = [];
      if (Array.isArray(data)) arrays.push(data);
      if (data && Array.isArray(data.cars)) arrays.push(data.cars);
      if (data && Array.isArray(data.items)) arrays.push(data.items);
      if (data && Array.isArray(data.results)) arrays.push(data.results);
      if (data && Array.isArray(data.features)) {
        arrays.push(data.features.map(f => ({ ...f.properties, geometry: f.geometry })));
      }
      // Generic: values of object if they look like a collection
      if (!arrays.length && data && typeof data === 'object') {
        const vals = Object.values(data);
        if (vals.length && vals.every(v => v && typeof v === 'object')) arrays.push(vals);
      }

      // Extract coords
      const withCoords = [];
      for (const arr of arrays) {
        for (const it of arr) {
          const pos = extractLatLng(it);
          if (pos) withCoords.push(normalize(it, pos));
        }
      }

      if (withCoords.length) {
        collected = withCoords;
        break; // stop at first non-empty
      }
    } catch {
      /* try next */
    }
  }

  // If still empty, report attempts so we can fine-tune
  if (!collected.length) {
    return {
      statusCode: 502,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'No vehicles found with coords', tried })
    };
  }

  // Deduplicate by plate+rounded coords
  const seen = new Set();
  const unique = collected.filter(v => {
    const key = `${v.plate || ''}|${v.model || ''}|${v.lat.toFixed(6)}|${v.lng.toFixed(6)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    statusCode: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*'
    },
    body: JSON.stringify(unique)
  };
}
