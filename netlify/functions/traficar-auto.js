// Fast, strict Traficar proxy with per-city cache + zone discovery.
// - Strictly returns AVAILABLE cars (no rented/reserved/busy).
// - Joins model names from /api/v1/car-models (no more "Vehicle").
// - Discovers zones fast with timeouts + early-stop and then caches them per city.
// - First call (no zones) -> { cars:[...], zones:[...] }  ; later with zones -> [ ...cars ]

let CITY_STATE = Object.create(null); // warm-instance cache

export async function handler(event) {
  const origin = 'https://fioletowe.live';
  const q = event.queryStringParameters || {};
  const cityKey = (q.city || '').toLowerCase().trim();
  if (!cityKey) return json({ error: 'missing city' }, 400);

  // City centers + tuned radii (km). Widened a bit to avoid edge drops.
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

  // Per-city state (zones + last cars cache)
  const S = CITY_STATE[cityKey] ||= { zones: [], zonesTs: 0, cars: [], carsTs: 0 };

  // Optional fast path via ?zones=1,2,3 (frontend caches this in localStorage)
  const zonesParam = (q.zones || '').trim();
  const zonesFromQS = zonesParam
    ? zonesParam.split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n > 0)
    : null;

  const headers = {
    accept: 'application/json',
    'user-agent': 'Mozilla/5.0',
    referer: `${origin}/`
  };

  // --------------- utils ---------------
  function json(body, status = 200) {
    return {
      statusCode: status,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*'
      },
      body: JSON.stringify(body)
    };
  }
  const toNum = v => (typeof v === 'string' ? parseFloat(v) : v);
  const isNum = n => typeof n === 'number' && isFinite(n);
  const toRad = d => d * Math.PI / 180;
  const distKm = (a, b) => {
    const R = 6371, dLat = toRad(b[0] - a[0]), dLon = toRad(b[1] - a[1]);
    const A = Math.sin(dLat/2)**2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(A), Math.sqrt(1 - A));
  };
  const inside = (lat, lng) => distKm(city.c, [lat, lng]) <= city.r;

  async function fetchJSON(url, timeoutMs = 3000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort('timeout'), timeoutMs);
    try {
      const r = await fetch(url, { headers, signal: ctrl.signal });
      if (!r.ok) return null;
      const ct = r.headers.get('content-type') || '';
      if (!/json/i.test(ct)) return null;
      return await r.json();
    } catch {
      return null;
    } finally {
      clearTimeout(t);
    }
  }

  function extractLatLng(x) {
    let lat = x.lat ?? x.latitude, lng = x.lng ?? x.lon ?? x.longitude;
    lat = toNum(lat); lng = toNum(lng);
    if (isNum(lat) && isNum(lng)) return { lat, lng };
    // geometry fallback
    if (x.geometry?.coordinates?.length >= 2) {
      const LON = toNum(x.geometry.coordinates[0]), LAT = toNum(x.geometry.coordinates[1]);
      if (isNum(LAT) && isNum(LON)) return { lat: LAT, lng: LON };
    }
    return null;
  }

  // --------------- model dictionary (for names) ---------------
  const modelById = new Map();
  try {
    const models = await fetchJSON(`${origin}/api/v1/car-models`, 3500);
    const arr = Array.isArray(models) ? models : (models?.carModels || []);
    for (const m of arr || []) {
      const id = m?.id ?? m?.modelId ?? m?.code;
      if (id != null) modelById.set(Number(id), {
        name: m.name || m.model || 'Vehicle',
        electric: !!m.electric,
        maxFuel: (typeof m.maxFuel === 'number' ? m.maxFuel : null)
      });
    }
  } catch {}

  const modelFrom = (item) => {
    const id = item.modelId ?? item.carModelId ?? item.model?.id ?? item.carModel?.id;
    if (id != null && modelById.has(Number(id))) return modelById.get(Number(id));
    return { name: item.modelName || item.name || item.model || 'Vehicle', electric: !!(item.electric ?? item.isElectric), maxFuel: null };
  };

  // --------------- availability (STRICT) ---------------
  function fields(x) {
    const pct = toNum(x.fuel);
    const rangeKm = toNum(x.range);
    return {
      plate: x.regPlate ? String(x.regPlate).trim().toUpperCase() : null,
      number: (x.sideNumber != null) ? String(x.sideNumber).trim().toUpperCase() : null,
      pct: isNum(pct) ? Math.round(Math.max(0, Math.min(100, pct))) : null,
      rangeKm: isNum(rangeKm) ? Math.round(rangeKm) : null,
      address: typeof x.location === 'string' ? x.location : '',
      status: typeof x.status === 'string' ? x.status : '',
      reserved: x.reserved ?? x.isReserved,
      rented: x.isRented ?? x.rented,
      available: x.available
    };
  }
  function busy(f) {
    if (f.reserved === true) return true;
    if (f.rented === true) return true;
    if (typeof f.status === 'string' && /(RENT|RENTED|BUSY|RESERV|OCCUP|UNAVAIL|TAKEN|MAINT)/i.test(f.status)) return true;
    return false;
  }
  function isFree_STRICT(f) {
    if (!f) return false;
    if (busy(f)) return false;
    if (f.available === true) return true;
    if (typeof f.status === 'string' && /(FREE|AVAILABLE|READY)/i.test(f.status)) return true;
    return false; // unknown or available:false -> not free
  }

  // --------------- zone fetch ---------------
  async function fetchZone(zid) {
    const data = await fetchJSON(`${origin}/api/v1/cars?zoneId=${zid}&lastUpdate=0`, 2500);
    const list = Array.isArray(data) ? data : (Array.isArray(data?.cars) ? data.cars : []);
    const out = [];
    for (const item of list) {
      const pos = extractLatLng(item); if (!pos) continue;
      const lat = Number(pos.lat), lng = Number(pos.lng);
      if (!isNum(lat) || !isNum(lng)) continue;
      if (!inside(lat, lng)) continue;

      const f = fields(item);
      if (!isFree_STRICT(f)) continue; // AVAILABLE ONLY

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

  async function runZones(ids, maxMs = 4000) {
    // small concurrency + early-stop to keep first paint snappy
    const start = Date.now();
    const limit = 8;
    let idx = 0;
    const cars = [];
    const used = new Set();

    async function worker() {
      while (idx < ids.length) {
        const zid = ids[idx++];
        const arr = await fetchZone(zid);
        if (arr.length) { used.add(zid); cars.push(...arr); }
        // early stop if good enough or time is up
        if (cars.length >= 60 || used.size >= 12 || (Date.now() - start) > maxMs) break;
        await sleep(60);
      }
    }
    await Promise.race([
      Promise.all(Array(Math.min(limit, ids.length)).fill(0).map(worker)),
      sleep(maxMs + 500)
    ]);

    // de-dup
    const seen = new Set();
    const unique = cars.filter(v => {
      const key = `${v.plate||v.number||v.id||''}|${v.lat.toFixed(6)}|${v.lng.toFixed(6)}`;
      if (seen.has(key)) return false; seen.add(key); return true;
    });
    return { cars: unique, zones: Array.from(used) };
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // --------------- main ---------------
  // If zones were provided via QS -> FAST PATH
  if (zonesFromQS && zonesFromQS.length) {
    const { cars } = await runZones(zonesFromQS, 3000);
    if (cars.length) {
      S.cars = cars; S.carsTs = Date.now();
      return json(cars);
    }
    // fallback to last cache for this city if upstream is empty/flaky
    if (S.cars && S.cars.length) return json(S.cars);
    return json([]); // nothing known yet
  }

  // Use cached zones if fresh (<10 min)
  const zonesFresh = S.zones && S.zones.length && (Date.now() - S.zonesTs) < 10 * 60 * 1000;
  if (zonesFresh) {
    const { cars } = await runZones(S.zones, 3000);
    if (cars.length) { S.cars = cars; S.carsTs = Date.now(); return json(cars); }
    // if upstream hiccups, serve last cars cache if recent (<90s)
    if (S.cars && (Date.now() - S.carsTs) < 90 * 1000) return json(S.cars);
  }

  // DISCOVERY: probe zones in batches up to 1..60 (w/ early-stop)
  const R = Array.from({ length: 60 }, (_, i) => i + 1);
  const disc = await runZones(R, 4500);
  if (disc.zones.length) { S.zones = disc.zones; S.zonesTs = Date.now(); }
  if (disc.cars.length)   { S.cars  = disc.cars;  S.carsTs  = Date.now(); }

  // Return cars + zones so the frontend can cache zones and go fast next time
  if (disc.cars.length) return json({ cars: disc.cars, zones: disc.zones });
  // fallback: if nothing now, but we have a previous cache, serve it
  if (S.cars && S.cars.length) return json({ cars: S.cars, zones: S.zones || [] });
  return json({ cars: [], zones: [] });
}
