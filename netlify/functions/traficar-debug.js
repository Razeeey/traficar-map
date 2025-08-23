export async function handler(event) {
  const origin = 'https://fioletowe.live';
  const zoneId = event.queryStringParameters?.zoneId || '1';
  const last = event.queryStringParameters?.lastUpdate; // pass ?lastUpdate=0 if you want
  const url = `${origin}/api/v1/cars?zoneId=${encodeURIComponent(zoneId)}${last ? `&lastUpdate=${encodeURIComponent(last)}` : ''}`;

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
