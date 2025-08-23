// Traficar proxy: maps regPlate (registration), sideNumber (fleet #), range (km).
export async function handler(event) {
  const origin = 'https://fioletowe.live';
  const zoneParam = event.queryStringParameters?.zoneId;
  const zoneIds = zoneParam ? [Number(zoneParam)] : Array.from({ length: 15 }, (_, i) => i + 1);

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
  const toNum = v => typeof v === 'string' ? parseFloat(v) : v;
  const fromE6Maybe = v => { const n = toNum(v); if (!num(n)) return undefined; return Math.abs(n) > 1000 ? n/1e6 : n; };

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

  // ---- registration (plate) & fleet/side number (number) ----
  function pickPlateAndNumber(x) {
    // From your sample: regPlate & sideNumber are the correct fields
    const plateCands = [
      x.regPlate, // <— NEW
      x.licensePlate, x.plate, x.plates, x.plateNumber,
      x.registration, x.registrationNumber, x.vehicleRegistrationNumber, x.numberPlate
    ];
    const numberCands = [
      x.sideNumber, // <— NEW
      x.number, x.carNumber, x.fleetNumber, x.callSign, x.code, x.shortCode, x.externalId, x.vehicleNumber
    ];
    // look also in common nested objects
    for (const k of ['vehicle','car','properties','details']) {
      const o = x[k];
      if (!o || typeof o !== 'object') continue;
      plateCands.push(o.regPlate, o.licensePlate, o.plate, o.plateNumber, o.registration, o.registrationNumber);
      numberCands.push(o.sideNumber, o.number, o.carNumber, o.fleetNumber, o.code);
    }
    const plate = plateCands.find(v => typeof v === 'string' && v.trim().length >= 4) || null;
    const number = numberCands.find(v => (typeof v === 'string' || typeof v === 'number') && String(v).trim().length >= 3) || null;
    return { plate: plate ? String(plate).trim().toUpperCase() : null,
             number: number != null ? String(number).trim().toUpperCase() : null };
  }

  function pickModelMeta(x) {
    const id = x.modelId ?? x.carModelId ?? x.model?.id ?? x.carModel?.id;
    if (id != null && modelById.has(Number(id))) return modelById.get(Number(id));
    return { name: x.modelName || x.name || x.model || x.vehicleModel || 'Vehicle', electric: !!(x.electric ?? x.isElectric), maxFuel: null };
  }

  function pickPct(x, isEv) {
    const norm = v => (typeof v === 'number' ? (v <= 1 && v >= 0 ? v*100 : v) : undefined);
    // From your sample: x.fuel is already a percentage (75.0)
    let batt = norm(x.battery ?? x.batteryLevel ?? x.batteryPercent ?? x.soc ?? x.SoC ?? x.charge);
    let fuel = norm(x.fuel); // <— fuel percent
    if (isEv) return (typeof batt === 'number') ? Math.max(0, Math.min(100, batt)) : (typeof fuel === 'number' ? Math.max(0, Math.min(100, fuel)) : null);
    return (typeof fuel === 'number') ? Math.max(0, Math.min(100, fuel)) : (typeof batt === 'number' ? Math.max(0, Math.min(100, batt)) : null);
  }

  function pickRangeKm(x) {
    // From your sample: x.range is km
    const c = [x.range, x.rangeKm, x.range_km, x.estimatedRangeKm, x.estimatedRange, x.remainingRange, x.distanceAvailable, x.distanceLeft, x.kmLeft, x.distanceKm];
    for (const v of c) { const n = toNum(v); if (num(n)) return Math.round(n); }
    const m = toNum(x.rangeMeters ?? x.distanceMeters);
    return num(m) ? Math.round(m/1000) : null;
  }

  // ---- fetch cars ----
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
      const data = await r.json();

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
          const pos = extractLatLng(item); if (!pos) continue;
          const meta = pickModelMeta(item);
          const { plate, number } = pickPlateAndNumber(item);
          const pct = pickPct(item, !!meta.electric);
          const rangeKm = pickRangeKm(item);
          const id = item.id ?? item.vehicleId ?? item.carId ?? item.code ?? null;
          const img = item.image || item.imageUrl || item.photoUrl || item.picture || item.pictureUrl || null;

          // Pass through textual location if provided (nice for popup)
          const address = typeof item.location === 'string' ? item.location : null;

          // Optionally skip unavailable cars; for now include all:
          // if (item.available === false) continue;

          acc.push({
            id, lat: pos.lat, lng: pos.lng,
            model: meta.name, isElectric: !!meta.electric, maxFuel: meta.maxFuel,
            plate: plate,                 // registration (e.g., "KR4SE75")
            number: number,               // fleet/side number (e.g., "3125")
            pct, rangeKm, img,
            address
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

  // de-dup
  const seen = new Set();
  out = out.filter(v => {
    const key = `${v.plate || v.number || ''}|${v.model || ''}|${v.lat}|${v.lng}`;
    if (seen.has(key)) return false; seen.add(key); return true;
  });

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' },
    body: JSON.stringify(out)
  };
}