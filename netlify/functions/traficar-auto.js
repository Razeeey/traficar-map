// Traficar proxy — city-only filter, available cars, numeric coords, fast & polite.
export async function handler(event) {
  const origin = 'https://fioletowe.live';
  const q = event.queryStringParameters || {};
  const cityParam = (q.city || '').toLowerCase().trim();
  const zoneParam = q.zoneId;  // optional single zone for debugging

  // Probe up to 24 zones (good coverage, still fast)
  const zoneIds = zoneParam ? [Number(zoneParam)] : Array.from({ length: 24 }, (_, i) => i + 1);

  // City centers & tight radii (km) — adjust if needed
  const CITY = {
    krakow:     { c:[50.0614,19.9383], r:18 },
    warszawa:   { c:[52.2297,21.0122], r:28 },
    wroclaw:    { c:[51.1079,17.0385], r:18 },
    poznan:     { c:[52.4064,16.9252], r:20 },
    trojmiasto: { c:[54.3722,18.6383], r:35 }, // Gdańsk+Sopot+Gdynia
    slask:      { c:[50.2649,19.0238], r:35 }, // Katowice agglo
    lublin:     { c:[51.2465,22.5684], r:18 },
    lodz:       { c:[51.7592,19.4550], r:20 },
    szczecin:   { c:[53.4285,14.5528], r:20 },
    rzeszow:    { c:[50.0413,21.9990], r:18 }
  };
  const cityCfg = CITY[cityParam] || CITY.krakow;

  const headers = { accept: 'application/json', 'user-agent': 'Mozilla/5.0', referer: `${origin}/` };

  // Models (maxFuel + EV flag)
  const modelById = new Map();
  try {
    const r = await fetch(`${origin}/api/v1/car-models`, { headers });
    const data = await r.json();
    const arr = Array.isArray(data) ? data : (data.carModels || data.items || data.data || []);
    for (const m of arr || []) {
      const id = m?.id ?? m?.modelId ?? m?.code;
      if (id != null) modelById.set(Number(id), {
        name: m.name || m.model || 'Vehicle',
        electric: !!m.electric,
        maxFuel: (typeof m.maxFuel === 'number' ? m.maxFuel : null)
      });
    }
  } catch {}

  // utils
  const toNum = v => (typeof v === 'string' ? parseFloat(v) : v);
  const isNum = n => typeof n === 'number' && isFinite(n);
  const toRad = d => d*Math.PI/180;
  const distKm = (a,b)=>{const R=6371,dLat=toRad(b[0]-a[0]),dLon=toRad(b[1]-a[1]);const A=Math.sin(dLat/2)**2+Math.cos(toRad(a[0]))*Math.cos(toRad(b[0]))*Math.sin(dLon/2)**2;return R*2*Math.atan2(Math.sqrt(A),Math.sqrt(1-A));};

  function extractLatLng(x){
    let lat = x.lat ?? x.latitude, lng = x.lng ?? x.lon ?? x.longitude;
    lat = toNum(lat); lng = toNum(lng);
    if (isNum(lat) && isNum(lng)) return {lat, lng};
    if (x.geometry?.coordinates?.length >= 2) {
      const LON = toNum(x.geometry.coordinates[0]), LAT = toNum(x.geometry.coordinates[1]);
      if (isNum(LAT) && isNum(LON)) return {lat: LAT, lng: LON};
    }
    return null;
  }

  function modelMeta(x){
    const id = x.modelId ?? x.carModelId ?? x.model?.id ?? x.carModel?.id;
    if (id!=null && modelById.has(Number(id))) return modelById.get(Number(id));
    return { name: x.modelName || x.name || x.model || 'Vehicle', electric: !!(x.electric ?? x.isElectric), maxFuel: null };
  }

  function mapFields(x){
    const pct = toNum(x.fuel);       // % in sample
    const rangeKm = toNum(x.range);  // km in sample
    return {
      plate: x.regPlate ? String(x.regPlate).trim().toUpperCase() : null,
      number: (x.sideNumber!=null) ? String(x.sideNumber).trim().toUpperCase() : null,
      pct: isNum(pct) ? Math.round(Math.max(0, Math.min(100, pct))) : null,
      rangeKm: isNum(rangeKm) ? Math.round(rangeKm) : null,
      address: typeof x.location === 'string' ? x.location : null,
      status: typeof x.status === 'string' ? x.status : null,
      reserved: x.reserved ?? x.isReserved,
      rented: x.isRented ?? x.rented,
      available: x.available
    };
  }

  function isBusy(f){
    if (f.reserved === true) return true;
    if (f.rented === true) return true;
    if (typeof f.status === 'string' && /(RENT|RENTED|BUSY|RESERV|OCCUP|UNAVAIL|TAKEN|MAINT)/i.test(f.status)) return true;
    return false;
  }

  async function fetchZone(zid){
    const url = `${origin}/api/v1/cars?zoneId=${zid}&lastUpdate=0`;
    try {
      const r = await fetch(url, { headers });
      if (!r.ok) return [];
      const data = await r.json();
      const list = Array.isArray(data) ? data : (Array.isArray(data.cars) ? data.cars : []);
      const out = [];
      for (const item of list) {
        const pos = extractLatLng(item); if (!pos) continue;
        const lat = Number(pos.lat), lng = Number(pos.lng);
        if (!isNum(lat) || !isNum(lng)) continue;

        // CITY-ONLY: drop anything outside the city's radius
        if (distKm(cityCfg.c, [lat, lng]) > cityCfg.r) continue;

        const meta = modelMeta(item);
        const f = mapFields(item);
        if (isBusy(f)) continue;  // only available

        out.push({
          id: item.id ?? item.vehicleId ?? item.carId ?? item.code ?? null,
          lat, lng,
          model: meta.name, isElectric: !!meta.electric, maxFuel: meta.maxFuel,
          plate: f.plate, number: f.number, pct: f.pct, rangeKm: f.rangeKm,
          img: item.image || item.imageUrl || item.photoUrl || item.picture || item.pictureUrl || null,
          address: f.address
        });
      }
      return out;
    } catch { return []; }
  }

  // small concurrency
  const limit = 6;
  let idx = 0;
  const results = [];
  async function worker(){
    while (idx < zoneIds.length){
      const my = idx++;
      const arr = await fetchZone(zoneIds[my]);
      results.push(...arr);
      await new Promise(r => setTimeout(r, 80));
    }
  }
  await Promise.all(Array(Math.min(limit, zoneIds.length)).fill(0).map(worker));

  // de-dup
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