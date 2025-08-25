// Traficar proxy — city-only, AVAILABLE ONLY, very fast with KNOWN_ZONES + strict model join.
// First call without zones: returns {cars, zones} (unless KNOWN_ZONES exists -> returns cars immediately).
// Fast path with zones (either from KNOWN_ZONES or ?zones=...): returns [cars].
// Add &includeZones=1 to always get {cars, zones} for debugging from your browser.

let CITY_STATE = Object.create(null); // warm cache while the function instance is alive

export async function handler(event) {
  const origin = 'https://fioletowe.live';
  const q = event.queryStringParameters || {};
  const cityKey = (q.city || '').toLowerCase().trim();
  if (!cityKey) return json({ error: 'missing city' }, 400);

  // City centers + radii (km)
  const CITY = {
    krakow:     { c:[50.0614,19.9383], r:25 },
    warszawa:   { c:[52.2297,21.0122], r:35 },
    wroclaw:    { c:[51.1079,17.0385], r:22 },
    poznan:     { c:[52.4064,16.9252], r:24 },
    trojmiasto: { c:[54.3722,18.6383], r:42 },
    slask:      { c:[50.2649,19.0238], r:45 },
    lublin:     { c:[51.2465,22.5684], r:22 },
    lodz:       { c:[51.7592,19.4550], r:26 },
    szczecin:   { c:[53.4285,14.5528], r:24 },
    rzeszow:    { c:[50.0413,21.9990], r:22 }
  };
  const city = CITY[cityKey] || CITY.krakow;

  // 🚀 KNOWN_ZONES: once we fill these, loads are instant even on cold starts.
  // Put the numbers you collect (see Step 2 below). Empty arrays are fine.
  const KNOWN_ZONES = {
    krakow:    [],
    warszawa:  [],
    wroclaw:   [],
    poznan:    [],
    trojmiasto:[],
    slask:     [],   // <= we'll fill this one for Śląsk
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

  // Use any known list in priority order
  let zones = null;
  if (Array.isArray(KNOWN_ZONES[cityKey]) && KNOWN_ZONES[cityKey].length) zones = KNOWN_ZONES[cityKey];
  else if (zonesFromQS && zonesFromQS.length) zones = zonesFromQS;
  else if (S.zones && S.zones.length && (Date.now()-S.zonesTs)<10*60*1000) zones = S.zones;

  const headers = { accept: 'application/json', 'user-agent': 'Mozilla/5.0', referer: `${origin}/` };

  // ---------- helpers ----------
  function json(body, status=200){
    return { statusCode: status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' }, body: JSON.stringify(body) };
  }
  const toNum = v => (typeof v === 'string' ? parseFloat(v) : v);
  const isNum = n => typeof n === 'number' && isFinite(n);
  const toRad = d => d*Math.PI/180;
  const distKm = (a,b)=>{const R=6371,dLat=toRad(b[0]-a[0]),dLon=toRad(b[1]-a[1]);const A=Math.sin(dLat/2)**2+Math.cos(toRad(a[0]))*Math.cos(toRad(b[0]))*Math.sin(dLon/2)**2;return R*2*Math.atan2(Math.sqrt(A),Math.sqrt(1-A));};
  const inside = (lat,lng) => distKm(city.c, [lat,lng]) <= city.r;

  async function fetchJSON(url, timeoutMs=2800){
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
    if (Math.abs(lat)>1000) lat /= 1e6;
    if (Math.abs(lng)>1000) lng /= 1e6;
    if (isNum(lat)&&isNum(lng)) return {lat,lng};
    if (x.geometry?.coordinates?.length>=2){
      const LON = toNum(x.geometry.coordinates[0]), LAT = toNum(x.geometry.coordinates[1]);
      if (isNum(LAT)&&isNum(LON)) return {lat:LAT,lng:LON};
    }
    return null;
  }

  // ---------- model dictionary ----------
  const modelById = new Map();
  try{
    const md = await fetchJSON(`${origin}/api/v1/car-models`, 3500);
    const arr = Array.isArray(md) ? md : (md?.carModels || []);
    for (const m of arr||[]){
      const id = m?.id ?? m?.modelId ?? m?.code;
      if (id!=null) modelById.set(Number(id), { name: m.name || m.model || 'Vehicle', electric: !!m.electric, maxFuel: (typeof m.maxFuel==='number'?m.maxFuel:null) });
    }
  }catch{}

  function modelFrom(item){
    const id = item.modelId ?? item.carModelId ?? item.model?.id ?? item.carModel?.id;
    if (id!=null && modelById.has(Number(id))) return modelById.get(Number(id));
    return { name: item.modelName || item.name || item.model || 'Vehicle', electric: !!(item.electric ?? item.isElectric), maxFuel: null };
    }

  // ---------- availability (STRICT) ----------
  function fields(x){
    const pct = toNum(x.fuel), rangeKm = toNum(x.range);
    return {
      plate: x.regPlate ? String(x.regPlate).trim().toUpperCase() : null,
      number: (x.sideNumber!=null) ? String(x.sideNumber).trim().toUpperCase() : null,
      pct: isNum(pct) ? Math.round(Math.max(0,Math.min(100,pct))) : null,
      rangeKm: isNum(rangeKm) ? Math.round(rangeKm) : null,
      address: typeof x.location === 'string' ? x.location : '',
      // flags seen in wild
      available: x.available ?? x.isAvailable ?? x.availableNow ?? x.free ?? x.isFree,
      reserved: x.reserved ?? x.isReserved ?? x.reservationActive ?? (x.reservationId!=null),
      rented:   x.isRented ?? x.rented ?? x.inRental ?? x.inUse,
      status:   x.status ?? x.statusText ?? x.state ?? x.availability ?? ''
    };
  }
  function isFree_STRICT(f){
    if (!f) return false;
    if (f.reserved === true) return false;
    if (f.rented === true) return false;
    if (f.available === true) return true;
    if (typeof f.status === 'string'){
      const s = f.status.toUpperCase();
      if (/(RENT|RENTED|BUSY|RESERV|OCCUP|UNAVAIL|TAKEN|MAINT|SERVICE|IN_USE)/.test(s)) return false;
      if (/(FREE|AVAILABLE|READY|IDLE|OPEN)/.test(s)) return true;
    }
    return false; // unknown -> not free
  }

  // ---------- zone fetch ----------
  async function fetchZone(zid){
    const data = await fetchJSON(`${origin}/api/v1/cars?zoneId=${zid}&lastUpdate=0`, 2600);
    const list = Array.isArray(data) ? data : (Array.isArray(data?.cars) ? data.cars : []);
    const out = [];
    for (const item of list){
      const pos = extractLatLng(item); if (!pos) continue;
      const lat = Number(pos.lat), lng = Number(pos.lng);
      if (!isNum(lat)||!isNum(lng)) continue;
      if (!inside(lat,lng)) continue;

      const f = fields(item);
      if (!isFree_STRICT(f)) continue;

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

  async function runZones(ids){
    // higher concurrency but polite, and no early-stop (we want completeness once zones are known)
    const limit = 12;
    let idx = 0;
    const cars = [];
    const used = new Set();

    async function worker(){
      while (idx < ids.length){
        const zid = ids[idx++];
        const arr = await fetchZone(zid);
        if (arr.length) { used.add(zid); cars.push(...arr); }
        await sleep(40);
      }
    }
    await Promise.all(Array(Math.min(limit, ids.length)).fill(0).map(worker));

    // de-dup by plate/number/coords
    const seen = new Set();
    const unique = cars.filter(v => {
      const key = `${v.plate||v.number||v.id||''}|${v.lat.toFixed(6)}|${v.lng.toFixed(6)}`;
      if (seen.has(key)) return false; seen.add(key); return true;
    });
    return { cars: unique, zones: Array.from(used) };
  }

  async function discoverZones(){
    // Wide sweep once; returns as soon as finished (no early-stop to stabilize zone list).
    const RANGE = Array.from({length: 60}, (_,i)=>i+1);
    // use smaller batches to keep sockets open
    const batches = [RANGE.slice(0,20), RANGE.slice(20,40), RANGE.slice(40,60)];
    const cars=[], zonesSet = new Set();
    for (const batch of batches){
      const {cars: cc, zones: zz} = await runZones(batch);
      cars.push(...cc); zz.forEach(z=>zonesSet.add(z));
    }
    return { cars: dedup(cars), zones: Array.from(zonesSet) };
  }

  function dedup(arr){
    const seen = new Set();
    return arr.filter(v => {
      const key = `${v.plate||v.number||v.id||''}|${v.lat.toFixed(6)}|${v.lng.toFixed(6)}`;
      if (seen.has(key)) return false; seen.add(key); return true;
    });
  }

  function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

  // ---------- main ----------
  if (zones && zones.length){
    const { cars } = await runZones(zones);
    if (includeZones) return json({ cars, zones });
    return json(cars);
  }

  // No zones yet: discover and remember
  const disc = await discoverZones();
  if (disc.zones.length){ S.zones = disc.zones; S.zonesTs = Date.now(); }

  // If you hit the function in your browser, you’ll see the zones so you can paste them into KNOWN_ZONES later.
  return json(includeZones ? disc : { cars: disc.cars, zones: disc.zones });

}
