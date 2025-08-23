// Traficar proxy: supports ?city=..., fetches all zones, geo-filters to that city,
// and maps regPlate (registration) + sideNumber (fleet badge) + range + fuel%.
export async function handler(event) {
  const origin = 'https://fioletowe.live';
  const cityParam = (event.queryStringParameters?.city || '').toLowerCase().trim();
  const zoneParam = event.queryStringParameters?.zoneId; // optional override for testing
  const zoneIds = zoneParam ? [Number(zoneParam)] : Array.from({ length: 15 }, (_, i) => i + 1);

  // city centers (same keys as your dropdown)
  const centers = {
    krakow:[50.0614,19.9383], warszawa:[52.2297,21.0122], wroclaw:[51.1079,17.0385],
    poznan:[52.4064,16.9252], trojmiasto:[54.3722,18.6383], slask:[50.2649,19.0238],
    lublin:[51.2465,22.5684], lodz:[51.7592,19.4550], szczecin:[53.4285,14.5528], rzeszow:[50.0413,21.9990]
  };
  const center = centers[cityParam] || null;
  const RADIUS_KM = 120; // generous metro radius

  const headers = { accept: 'application/json', 'user-agent': 'Mozilla/5.0', referer: `${origin}/` };

  // ---- models (id -> {name, electric, maxFuel}) ----
  const modelById = new Map();
  try {
    const r = await fetch(`${origin}/api/v1/car-models`, { headers });
    const data = await r.json();
    const arr = Array.isArray(data) ? data : (data.carModels || data.items || data.data || []);
    for (const m of arr) {
      if (!m) continue;
      const id = m.id ?? m.modelId ?? m.code;
      if (id != null) modelById.set(Number(id), {
        name: m.name || m.model || 'Vehicle',
        electric: !!m.electric,
        maxFuel: (typeof m.maxFuel === 'number' ? m.maxFuel : null)
      });
    }
  } catch {}

  // ---- utils ----
  const num = n => typeof n === 'number' && isFinite(n);
  const toNum = v => (typeof v === 'string' ? parseFloat(v) : v);
  const fromE6Maybe = v => { const n = toNum(v); if (!num(n)) return undefined; return Math.abs(n) > 1000 ? n/1e6 : n; };
  const toRad = d => d * Math.PI / 180;
  const haversineKm = (a,b)=> {
    const R=6371, dLat=toRad(b[0]-a[0]), dLon=toRad(b[1]-a[1]);
    const A=Math.sin(dLat/2)**2+Math.cos(toRad(a[0]))*Math.cos(toRad(b[0]))*Math.sin(dLon/2)**2;
    return R*2*Math.atan2(Math.sqrt(A),Math.sqrt(1-A));
  };

  function extractLatLng(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 6) return null;
    let lat = obj.lat ?? obj.latitude ?? obj.Latitude ?? obj.latE6 ?? obj.latitudeE6;
    let lng = obj.lng ?? obj.lon ?? obj.longitude ?? obj.Longitude ?? obj.lonE6 ?? obj.longitudeE6;
    lat = fromE6Maybe(lat); lng = fromE6Maybe(lng);
    if (num(lat) && num(lng)) return { lat, lng };
    const g = obj.geometry;
    if (g && Array.isArray(g.coordinates) && g.coordinates.length >= 2) {
      const LON = toNum(g.coordinates[0]), LAT = toNum(g.coordinates[1]);
      if (num(LAT) && num(LON)) return { lat: LAT, lng: LON };
    }
    for (const k of ['location','position','gps','coords']) {
      if (obj[k]) { const got = extractLatLng(obj[k], depth+1); if (got) return got; }
    }
    let anyLat, anyLon;
    for (const [k,v] of Object.entries(obj)) {
      if (typeof v === 'object') continue;
      const kk = k.toLowerCase();
      if (kk.includes('lat')) anyLat = fromE6Maybe(v);
      if (kk.includes('lon') || kk.includes('lng')) anyLon = fromE6Maybe(v);
    }
    if (num(anyLat) && num(anyLon)) return { lat: anyLat, lng: anyLon };
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object') { const got = extractLatLng(v, depth+1); if (got) return got; }
    }
    return null;
  }

  function pickModelMeta(x) {
    const id = x.modelId ?? x.carModelId ?? x.model?.id ?? x.carModel?.id;
    if (id != null && modelById.has(Number(id))) return modelById.get(Number(id));
    return { name: x.modelName || x.name || x.model || x.vehicleModel || 'Vehicle', electric: !!(x.electric ?? x.isElectric), maxFuel: null };
  }

  function pickPlateNumberRangeFuel(x) {
    // from your sample format:
    const plate = x.regPlate ? String(x.regPlate).trim().toUpperCase() : null;
    const number = (x.sideNumber != null) ? String(x.sideNumber).trim().toUpperCase() : null;
    const rangeKm = toNum(x.range); // already km in sample
    // fuel is percent in sample; also support other keys
    const fuelPct = (typeof x.fuel === 'number') ? x.fuel
                   : (typeof x.fuelPercent === 'number') ? x.fuelPercent
                   : (typeof x.fuelLevel === 'number') ? x.fuelLevel
                   : (typeof x.battery === 'number') ? x.battery
                   : (typeof x.batteryPercent === 'number') ? x.batteryPercent
                   : null;
    return { plate: plate || null, number: number || null, rangeKm: num(rangeKm) ? Math.round(rangeKm) : null, pct: num(fuelPct) ? Math.round(fuelPct) : null };
  }

  // ---- fetch all zones concurrently ----
  const urls = zoneIds.flatMap(id => [
    `${origin}/api/v1/cars?zoneId=${id}`,
    `${origin}/api/v1/cars?zoneId=${id}&lastUpdate=0`
  ]);
  const results = await Promise.allSettled(urls.map(u =>
    fetch(u, { headers }).then(r => r.ok ? r.json() : null).catch(() => null)
  ));

  // ---- parse and collect ----
  const vehicles = [];
  for (const res of results) {
    const data = res.value;
    if (!data) continue;
    const list =
      Array.isArray(data) ? data :
      Array.isArray(data.cars) ? data.cars :
      (data && typeof data === 'object') ? Object.values(data).filter(v => v && typeof v === 'object') : [];

    for (const item of list) {
      const pos = extractLatLng(item);
      if (!pos) continue;
      // if city provided, keep only near that city
      if (center) {
        const d = haversineKm(center, [pos.lat, pos.lng]);
        if (d > RADIUS_KM) continue;
      }
      const meta = pickModelMeta(item);
      const { plate, number, rangeKm, pct } = pickPlateNumberRangeFuel(item);
      const img = item.image || item.imageUrl || item.photoUrl || item.picture || item.pictureUrl || null;
      const id = item.id ?? item.vehicleId ?? item.carId ?? item.code ?? null;
      const address = typeof item.location === 'string' ? item.location : null;

      vehicles.push({
        id, lat: pos.lat, lng: pos.lng,
        model: meta.name, isElectric: !!meta.electric, maxFuel: meta.maxFuel,
        plate, number, pct: num(pct) ? Math.max(0, Math.min(100, pct)) : null,
        rangeKm, img, address
      });
    }
  }

  if (!vehicles.length) {
    return { statusCode: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: '[]' };
  }

  // de-dup
  const seen = new Set();
  const unique = vehicles.filter(v => {
    const key = `${v.plate || v.number || v.id || ''}|${v.lat.toFixed(6)}|${v.lng.toFixed(6)}`;
    if (seen.has(key)) return false; seen.add(key); return true;
  });

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' },
    body: JSON.stringify(unique)
  };
}