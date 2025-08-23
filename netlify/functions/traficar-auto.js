// Traficar proxy: v1 cars + car-models join, robust coords, normalized fields for the UI.
export async function handler(event) {
  const origin = 'https://fioletowe.live';
  const zoneParam = event.queryStringParameters?.zoneId; // allow ?zoneId=1 for testing
  const zoneIds = zoneParam ? [Number(zoneParam)] : Array.from({ length: 15 }, (_, i) => i + 1);

  const headers = {
    'accept': 'application/json',
    'user-agent': 'Mozilla/5.0',
    'referer': `${origin}/`
  };

  // --- Fetch car models once and map them by id ---
  const modelMap = new Map();
  try {
    const r = await fetch(`${origin}/api/v1/car-models`, { headers });
    const txt = await r.text();
    const data = JSON.parse(txt);
    const arr = Array.isArray(data) ? data : (data.carModels || data.items || data.data || []);
    for (const m of arr) {
      if (!m) continue;
      const id = m.id ?? m.modelId ?? m.code;
      if (id != null) modelMap.set(Number(id), { name: m.name || m.model || 'Vehicle', electric: !!m.electric });
    }
  } catch (_) { /* ok */ }

  // --- utils ---
  const num = n => typeof n === 'number' && isFinite(n);
  const toNum = v => typeof v === 'string' ? parseFloat(v) : v;
  const fromE6Maybe = v => {
    const n = toNum(v);
    if (!num(n)) return undefined;
    return Math.abs(n) > 1000 ? n / 1e6 : n; // if looks like E6, scale down
  };

  function extractLatLng(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 6) return null;

    // direct keys
    let lat = obj.lat ?? obj.latitude ?? obj.Latitude ?? obj.latE6 ?? obj.latitudeE6;
    let lng = obj.lng ?? obj.lon ?? obj.longitude ?? obj.Longitude ?? obj.lonE6 ?? obj.longitudeE6;
    lat = fromE6Maybe(lat); lng = fromE6Maybe(lng);
    if (num(lat) && num(lng)) return { lat, lng };

    // geojson
    const g = obj.geometry;
    if (g && Array.isArray(g.coordinates) && g.coordinates.length >= 2) {
      const LON = toNum(g.coordinates[0]), LAT = toNum(g.coordinates[1]);
      if (num(LAT) && num(LON)) return { lat: LAT, lng: LON };
    }

    // common nests
    for (const key of ['location','position','gps','coords']) {
      if (obj[key]) {
        const got = extractLatLng(obj[key], depth + 1);
        if (got) return got;
      }
    }

    // any keys containing lat/lon/lng
    let anyLat, anyLon;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'object') continue;
      if (k.toLowerCase().includes('lat')) anyLat = fromE6Maybe(v);
      if (k.toLowerCase().includes('lon') || k.toLowerCase().includes('lng')) anyLon = fromE6Maybe(v);
    }
    if (num(anyLat) && num(anyLon)) return { lat: anyLat, lng: anyLon };

    // dive shallowly
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object') {
        const got = extractLatLng(v, depth + 1);
        if (got) return got;
      }
    }
    return null;
  }

  function pickPlate(x) {
    return x.plate || x.plates || x.registration || x.registrationNumber || x.license || x.licensePlate || x.plateNumber || '';
  }
  function pickModelName(x) {
    const id = x.modelId ?? x.carModelId ?? x.model?.id ?? x.carModel?.id;
    if (id != null && modelMap.has(Number(id))) return modelMap.get(Number(id)).name;
    return x.modelName || x.name || x.model || x.vehicleModel || (x.properties && x.properties.model) || 'Vehicle';
  }
  function isElectric(x) {
    if (typeof x.electric === 'boolean') return x.electric;
    if (typeof x.isElectric === 'boolean') return x.isElectric;
    const id = x.modelId ?? x.carModelId ?? x.model?.id ?? x.carModel?.id;
    if (id != null && modelMap.has(Number(id))) return !!modelMap.get(Number(id)).electric;
    return false;
  }
  function pickPct(x, electricFlag) {
    // prefer battery for EVs, fuel for ICE; normalize 0..1 → 0..100
    let battery = x.battery ?? x.batteryLevel ?? x.batteryPercent ?? x.soc ?? x.SoC ?? x.charge;
    let fuel = x.fuel ?? x.fuelLevel ?? x.fuelPercent;
    const norm = v => (typeof v === 'number' ? (v <= 1 && v >= 0 ? v*100 : v) : undefined);
    if (electricFlag) {
      const b = norm(battery);
      if (typeof b === 'number') return Math.max(0, Math.min(100, b));
    }
    const f = norm(fuel);
    if (typeof f === 'number') return Math.max(0, Math.min(100, f));
    const b2 = norm(battery);
    if (typeof b2 === 'number') return Math.max(0, Math.min(100, b2));
    return null;
  }

  // build URLs (with and without lastUpdate)
  const urls = zoneIds.flatMap(id => [
    `${origin}/api/v1/cars?zoneId=${id}`,
    `${origin}/api/v1/cars?zoneId=${id}&lastUpdate=0`
  ]);

  const tried = [];
  let out = [];
  for (const u of urls) {
    tried.push(u);
    try {
      const r = await fetch(u, { headers });
      if (!r.ok) continue;
      const txt = await r.text();
      let data; try { data = JSON.parse(txt); } catch { continue; }

      // derive list candidates
      const arrays = [];
      if (Array.isArray(data)) arrays.push(data);
      if (data && Array.isArray(data.cars)) arrays.push(data.cars);
      if (data && Array.isArray(data.items)) arrays.push(data.items);
      if (data && Array.isArray(data.results)) arrays.push(data.results);
      if (!arrays.length && data && typeof data === 'object') {
        const vals = Object.values(data);
        if (vals.length && vals.every(v => v && typeof v === 'object')) arrays.push(vals);
      }

      const normalized = [];
      for (const arr of arrays) {
        for (const item of arr) {
          const pos = extractLatLng(item);
          if (!pos) continue;
          const model = pickModelName(item);
          const plate = pickPlate(item);
          const ev = isElectric(item);
          const pct = pickPct(item, ev);
          normalized.push({ lat: pos.lat, lng: pos.lng, model, plate, pct, isElectric: ev });
        }
      }
      if (normalized.length) { out = normalized; break; } // first non-empty hit
    } catch { /* try next */ }
  }

  if (!out.length) {
    return { statusCode: 502, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'No vehicles found', tried }) };
  }

  // de-dup by plate+coords
  const seen = new Set();
  out = out.filter(v => {
    const key = `${v.plate || ''}|${v.model || ''}|${v.lat.toFixed(6)}|${v.lng.toFixed(6)}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });

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
