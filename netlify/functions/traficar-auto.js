// Traficar proxy — sequential zone fetch, ?city filtering, proper fields.
export async function handler(event) {
  const origin = 'https://fioletowe.live';
  const cityParam = (event.queryStringParameters?.city || '').toLowerCase().trim();
  const zoneParam = event.queryStringParameters?.zoneId; // optional: debug single zone
  // try first 30 zones; adjust if needed
  const zoneIds = zoneParam ? [Number(zoneParam)] : Array.from({ length: 30 }, (_, i) => i + 1);

  const centers = {
    krakow:[50.0614,19.9383], warszawa:[52.2297,21.0122], wroclaw:[51.1079,17.0385],
    poznan:[52.4064,16.9252], trojmiasto:[54.3722,18.6383], slask:[50.2649,19.0238],
    lublin:[51.2465,22.5684], lodz:[51.7592,19.4550], szczecin:[53.4285,14.5528], rzeszow:[50.0413,21.9990]
  };
  const center = centers[cityParam] || null;
  const CITY_RADIUS_KM = 150; // generous enough for metro areas

  const headers = { accept: 'application/json', 'user-agent': 'Mozilla/5.0', referer: `${origin}/` };

  // ---- fetch models once (for maxFuel + EV flag) ----
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

  // regPlate = registration, sideNumber = fleet badge; range (km); fuel (%) per your sample
  const mapFields = x => ({
    plate: x.regPlate ? String(x.regPlate).trim().toUpperCase() : null,
    number: (x.sideNumber!=null) ? String(x.sideNumber).trim().toUpperCase() : null,
    rangeKm: num(toNum(x.range)) ? Math.round(toNum(x.range)) : null,
    pct: num(toNum(x.fuel)) ? Math.round(toNum(x.fuel)) : null
  });

  // ---- sequential zone fetch (polite) ----
  const vehicles = [];
  for (const id of zoneIds) {
    const url = `${origin}/api/v1/cars?zoneId=${id}&lastUpdate=0`;
    try {
      const r = await fetch(url, { headers });
      if (!r.ok) { await new Promise(res=>setTimeout(res,120)); continue; }
      const data = await r.json();
      const list = Array.isArray(data) ? data : (Array.isArray(data.cars) ? data.cars : []);
      for (const item of list) {
        const pos = extractLatLng(item); if (!pos) continue;
        if (center && haversineKm(center, [pos.lat,pos.lng]) > CITY_RADIUS_KM) continue;

        const meta = modelMeta(item);
        const { plate, number, rangeKm, pct } = mapFields(item);
        const address = typeof item.location === 'string' ? item.location : null;
        const img = item.image || item.imageUrl || item.photoUrl || item.picture || item.pictureUrl || null;
        const carId = item.id ?? item.vehicleId ?? item.carId ?? item.code ?? null;

        vehicles.push({
          id: carId, lat: pos.lat, lng: pos.lng,
          model: meta.name, isElectric: !!meta.electric, maxFuel: meta.maxFuel,
          plate, number, pct: num(pct)?Math.max(0,Math.min(100,pct)):null,
          rangeKm, img, address
        });
      }
      // small delay to avoid rate limiting
      await new Promise(res=>setTimeout(res,120));
    } catch {
      await new Promise(res=>setTimeout(res,150));
    }
  }

  if (!vehicles.length) {
    return { statusCode: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: '[]' };
  }

  // de-dup
  const seen = new Set();
  const unique = vehicles.filter(v => {
    const key = `${v.plate||v.number||v.id||''}|${v.lat.toFixed(6)}|${v.lng.toFixed(6)}`;
    if (seen.has(key)) return false; seen.add(key); return true;
  });

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' },
    body: JSON.stringify(unique)
  };
}