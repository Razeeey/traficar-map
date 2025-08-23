// Netlify Function: server-side proxy to fioletowe.live (avoids CORS) and tries several common endpoints.
export async function handler(event) {
  const city = (event.queryStringParameters?.city || 'krakow').toLowerCase();
  const origin = 'https://fioletowe.live';
  const candidates = [
    `${origin}/api/${city}/cars`,
    `${origin}/api/cars?city=${encodeURIComponent(city)}`,
    `${origin}/${city}/cars`,
    `${origin}/api/city/${city}/cars`,
    `${origin}/api/${city}/vehicles`,
    `${origin}/api/vehicles?city=${encodeURIComponent(city)}`
  ];
  const headers = { 'accept': 'application/json' };
  let lastErr;
  for (const url of candidates) {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) { lastErr = new Error(`${url} -> ${res.status}`); continue; }
      const txt = await res.text();
      try {
        const data = JSON.parse(txt);
        const payload = Array.isArray(data) ? data :
                        (data.cars || data.features || data.items || data);
        return {
          statusCode: 200,
          headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
          body: JSON.stringify(payload)
        };
      } catch {
        lastErr = new Error(`Invalid JSON from ${url}`);
      }
    } catch (e) {
      lastErr = e;
    }
  }
  return {
    statusCode: 502,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ error: 'All upstream endpoints failed', detail: lastErr?.message || 'unknown' })
  };
}
