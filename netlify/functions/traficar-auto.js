// Auto-discover Traficar cars endpoint from the site's OpenAPI, with robust fallbacks.
export async function handler(event) {
  const origin = 'https://fioletowe.live';
  const city = (event.queryStringParameters?.city || 'krakow').toLowerCase();

  // helper to try a list of URLs until one returns valid JSON
  async function tryUrls(urls) {
    let lastErr;
    for (const url of urls) {
      try {
        const r = await fetch(url, { headers: { accept: 'application/json' } });
        if (!r.ok) { lastErr = new Error(`${url} -> ${r.status}`); continue; }
        const text = await r.text();
        try {
          const data = JSON.parse(text);
          return { ok: true, data, url, status: r.status };
        } catch {
          lastErr = new Error(`Invalid JSON from ${url}`);
        }
      } catch (e) {
        lastErr = e;
      }
    }
    return { ok: false, error: lastErr?.message || 'unknown', tried: urls };
  }

  // 1) Try to load OpenAPI and extract GET paths with "car"/"vehicle"
  let candidates = [];
  try {
    const specRes = await fetch(`${origin}/api/openapi.json`, { headers: { accept: 'application/json' } });
    if (specRes.ok) {
      const spec = await specRes.json();
      const paths = spec?.paths || {};
      for (const p of Object.keys(paths)) {
        const item = paths[p];
        if (!item?.get) continue;
        const name = p.toLowerCase();
        if (name.includes('car') || name.includes('vehicle')) candidates.push(p);
      }
    }
  } catch (_) { /* ignore and use fallbacks */ }

  // 2) Add smart fallbacks
  candidates.push(
    `/api/${city}/cars`,
    `/api/cars`,
    `/${city}/cars`,
    `/api/city/${city}/cars`,
    `/api/${city}/vehicles`,
    `/api/vehicles`
  );

  // 3) Build full URLs, try with and without ?city=
  const urls = [];
  for (const p of candidates) {
    let path = p;
    if (path.includes('{city}')) path = path.replace('{city}', encodeURIComponent(city));
    const full = `${origin}${path}`;
    urls.push(full);
    if (!full.toLowerCase().includes('city=')) {
      urls.push(full + (full.includes('?') ? '&' : '?') + 'city=' + encodeURIComponent(city));
    }
  }

  const result = await tryUrls(urls);
  if (!result.ok) {
    return { statusCode: 502, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'All endpoint attempts failed', detail: result.error, tried: result.tried }) };
  }

  // 4) Normalize to a simple array
  const raw = result.data;
  const payload = Array.isArray(raw)
    ? raw
    : (raw.cars || raw.features || raw.items || raw.results || raw.data || raw);

  return {
    statusCode: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*'
    },
    body: JSON.stringify(payload)
  };
}
