// Traficar proxy — city filter + smarter availability + faster fetching.
export async function handler(event) {
  const origin = 'https://fioletowe.live';
  const q = event.queryStringParameters || {};
  const cityParam = (q.city || '').toLowerCase().trim();
  const zoneParam = q.zoneId;           // optional: debug single zone
  const includeAll = q.all === '1';     // &all=1 => include rented/reserved too

  // Try first 15 zones (fast, usually enough)
  const zoneIds = zoneParam ? [Number(zoneParam)] : Array.from({ length: 15 }, (_, i) => i + 1);

  // City centers (same keys as dropdown)
  const centers = {
    krakow:[50.0614,19.9383], warszawa:[52.2297,21.0122], wroclaw:[51.1079,17.0385],
    poznan:[52.4064,16.9252], trojmiasto:[54.3722,18.6383], slask:[50.2649,19.0238],
    lublin:[51.2465,22.5684], lodz:[51.7592,19.4550], szczecin:[53.4285,14.5528], rzeszow:[50.0413,21.9990]
  };
  const center = centers[cityParam] || null;
  const CITY_RADIUS_KM = 120;

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
  const toNum = v => typeof v === 'string' ? parseFloat(v) : v;
  const num = n => typeof n === 'number' && isFinite(n);
  const fromE6Maybe = v => { const n = toNum(v); if (!num(n)) return undefined; return Math.abs(n) > 1000 ? n/1e6 : n; };
  const toRad = d => d*Math.PI/180;
  const haversineKm = (a,b)=>{const R=6371,dLat=toRad(b[0]-a[0]),dLon=toRad(b[1]-a[1]);const A=Math.sin(dLat/2)**2+Math.cos(toRad(a[0]))*Math.cos(toRad(b[0]))*Math.sin(dLon/2)**2;return R*2*Math.atan2(Math.sqrt(A),Math.sqrt(1-A));};

  function extractLatLng(obj, depth=0){
    if (!obj || typeof obj!=='object' || depth>6) return null;
    let lat = obj.lat ?? obj.latitude ?? obj.latE6 ?? obj.latitudeE6;
    let lng = obj.lng ?? obj.lon ?? obj.longitude ?? obj.lonE6 ?? obj.longitudeE6;
    lat = fromE6Maybe(lat); lng = fromE6Maybe(lng);
    if (num(lat) && num(lng)) return {lat,lng};
    const g = obj.geometry;
    if (g && Array.isArray(g.coordinates) && g.coordinates.length>=2){
      const LON = toNum(g.coordinates[0]), LAT = toNum(g.coordinates[1]);
      if (num(LAT)&&num(LON)) return {lat:LAT,lng:LON};
    }
    for (const k of ['location','position','gps','coords']){
      if (obj[k]){ const got = extractLatLng(obj[k], depth+1); if (got) return got; }
    }
    return null;
  }

  function modelMeta(x){
    const id = x.modelId ?? x.carModelId ?? x.model?.id ?? x.carModel?.id;
    if (id!=null && modelById.has(Number(id))) return modelById.get(Number(id));
    return { name: x.modelName || x.name || x.model || 'Vehicle', electric: !!(x.electric ?? x.isElectric), maxFuel: null };
  }

  // Map fields from API sample:
  // regPlate = registration, sideNumber = fleet badge; range (km), fuel (%), location (address)
  const mapFields = x => ({
    plate: x.regPlate ? String(x.regPlate).trim().toUpperCase() : null,
    number: (x.sideNumber!=null) ? String(x.sideNumber).trim().toUpperCase() : null,
    rangeKm: num(toNum(x.range)) ? Math.round(toNum(x.range)) : null,
    pct: num(toNum(x.fuel)) ? Math.round(toNum(x.fuel)) : null,
    address: typeof x.location === 'string' ? x.location : null
  });

  // Availability: treat available:false as "unknown" unless other busy signals present.
  function looksBusy(x){
    if (x.reserved === true || x.isReserved === true) return true;
    if (x.isRented === true || x.rented === true) return true;
    if (x.reservationId != null) return true;
    if (typeof x.status === 'string') {
      const s = x.status.toUpperCase();
      if (/(RENT|BUSY|RESERV|OCCUP|UNAVAIL|TAKEN)/.test(s)) return true;
    }
    return false;
  }
  function isAvailable(x){
    if (includeAll) return true;
    if (x.available === true) return true;       // explicit free
    if (looksBusy(x)) return false;              // clear busy
    // NOTE: x.available === false -> don't auto-exclude; treat as unknown => include
    return true;
  }

  // ---- fetch with small concurrency ----
  async function fetchZone(zid){
    const url = `${origin}/api/v1/cars?zoneId=${zid}&lastUpdate=0`;
    try {
      const r = await fetch(url, { headers });
      if (!r.ok) return [];
      const data = await r.json();
      const list = Array.isArray(data) ? data : (Array.isArray(data.cars) ? data.cars : []);
      const out = [];
      for (const item of list) {
        if (!isAvailable(item)) continue;
        const pos = extractLatLng(item); if (!pos) continue;
        if (center && haversineKm(center, [pos.lat,pos.lng]) > CITY_RADIUS_KM) continue;

        const meta = modelMeta(item);
        const f = mapFields(item);
        const img = item.image || item.imageUrl || item.photoUrl || item.picture || item.pictureUrl || null;
        const carId = item.id ?? item.vehicleId ?? item.carId ?? item.code ?? null;

        out.push({
          id: carId, lat: pos.lat, lng: pos.lng,
          model: meta.name, isElectric: !!meta.electric, maxFuel: meta.maxFuel,
          plate: f.plate, number: f.number, pct: num(f.pct)?Math.max(0,Math.min(100,f.pct)):null,
          rangeKm: f.rangeKm, img, address: f.address
        });
      }
      return out;
    } catch { return []; }
  }

  const limit = 5;  // quick but polite
  let idx = 0;
  const results = [];
  async function worker(){
    while (idx < zoneIds.length){
      const my = idx++;
      const arr = await fetchZone(zoneIds[my]);
      results.push(...arr);
      await new Promise(r => setTimeout(r, 60));
    }
  }
  await Promise.all(Array(Math.min(limit, zoneIds.length)).fill(0).map(worker));

  // If somehow empty AND we were filtering, try once more including all (fallback)
  if (!results.length && !includeAll) {
    const everything = [];
    idx = 0;
    async function workerAll(){
      while (idx < zoneIds.length){
        const my = idx++;
        const url = `${origin}/api/v1/cars?zoneId=${zoneIds[my]}&lastUpdate=0`;
        try{
          const r = await fetch(url, { headers });
          if (!r.ok) { await new Promise(rr=>setTimeout(rr,60)); continue; }
          const data = await r.json();
          const list = Array.isArray(data) ? data : (Array.isArray(data.cars) ? data.cars : []);
          for (const item of list){
            const pos = extractLatLng(item); if (!pos) continue;
            if (center && haversineKm(center, [pos.lat,pos.lng]) > CITY_RADIUS_KM) continue;
            const meta = modelMeta(item);
            const f = mapFields(item);
            const img = item.image || item.imageUrl || item.photoUrl || item.picture || item.pictureUrl || null;
            const carId = item.id ?? item.vehicleId ?? item.carId ?? item.code ?? null;
            everything.push({
              id: carId, lat: pos.lat, lng: pos.lng,
              model: meta.name, isElectric: !!meta.electric, maxFuel: meta.maxFuel,
              plate: f.plate, number: f.number, pct: num(f.pct)?Math.max(0,Math.min(100,f.pct)):null,
              rangeKm: f.rangeKm, img, address: f.address
            });
          }
        } catch {}
        await new Promise(rr=>setTimeout(rr,60));
      }
    }
    await Promise.all(Array(Math.min(limit, zoneIds.length)).fill(0).map(workerAll));
    if (everything.length) {
      // still de-dup and return (shows cars even if busy flags were odd)
      const seen = new Set();
      const unique = everything.filter(v => {
        const key = `${v.plate||v.number||v.id||''}|${v.lat.toFixed(6)}|${v.lng.toFixed(6)}`;
        if (seen.has(key)) return false; seen.add(key); return true;
      });
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' },
        body: JSON.stringify(unique)
      };
    }
  }

  if (!results.length) {
    return { statusCode: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: '[]' };
  }

  const seen = new Set();
  const unique = results.filter(v => {
    const key = `${v.plate||v.number||v.id||''}|${v.lat.toFixed(6)}|${v.lng.toFixed(6)}`;
    if (seen.has(key)) return false; seen.add(key); return true;
  });

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' },
    body: JSON.stringify(unique)
  };
}