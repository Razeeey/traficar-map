// Multi-zone Traficar proxy: calls /api/v1/cars?zoneId=…&lastUpdate=0 for many zones,
// then geo-filters to the selected city. Returns [{lat,lng,model,plate,pct}, ...]
export async function handler(event) {
  const origin = 'https://fioletowe.live';
  const city = (event.queryStringParameters?.city || 'krakow').toLowerCase();

  // City centers (same as your UI)
  const centers = {
    krakow:[50.0614,19.9383], warszawa:[52.2297,21.0122], wroclaw:[51.1079,17.0385],
    poznan:[52.4064,16.9252], trojmiasto:[54.3722,18.6383], slask:[50.2649,19.0238],
    lublin:[51.2465,22.5684], lodz:[51.7592,19.4550], szczecin:[53.4285,14.5528], rzeszow:[50.0413,21.9990]
  };
  const center = centers[city] || centers.krakow;
  const RADIUS_KM = 80; // geo-filter radius around the city center

  // Try zoneIds 1..12 in parallel (covers all current Polish zones)
  const zoneIds = Array.from({ length: 12 }, (_, i) => i + 1);
  const urls = zoneIds.map(id => `${origin}/api/v1/cars?zoneId=${id}&lastUpdate=0`);

  // helpers
  const toRad = (d) => d * Math.PI / 180;
  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371, dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  const fromE6 = (n) => (typeof n === 'number' ? n/1e6 : n);
  const num = (n) => typeof n === 'number' && isFinite(n);

  // pull lat/lng from many shapes (deep)
  function extractLatLng(o) {
    if (!o || typeof o !== 'object') return null;

    // direct keys
    const lat = o.lat ?? o.latitude ?? (o.latE6 != null ? fromE6(o.latE6) : undefined)
             ?? o.Latitude;
    const lng = o.lng ?? o.lon ?? o.longitude ?? (o.lonE6 != null ? fromE6(o.lonE6) : undefined)
             ?? o.Longitude;
    if (num(lat) && num(lng)) return { lat, lng };

    // geojson
    if (o.geometry && Array.isArray(o.geometry.coordinates) && o.geometry.coordinates.length >= 2) {
      const [LNG, LAT] = o.geometry.coordinates;
      if (num(LAT) && num(LNG)) return { lat: LAT, lng: LNG };
    }

    // common nests
    for (const k of ['location','position','gps','coords']) {
      const n = o[k];
      if (n && typeof n === 'object') {
        const got = extractLatLng(n);
        if (got) return got;
      }
    }

    // x/y strings
    if (o.y != null && o.x != null) {
      const LAT = parseFloat(o.y), LNG = parseFloat(o.x);
      if (num(LAT) && num(LNG)) return { lat: LAT, lng: LNG };
    }
    return null;
  }

  function normalize(item, pos) {
    const model = item.model || item.name || item.vehicleModel || (item.properties && item.properties.model) || 'Vehicle';
    const plate = item.plate || item.registration || item.license || item.identifier || (item.properties && item.properties.plate) || '';
    const fuel  = item.fuel || item.fuelLevel || item.fuelPercent || (item.properties && (item.properties.fuel || item.properties.fuelLevel));
    const batt  = item.battery || item.batteryLevel || item.batteryPercent || (item.properties && (item.properties.battery || item.properties.batteryLevel));
    const pct   = (typeof batt === 'number') ? batt : (typeof fuel === 'number' ? fuel : null);
    return { lat: pos.lat, lng: pos.lng, model, plate, pct };
  }

  // fetch all zones concurrently
  const results = await Promise.allSettled(urls.map(u =>
    fetch(u, { headers: { accept: 'application/json' } })
      .then(r => r.ok ? r.text() : '[]')
      .catch(() => '[]')
  ));

  // parse, flatten (accept array OR object map)
  const vehicles = [];
  for (const res of results) {
    if (res.status !== 'fulfilled') continue;
    let data; try { data = JSON.parse(res.value); } catch { continue; }

    let list = [];
    if (Array.isArray(data)) list = data;
    else if (data && Array.isArray(data.cars)) list = data.cars;
    else if (data && typeof data === 'object') {
      const vals = Object.values(data);
      if (vals.length && vals.every(v => v && typeof v === 'object')) list = vals; // object map -> array
    }

    for (const item of list) {
      const pos = extractLatLng(item);
      if (!pos) continue;
      // geo-filter to the chosen city
      if (center) {
        const d = haversine(center[0], center[1], pos.lat, pos.lng);
        if (d > RADIUS_KM) continue;
      }
      vehicles.push(normalize(item, pos));
    }
  }

  // de-dup by plate+coords
  const seen = new Set();
  const unique = vehicles.filter(v => {
    const key = `${v.plate || ''}|${v.lat.toFixed(5)}|${v.lng.toFixed(5)}`;
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
