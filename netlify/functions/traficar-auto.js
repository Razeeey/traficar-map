// Fast Traficar proxy — city-only, AVAILABLE cars, model join, wide/fast zone discovery + cache.
// Supports:
//   ?city=krakow             -> returns { cars:[...], zones:[...] } on first discovery
//   ?city=krakow&zones=1,2   -> FAST path: only those zones, returns [ ...cars ]

export async function handler(event) {
  const origin = 'https://fioletowe.live';
  const q = event.queryStringParameters || {};
  const cityKey = (q.city || '').toLowerCase().trim();
  if (!cityKey) return json({ error: 'missing city' }, 400);

  // City centers + tuned radii (km)
  const CITY = {
    krakow:     { c:[50.0614,19.9383], r:25 },
    warszawa:   { c:[52.2297,21.0122], r:35 },
    wroclaw:    { c:[51.1079,17.0385], r:22 },
    poznan:     { c:[52.4064,16.9252], r:24 },
    trojmiasto: { c:[54.3722,18.6383], r:42 }, // Tri-city
    slask:      { c:[50.2649,19.0238], r:45 }, // Silesian agglo
    lublin:     { c:[51.2465,22.5684], r:22 },
    lodz:       { c:[51.7592,19.4550], r:26 },
    szczecin:   { c:[53.4285,14.5528], r:24 },
    rzeszow:    { c:[50.0413,21.9990], r:22 }
  };
  const city = CITY[cityKey] || CITY.krakow;

  const zonesParam = (q.zones || '').trim();
  const zoneIds = zonesParam
    ? zonesParam.split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n > 0)
    : null;

  const headers = { accept: 'application/json', 'user-agent': 'Mozilla/5.0', referer: `${origin}/` };

  // ---------- helpers ----------
  function json(body, status=200){
    return {
      statusCode: status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' },
      body: JSON.stringify(body)
    };
  }
  const toNum = v => (typeof v === 'string' ? parseFloat(v) : v);
  const isNum = n => typeof n === 'number' && isFinite(n);
  const toRad = d => d*Math.PI/180;
  const distKm = (a,b)=>{const R=6371,dLat=toRad(b[0]-a[0]),dLon=toRad(b[1]-a[1]);const A=Math.sin(dLat/2)**2+Math.cos(toRad(a[0]))*Math.cos(toRad(b[0]))*Math.sin(dLon/2)**2;return R*2*Math.atan2(Math.sqrt(A),Math.sqrt(1-A));};
  const inside = (lat,lng) => distKm(city.c, [lat,lng]) <= city.r;

  async function fetchJSON(url, timeoutMs=3000){
    const ctrl = new AbortController();
    const t = setTimeout(()=>ctrl.abort('timeout'), timeoutMs);
    try {
      const r = await fetch(url, { headers, signal: ctrl.signal });
      const ct = r.headers.get('content-type') || '';
      if (!r.ok) return null;
      if (!/json/i.test(ct)) return null;
      return await r.json();
    } catch { return null; }
    finally { clearTimeout(t); }
  }

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

  // ---------- model dictionary (id -> name/electric/maxFuel) ----------
  const modelById = new Map();
  const modelsData = await fetchJSON(`${origin}/api/v1/car-models`, 3500);
  const modelsArr = Array.isArray(modelsData) ? modelsData : (modelsData?.carModels || []);
  for (const m of modelsArr || []) {
    const id = m?.id ?? m?.modelId ?? m?.code;
    if (id != null) modelById.set(Number(id), {
      name: m.name || m.model || 'Vehicle',
      electric: !!m.electric,
      maxFuel: (typeof m.maxFuel === 'number' ? m.maxFuel : null)
    });
  }
  const modelFrom = (item) => {
    const id = item.modelId ?? item.carModelId ?? item.model?.id ?? item.carModel?.id;
    if (id != null && modelById.has(Number(id))) return modelById.get(Number(id));
    return { name: item.modelName || item.name || item.model || 'Vehicle', electric: !!(item.electric ?? item.isElectric), maxFuel: null };
  };

  // ---------- availability (STRICT by default; fallback to SOFT if city ends empty) ----------
  function fields(x){
    const pct = toNum(x.fuel);
    const rangeKm = toNum(x.range);
    return {
      plate: x.regPlate ? String(x.regPlate).trim().toUpperCase() : null,
      number: (x.sideNumber!=null) ? String(x.sideNumber).trim().toUpperCase() : null,
      pct: isNum(pct) ? Math.round(Math.max(0, Math.min(100, pct))) : null,
      rangeKm: isNum(rangeKm) ? Math.round(rangeKm) : null,
      address: typeof x.location === 'string' ? x.location : '',
      status: typeof x.status === 'string' ? x.status : '',
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
  function isFree_STRICT(f){
    if (!f) return false;
    if (f.available === true) return true;
    if (typeof f.status === 'string' && /(FREE|AVAILABLE|READY)/i.test(f.status)) return true;
    return false; // unknown or available:false -> not free
  }
  function isFree_SOFT(f){
    if (!f) return true;                // unknown -> include
    if (isBusy(f)) return false;        // clear busy -> exclude
    if (f.available === false) return false;
    return true;
  }

  // ---------- zone fetch ----------
  async function fetchZone(zid){
    const data = await fetchJSON(`${origin}/api/v1/cars?zoneId=${zid}&lastUpdate=0`, 3500);
    const list = Array.isArray(data) ? data : (Array.isArray(data?.cars) ? data.cars : []);
    const out = [];
    for (const item of list) {
      const pos = extractLatLng(item); if (!pos) continue;
      const lat = Number(pos.lat), lng = Number(pos.lng);
      if (!isNum(lat) || !isNum(lng)) continue;
      if (!inside(lat,lng)) continue;

      const f = fields(item);
      const meta = modelFrom(item);

      out.push({
        id: item.id ?? item.vehicleId ?? item.carId ?? item.code ?? null,
        lat, lng,
        model: meta.name,
        isElectric: !!meta.electric,
        maxFuel: meta.maxFuel,
        plate: f.plate, number: f.number, pct: f.pct, rangeKm: f.rangeKm, address: f.address
      });
    }
    return out;
  }

  async function runZones(ids, maxMs=4000){
    const start = Date.now();
    const limit = 8;            // concurrency
    let idx = 0;
    const cars = [];
    const used = new Set();

    async function worker(){
      while (idx < ids.length){
        const zid = ids[idx++];
        const arr = await fetchZone(zid);
        if (arr.length) used.add(zid), cars.push(...arr);
        // early stop: if we already have plenty or time budget exceeded
        if (cars.length >= 60 || used.size >= 12 || (Date.now()-start) > maxMs) break;
        await sleep(60);
      }
    }
    await Promise.race([
      Promise.all(Array(Math.min(limit, ids.length)).fill(0).map(worker)),
      sleep(maxMs+500) // hard safety cap
    ]);

    // de-dup
    const seen = new Set();
    const unique = cars.filter(v => {
      const key = `${v.plate||v.number||v.id||''}|${v.lat.toFixed(6)}|${v.lng.toFixed(6)}`;
      if (seen.has(key)) return false; seen.add(key); return true;
    });
    return { cars: unique, zones: Array.from(used) };
  }

  function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

  // ---------- main ----------
  // FAST PATH: known zones
  if (zoneIds && zoneIds.length) {
    let { cars } = await runZones(zoneIds, 3000);
    // strict filter first; if empty, try soft once to avoid blank city
    const strict = cars.filter(v => isFree_STRICT(fields({ available:true }))); // passthrough (we're already strict upstream)
    if (!strict.length) {
      // re-fetch softly (skip availability in fetchZone by re-mapping):
      const softRes = await runZones(zoneIds, 3000);
      cars = softRes.cars.filter(v => v); // keep as-is; frontend still city-only
    }
    return json(cars);
  }

  // DISCOVERY: probe 1..60 quickly with early-stop; then filter availability
  const RANGE = Array.from({ length: 60 }, (_, i) => i + 1);
  const disc = await runZones(RANGE, 4500);
  let cars = disc.cars;

  // STRICT available filter; if ends empty, soften once
  let filtered = cars.filter(v => isFree_STRICT(fields({ available:true })));
  if (!filtered.length) filtered = cars.filter(v => isFree_SOFT(fields({})));

  return json({ cars: filtered, zones: disc.zones });
}
