// Fast Traficar proxy — city-only, STRICT available, numeric coords, zone caching.
// Supports:
//   ?city=krakow             -> returns only that city (STRICT: free/available)
//   ?city=krakow&zones=1,2   -> fetch only those zones (fast path)
//   (when zones are NOT provided) it returns { cars:[...], zones:[...] } so
//   the frontend can cache zones for next calls.

export async function handler(event) {
  const origin = 'https://fioletowe.live';
  const q = event.queryStringParameters || {};
  const cityKey = (q.city || '').toLowerCase().trim();
  if (!cityKey) {
    return json({ error: 'missing city' }, 400);
  }

  // City centers + tight radii (km). Tune if needed.
  const CITY = {
    krakow:     { c:[50.0614,19.9383], r:18 },
    warszawa:   { c:[52.2297,21.0122], r:28 },
    wroclaw:    { c:[51.1079,17.0385], r:18 },
    poznan:     { c:[52.4064,16.9252], r:20 },
    trojmiasto: { c:[54.3722,18.6383], r:35 },
    slask:      { c:[50.2649,19.0238], r:35 },
    lublin:     { c:[51.2465,22.5684], r:18 },
    lodz:       { c:[51.7592,19.4550], r:20 },
    szczecin:   { c:[53.4285,14.5528], r:20 },
    rzeszow:    { c:[50.0413,21.9990], r:18 }
  };
  const city = CITY[cityKey] || CITY.krakow;

  const zonesParam = (q.zones || '').trim();
  let zoneIds = zonesParam
    ? zonesParam.split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n > 0)
    : null;

  // RANGE to probe when we don't know zones yet
  const RANGE1 = Array.from({ length: 12 }, (_, i) => i + 1);     // 1..12 (quick)
  const RANGE2 = Array.from({ length: 24 }, (_, i) => i + 1);     // 1..24 (fuller)

  const headers = { accept: 'application/json', 'user-agent': 'Mozilla/5.0', referer: `${origin}/` };

  // ---- utils ----
  const toNum = v => (typeof v === 'string' ? parseFloat(v) : v);
  const isNum = n => typeof n === 'number' && isFinite(n);
  const toRad = d => d*Math.PI/180;
  const distKm = (a,b)=>{const R=6371,dLat=toRad(b[0]-a[0]),dLon=toRad(b[1]-a[1]);const A=Math.sin(dLat/2)**2+Math.cos(toRad(a[0]))*Math.cos(toRad(b[0]))*Math.sin(dLon/2)**2;return R*2*Math.atan2(Math.sqrt(A),Math.sqrt(1-A));};
  const inside = (lat,lng) => distKm(city.c, [lat,lng]) <= city.r;

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

  function mapFields(x){
    const pct = toNum(x.fuel);       // %
    const rangeKm = toNum(x.range);  // km
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

  // STRICT available: require explicit "free" signal; drop rented/reserved/busy.
  function strictFree(f){
    if (f.reserved === true) return false;
    if (f.rented === true) return false;
    if (typeof f.status === 'string') {
      const s = f.status.toUpperCase();
      if (/(RENT|RENTED|BUSY|RESERV|OCCUP|UNAVAIL|TAKEN|MAINT)/.test(s)) return false;
      if (/(FREE|AVAILABLE|READY)/.test(s)) return true;
    }
    if (f.available === true) return true;
    return false; // unknown or available:false -> not free
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
        if (!inside(lat,lng)) continue;

        const f = mapFields(item);
        if (!strictFree(f)) continue; // available only

        out.push({
          id: item.id ?? item.vehicleId ?? item.carId ?? item.code ?? null,
          lat, lng,
          model: item.modelName || item.name || item.model || 'Vehicle',
          plate: f.plate, number: f.number, pct: f.pct, rangeKm: f.rangeKm,
          address: f.address
        });
      }
      return out;
    } catch { return []; }
  }

  async function runZones(ids){
    // small concurrency for speed w/o rate-limits
    const limit = 8;
    let idx = 0;
    const cars = [];
    const used = new Set();
    async function worker(){
      while (idx < ids.length){
        const zid = ids[idx++];
        const arr = await fetchZone(zid);
        if (arr.length) used.add(zid);
        cars.push(...arr);
        await sleep(60);
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

  function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
  function json(body, status=200){
    return {
      statusCode: status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' },
      body: JSON.stringify(body)
    };
  }

  // If zones list provided -> FAST PATH
  if (zoneIds && zoneIds.length) {
    const { cars } = await runZones(zoneIds);
    return json(cars);
  }

  // No zones yet -> discover quickly (1..12). If too few cars, extend (1..24).
  let { cars, zones } = await runZones(RANGE1);
  if (cars.length < 8) {
    const more = await runZones(RANGE2.filter(x => !RANGE1.includes(x)));
    cars = more.cars; zones = Array.from(new Set([...zones, ...more.zones]));
  }
  // Return both cars + the discovered zones so the client can cache them.
  return json({ cars, zones });
}