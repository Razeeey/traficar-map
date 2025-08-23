// Returns the raw JSON from fioletowe.live so we can see the real field names.
export async function handler(event) {
  const origin = 'https://fioletowe.live';
  const zoneId = event.queryStringParameters?.zoneId || '1';
  const last = event.queryStringParameters?.lastUpdate || '0';
  const url = `${origin}/api/v1/cars?zoneId=${encodeURIComponent(zoneId)}&lastUpdate=${encodeURIComponent(last)}`;

  const headers = {
    'accept': 'application/json',
    'user-agent': 'Mozilla/5.0',
    'referer': `${origin}/`
  };

  try {
    const r = await fetch(url, { headers });
    const text = await r.text();
    return {
      statusCode: r.status,
      headers: { 'content-type': r.headers.get('content-type') || 'application/json', 'access-control-allow-origin': '*' },
      body: text
    };
  } catch (e) {
    return { statusCode: 502, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: String(e), url }) };
  }
}