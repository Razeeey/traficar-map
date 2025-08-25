// Traficar proxy — city-only, AVAILABLE ONLY, fast soft+strict discovery + KNOWN_ZONES.
// First call without zones: discover zones with a "soft" pass (any non-busy cars) so we *always* learn zones,
// then fetch those zones again *strictly* (available-only). Returns { cars, zones }.
// When zones are known (via KNOWN_ZONES, cache, or ?zones=...), it returns [ cars ] fast.
// Add &includeZones=1 to always get { cars, zones } for debugging in your browser.

let CITY_STATE = Object.create(null); // warm cache while function instance is alive

export async function handler(event) {
  const origin = 'https://fioletowe.live';
  const q = event.queryStringParameters || {};
  const cityKey = (q.city || '').toLowerCase().trim();
  if (!cityKey) return json({ error: 'missing city' }, 400);

  // City centers + radii (km) — widened Wrocław
  const CITY = {
    krakow:     { c:[50.0614,19.9383], r:25 },
    warszawa:   { c:[52.2297,21.0122], r:35 },
    wroclaw:    { c:[51.1079,17.0385], r:35 }, // ↑ was 22
    poznan:     { c:[52.4064,16.9252], r:24 },
    trojmiasto: { c:[54.3722,18.6383], r:42 },
    slask:      { c:[50.2649,19.0238], r:45 },
    lublin:     { c:[51.2465,22.5684], r:22 },
    lodz:       { c:[51.7592,19.4550], r:26 },
    szczecin:   { c:[53.4285,14.5528], r:24 },
    rzeszow:    { c:[50.0413,21.9990], r:22 }
  };
  const city = CITY[cityKey] || CITY.krakow;

  // 🚀 Fill these as you learn them to make cities instant.
  const KNOWN_ZONES = {
    krakow:    [1, 6],
    warszawa:  [],
    wroclaw:   [],       // we'll discover these below
    poznan:    [],
    trojmiasto:[],
    slask:     [6],      // from your test
    lublin:    [],
    lodz:      [],
    szczecin:  [],
    rzeszow:   []
  };

  const includeZones = q.includeZones === '1';
  const zonesParam = (q.zones || '').trim();
  const zonesFromQS = zonesParam ? zonesParam.split(',').map(s=>Number(s.trim())).filter(n=>Number.isFinite(n)&&n>0) : null;

  // Per-city warm state
  const S = CITY_STATE[cityKey] ||= { zones: [], zonesTs: 0 };

  // Prefer zones in this order
  let zones = null;
  if (Array.isArray(KNOWN_ZONES[cityKey]) && KNOWN_ZONES[cityKey].length) zones = KNOWN_ZONES[cityKey];
  else if (zonesFromQS && zonesFromQS.length) zones = zonesFromQS;
  else if (S.zones && S.zones.length && (Date.now()-S.zonesTs)<10*60*1000) zones = S.zones;

  const headers = { accept:'application/json', 'user-agent':'Mozilla/5.0', referer: `${origin}/` };

  // ---------- helpers ----------
  function json(body, status=200){
    return { statusCode: status, headers: { 'content-type':'application/json', 'cache-control':'no-store', 'access-control-allow-origin':'*' }, body: JSON.stringify(body) };
  }
  const toNum = v => (typeof v === 'string' ? parseFloat(v) : v);
  const isNum = n => typeof n === 'number' && isFinite(n);
  const toRad = d => d*Math.PI/180;
  const distKm = (a,b)=>{ const R=6371, dLat=toRad(b[0]-a[0]), dLon=toRad(b[1]-a[1]); const A=Math.sin(dLat/2)**2+Math.cos(toRad(a[0]))*Math.cos(toRad(b[0]))*Math.sin(dLon/2)**2; return R*2*Math.atan2(Math.sqrt(A),Math.sqrt(1-A)); };
  const inside = (lat,lng) => distKm(city.c, [lat,lng]) <= city.r;

  async function fetchJSON(url, timeoutMs=2400){
    const ctrl = new AbortController();
    const t = setTimeout(()=>ctrl.abort('timeout'), timeoutMs);
    try{
      const r = await fetch(url, { headers, signal: ctrl.signal });
      if (!r.ok) return null;
      const ct = r.headers.get('content-type')||'';
      if (!/json/i.test(ct)) return null;
      return await r.json();
    }catch{ return null; } finally{ clearTimeout(t); }
  }

  function extractLatLng(x){
    let lat = x.lat ?? x.latitude ?? x.latE6, lng = x.lng ?? x.lon ?? x.longitude ?? x.lngE6;
    lat = toNum(lat); lng = toNum(lng);
    if (Math.abs(lat)>1000) lat/=1e6;
    if (Math.abs(lng)>1000) lng/=1e6;
    if (isNum(lat)&&isNum(lng)) return {lat,lng};
    if (x.geometry?.coordinates?.length>=2){
      const LON = toNum(x.geometry.coordinates[0]), LAT = toNum(x.geometry.coordinates[1]);
      if (isNum(LAT)&&isNum(LON)) return {lat:LAT,lng:LON};
    }
    return null;
  }

  // ---------- model names ----------
  const modelById = new Map();
  try{
    const md = await fetchJSON(`${origin}/api/v1/car-models`, 3000);
    const arr = Array.isArray(md) ? md : (md?.carModels || []);
    for (const m of arr||[]){
      const id = m?.id ?? m?.modelId ?? m?.code;
      if (id!=null) modelById.set(Number(id), { name:m.name || m.model || 'Vehicle', electric:!!m.electric, maxFuel:(typeof m.maxFuel==='number'?m.maxFuel:null) });
    }
  }catch{}

  const modelFrom = (item)=>{
    const id = item.modelId ?? item.carModelId ?? item.model?.id ?? item.carModel?.id;
    if (id!=null && modelById.has(Number(id))) return modelById.get(Number(id));
    return { name:item.modelName || item.name || item.model || 'Vehicle', electric:!!(item.electric ?? item.isElectric), maxFuel:null };
  };

  // ---------- availability ----------
  function fields(x){
    const pct = toNum(x.fuel), rangeKm = toNum(x.range);
    return {
      plate: x.regPlate ? String(x.regPlate).trim().toUpperCase() : null,
      number: (x.sideNumber!=null) ? String(x.sideNumber).trim().toUpperCase() : null,
      pct: isNum(pct) ? Math.round(Math.max(0,Math.min(100,pct))) : null,
      rangeKm: isNum(rangeKm) ? Math.round(rangeKm) : null,
      address: typeof x.location === 'string' ? x.location : '',
      available: x.available ?? x.isAvailable ?? x.availableNow ?? x.free ?? x.isFree,
      reserved:  x.reserved ?? x.isReserved ?? x.reservationActive ?? (x.reservationId!=null),
      rented:    x.isRented ?? x.rented ?? x.inRental ?? x.inUse,
      status:    x.status ?? x.statusText ?? x.state ?? x.availability ?? ''
    };
  }
  function isBusy(f){
    if (f.reserved === true) return true;
    if (f.rented === true) return true;
    if (typeof f.status === 'string' && /(RENT|RENTED|BUSY|RESERV|OCCUP|UNAVAIL|TAKEN|MAINT|SERVICE|IN_USE)/i.test(f.status)) return true;
    return false;
  }
  function isFree_STRICT(f){
    if (!f) return false;
    if (isBusy(f)) return false;
    if (f.available === true) return true;
    if (typeof f.status === 'string' && /(FREE|AVAILABLE|READY|IDLE|OPEN)/i.test(f.status)) return true;
    return false; // unknown -> not free
  }
  function isFree_SOFT(f){
    if (!f) return true;            // unknown -> include for discovery
    if (isBusy(f)) return false;    // obvious busy -> exclude
    if (f.available === false) return false;
    return true;
  }

  // ---------- zone fetch (mode: 'strict' | 'soft') ----------
  async function fetchZone(zid, mode='strict'){
    const data = await fetchJSON(`${origin}/api/v1/cars?zoneId=${zid}&lastUpdate=0`, 2200);
    const list = Array.isArray(data) ? data : (Array.isArray(data?.cars) ? data.cars : []);
    const out = [];
    for (const item of list){
      const pos = extractLatLng(item); if (!pos) continue;
      const lat = Number(pos.lat), lng = Number(pos.lng);
      if (!isNum(lat)||!isNum(lng)) continue;
      if (!inside(lat,lng)) continue;

      const f = fields(item);
      if (mode === 'strict' && !isFree_STRICT(f)) continue;
      if (mode === 'soft'   && !isFree_SOFT(f))   continue;

      const meta = modelFrom(item);
      out.push({
        id: item.id ?? item.vehicleId ?? item.carId ?? item.code ?? null,
        lat, lng,
        model: meta.name, isElectric: !!meta.electric, maxFuel: meta.maxFuel,
        plate: f.plate, number: f.number, pct: f.pct, rangeKm: f.rangeKm, address: f.address
      });
    }
    return out;
  }

  async function runZones(ids, mode='strict'){
    const limit = 12; // high concurrency, still polite
    let idx = 0;
    const cars = [];
    const used = new Set();

    async function worker(){
      while (idx < ids.length){
        const zid = ids[idx++];
        const arr = await fetchZone(zid, mode);
        if (arr.length){ used.add(zid); cars.push(...arr); }
        await sleep(35);
      }
    }
    await Promise.all(Array(Math.min(limit, ids.length)).fill(0).map(worker));

    // de-dup
    const seen = new Set();
    const unique = cars.filter(v => {
      const key = `${v.plate||v.number||v.id||''}|${v.lat.toFixed(6)}|${v.lng.toFixed(6)}`;
      if (seen.has(key)) return false; seen.add(key); return true;
    });
    return { cars: unique, zones: Array.from(used) };
  }

  async function discoverZonesSoftThenStrict(){
    // Probe a wide range once with SOFT filter just to learn zones (works even if no free cars now)
    const RANGE = Array.from({ length: 200 }, (_, i) => i + 1); // up to 200 zones
    const batches = [RANGE.slice(0,40), RANGE.slice(40,80), RANGE.slice(80,120), RANGE.slice(120,160), RANGE.slice(160,200)];
    const zonesSet = new Set();
    for (const batch of batches){
      const { zones } = await runZones(batch, 'soft');
      zones.forEach(z => zonesSet.add(z));
      // early-stop if we’ve found plenty of zones already
      if (zonesSet.size >= 25) break;
    }
    const zones = Array.from(zonesSet);
    if (!zones.length) return { cars: [], zones: [] };

    // Now fetch those exact zones STRICTLY (available-only)
    const { cars } = await runZones(zones, 'strict');
    return { cars, zones };
  }

  function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

  // ---------- main ----------
  if (zones && zones.length){
    const { cars } = await runZones(zones, 'strict'); // fast path (available-only)
    if (includeZones) return json({ cars, zones });
    return json(cars);
  }

  // No zones known: discover with soft→strict so we *always* learn a zone list
  const disc = await discoverZonesSoftThenStrict();
  if (disc.zones.length){ S.zones = disc.zones; S.zonesTs = Date.now(); }

  // If you call this from the browser with &includeZones=1 you’ll see the zones to paste into KNOWN_ZONES.
  return json(includeZones ? disc : { cars: disc.cars, zones: disc.zones });
}
