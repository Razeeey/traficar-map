// Traficar proxy (hard-wired to one endpoint) + helpful debug
export async function handler(event) {
  const city = (event.queryStringParameters?.city || 'krakow').toLowerCase();
  const origin = 'https://fioletowe.live';

  // 1) Try the most likely official endpoint first:
  const url = `${origin}/api/cars?city=${encodeURIComponent(city)}`;

  try {
    const upstream = await fetch(url, { headers: { 'accept': 'application/json' } });

    // Pass through upstream status so you can see 403/404/etc
    const text = await upstream.text();

    // If it looks like HTML, surface that as a debug message
    if (text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html')) {
      return {
        statusCode: 502,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          error: 'Upstream returned HTML (not JSON)',
          hint: 'Endpoint path is probably different or blocked.',
          upstream_status: upstream.status,
          tried: url,
          html_preview: text.slice(0, 300)
        })
      };
    }

    // Try to parse JSON
    let data;
    try { data = JSON.parse(text); }
    catch (e) {
      return {
        statusCode: 502,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          error: 'Invalid JSON from upstream',
          upstream_status: upstream.status,
          tried: url,
          preview: text.slice(0, 300)
        })
      };
    }

    // Normalize common shapes to a plain array
    const payload = Array.isArray(data) ? data : (data.cars || data.features || data.items || data);

    return {
      statusCode: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*'
      },
      body: JSON.stringify(payload)
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        error: 'Fetch to upstream failed',
        tried: url,
        detail: String(err)
      })
    };
  }
}
