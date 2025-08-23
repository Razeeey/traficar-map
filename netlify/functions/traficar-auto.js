// Traficar proxy: v1 cars + car-models join, robust coords, rich fields for the UI.
export async function handler(event) {
  const origin = 'https://fioletowe.live';
  const zoneParam = event.queryStringParameters?.zoneId; // optional: ?zoneId=1
  const zoneIds = zoneParam ? [Number(zoneParam)] : Array.from({ length: 15 }, (_, i) => i + 1);

  const headers = {
    accept: 'application/json',
    'user-agent': 'Mozilla/5.0',
    referer: `${origin}/`
  };

  // --- 1) fetch car models once (id -> {name, electric, maxFuel}) ---
  const modelById = new Map();
  try {
    const r = await fetch(`${origin}/api/v1/car-models`, { headers });
    const txt = await r.text();
    const data = JSON.parse(txt);
    const arr = Array.isArray(data) ? data : (data.carModels || data.items || data.data || []);
    for (const m of arr) {
      if (!m) continue;
      const id = m.id ?? m.modelId ?? m.code;
      if (id != null) modelById.set(Number(id), {
        name: m.name || m.model || 'Vehicle',
        electric: !!m.electric,
        maxFuel: typeof m.maxFuel === 'number' ? m.maxFuel : undefined  // liters (ICE) or kWh (EV)
      });
    }
  } catch {}

  // --- utils for coords & fields ---
  const num = n => typeof n === 'number' && isFinite(n);
  const toNum = v => typeof v === 'string' ? parseFloat(v) : v;
  const fromE6Maybe = v => {
    const n = toNum(v);
    if (!num(n)) return undefined;
    return Math.abs(n) > 1000 ? n / 1e6 : n;
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
    for (const key of ['location','position','gps','coords']) {
      if (obj[key]) { const got = extractLatLng(obj[key], depth + 1); if (got) return got; }
    }
    let anyLat, anyLon;
    for (const [k,v] of Object.entries(obj)) {
      if (typeof v === 'object') continue;
      if (k.toLowerCase().includes('lat')) anyLat = fromE6Maybe(v);
      if (k.toLowerCase().includes('lon') || k.toLowerCase().includes('lng')) anyLon = fromE6Maybe(v);
    }
    if (num(anyLat) && num(anyLon)) return { lat: anyLat, lng: anyLon };
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object') { const got = extractLatLng(v, depth + 1); if (got) return got; }
    }
    return null;
  }

  const pickPlate = x =>
    x.plate || x.plates || x.registration || x.registrationNumber ||
    x.license || x.licensePlate || x.plateNumber || '';

  const pickId = x => x.id ?? x.vehicleId ?? x.carId ?? x.code ?? x.number ?? null;

  function pickModelNameAndMeta(x) {
    const id = x.modelId ?? x.carModelId ?? x.model?.id ?? x.carModel?.id;
    if (id != null && modelById.has(Number(id))) {
      const m = modelById.get(Number(id));
      return { name: m.name, electric: !!m.electric, maxFuel: m.maxFuel };
    }
    return {
      name: x.modelName || x.name || x.model || x.vehicleModel || (x.properties && x.properties.model) || 'Vehicle',
      electric: !!(x.electric ?? x.isElectric),
      maxFuel: undefined
    };
  }

  function pickPct(x, electricFlag) {
    // prefer battery for EVs, fuel for ICE; normalize 0..1 → 0..100
    const norm = v => (typeof v === 'number' ? (v <= 1 && v >= 0 ? v*100 : v) : undefined);
    let batt = norm(x.battery ?? x.batteryLevel ?? x.batteryPercent ?? x.soc ?? x.SoC ?? x.charge);
    let fuel = norm(x.fuel ?? x.fuelLevel ?? x.fuelPercent);
    if (electricFlag) return (typeof batt === 'number') ? Math.max(0, Math.min(100, batt)) : (typeof fuel === 'number' ? Math.max(0, Math.min(100, fuel)) : null);
    return (typeof fuel === 'number') ? Math.max(0, Math.min(100, fuel)) : (typeof batt === 'number' ? Math.max(0, Math.min(100, batt)) : null);
  }

  function pickRangeKm(x) {
    const cands = [
      x.rangeKm, x.range_km, x.estimatedRangeKm, x.estimatedRange, x.remainingRange,
      x.distanceAvailable, x.distanceLeft, x.distance_km, x.distanceKm, x.kmLeft
    ];
    for (const v of cands) {
      const n = toNum(v);
      if (num(n)) return Math.round(n);
    }
    // sometimes meters:
    if (num(toNum(x.rangeMeters ?? x.distanceMeters))) return Math.round(toNum(x.rangeMeters ?? x.distanceMeters) / 1000);
    return null;
  }

  function pickImage(x) {
    return x.image || x.imageUrl || x.photoUrl || x.picture || x.pictureUrl || null;
  }

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

      const arrays = [];
      if (Array.isArray(data)) arrays.push(data);
      if (data && Array.isArray(data.cars)) arrays.push(data.cars);
      if (!arrays.length && data && typeof data === 'object') {
        const vals = Object.values(data);
        if (vals.length && vals.every(v => v && typeof v === 'object')) arrays.push(vals);
      }

      const acc = [];
      for (const arr of arrays) {
        for (const item of arr) {
          const pos = extractLatLng(item);
          if (!pos) continue;

          const { name, electric, maxFuel } = pickModelNameAndMeta(item);
          const pct = pickPct(item, electric);
          const plate = pickPlate(item);
          const rangeKm = pickRangeKm(item);
          const img = pickImage(item);
          const id = pickId(item);

          acc.push({
            id, lat: pos.lat, lng: pos.lng,
            model: name, plate, pct, isElectric: electric,
            maxFuel: (typeof maxFuel === 'number' ? maxFuel : null),
            rangeKm: (typeof rangeKm === 'number' ? rangeKm : null),
            img
          });
        }
      }
      if (acc.length) { out = acc; break; }
    } catch {}
  }

  if (!out.length) {
    return { statusCode: 502, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'No vehicles found', tried }) };
  }

  // de-dup by plate+coords
  const seen = new Set();
  out = out.filter(v => {
    const key = `${v.plate || ''}|${v.model || ''}|${v.lat.toFixed(6)}|${v.lng.toFixed(6)}`;
    if (seen.has(key)) return false; seen.add(key); return true;
  });

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' },
    body: JSON.stringify(out)
  };
}
