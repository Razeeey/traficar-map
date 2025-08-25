// netlify/functions/traficar-areas.js
export async function handler(event){
  const origin = 'https://fioletowe.live';
  const q = event.queryStringParameters || {};
  const city = (q.city || '').toLowerCase().trim();
  if (!city) return j({error:'missing city'}, 400);

  const headers = {accept:'application/json','user-agent':'Mozilla/5.0',referer:`${origin}/`};

  // candidates we’ll try in order; we accept any valid GeoJSON with features
  const CANDIDATES = [
    `${origin}/api/v1/zones?city=${city}`,
    `${origin}/api/v1/areas?city=${city}`,
    `${origin}/api/${city}/zones`,
    `${origin}/api/zones?city=${city}`,
    `${origin}/${city}/zones.geojson`,
    `${origin}/api/v1/relocation-zones?city=${city}`,
    `${origin}/api/v1/parking-zones?city=${city}`,
    `${origin}/api/v1/geo/${city}`,
  ];

  async function getJSON(u){
    try{
      const r = await fetch(u,{headers});
      const ct = r.headers.get('content-type')||'';
      if(!r.ok || !/json|geojson/i.test(ct)) return null;
      return await r.json();
    }catch{ return null; }
  }

  // Normalize anything that looks like geojson → FeatureCollection
  function toFC(x){
    if(!x) return null;
    if(x.type==='FeatureCollection' && Array.isArray(x.features)) return x;
    if(Array.isArray(x)) return { type:'FeatureCollection', features:x };
    if(x.data?.type==='FeatureCollection') return x.data;
    if(x.features) return { type:'FeatureCollection', features:x.features };
    return null;
  }

  // Try to split features into our 3 buckets by name/type tags
  function split(fc){
    const rel=[], nop=[], og=[];
    for(const f of (fc.features||[])){
      const p = f.properties||{};
      const txt = JSON.stringify(p).toLowerCase();
      if(/relok|reloc|yellow|przeprowadz/i.test(txt)) rel.push(f);
      else if(/no[\s-]?park|ban|red|zakaz/i.test(txt)) nop.push(f);
      else if(/ogarnia|ogarn|purple|fiolet/i.test(txt)) og.push(f);
      // if nothing matched, leave it out
    }
    return {
      relocation: { type:'FeatureCollection', features: rel },
      nopark:     { type:'FeatureCollection', features: nop },
      ogarniam:   { type:'FeatureCollection', features: og }
    };
  }

  // Merge multiple FCs
  function merge(a,b){
    return { type:'FeatureCollection', features:[...(a?.features||[]), ...(b?.features||[])] };
  }

  let relocation = {type:'FeatureCollection',features:[]};
  let nopark     = {type:'FeatureCollection',features:[]};
  let ogarniam   = {type:'FeatureCollection',features:[]};

  for(const u of CANDIDATES){
    const raw = await getJSON(u);
    const fc = toFC(raw);
    if(!fc) continue;
    const parts = split(fc);
    relocation = merge(relocation, parts.relocation);
    nopark     = merge(nopark,     parts.nopark);
    ogarniam   = merge(ogarniam,   parts.ogarniam);
  }

  // Shape response the frontend expects
  return j({ relocation, nopark, ogarniam });

  function j(body, status=200){
    return { statusCode: status, headers:{'content-type':'application/json','cache-control':'no-store','access-control-allow-origin':'*'}, body: JSON.stringify(body) };
  }
}
