// Orsia Jewels — Admin status page (shown inside Shopify admin)
//
// Opened from Shopify admin → Apps → Orsia Price Calculator 2. Shopify loads
// this URL with signed query params (shop, timestamp, hmac, ...). The page is
// only rendered when that signature is valid, so the price tables are not
// public. It is read-only: it shows live gold rates, a health check, the
// diamond price tables, and any gaps that would block an order.

import crypto from 'node:crypto';

const API_VERSION = '2025-01';
const MAX_LINK_AGE_SEC = 10 * 60;

// ── Shopify auth / API ──────────────────────────────────────────────────────
function verifyShopifyHmac(query, secret) {
  const { hmac, signature, ...rest } = query;
  if (!hmac || !secret) return false;
  const message = Object.keys(rest).sort()
    .map(k => `${k}=${Array.isArray(rest[k]) ? rest[k].join(',') : rest[k]}`)
    .join('&');
  const digest = crypto.createHmac('sha256', secret).update(message).digest('hex');
  const a = Buffer.from(digest, 'utf8');
  const b = Buffer.from(String(hmac), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

let cachedToken = null;
let tokenExpiresAt = 0;
async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
  const res = await fetch(`https://${process.env.SHOPIFY_STORE}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id:     process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET,
      grant_type:    'client_credentials'
    })
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Could not get a Shopify access token');
  cachedToken = data.access_token;
  const ttlSec = parseInt(data.expires_in, 10) || 3600;
  tokenExpiresAt = Date.now() + Math.max(ttlSec - 300, 60) * 1000;
  return cachedToken;
}

async function gql(query, variables, token) {
  const res = await fetch(`https://${process.env.SHOPIFY_STORE}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  const data = await res.json();
  if (data.errors) throw new Error(data.errors[0]?.message || 'GraphQL request failed');
  return data.data;
}

// ── Data ────────────────────────────────────────────────────────────────────
// Must match create-order.js: per-stone CT is floored to 2 decimals before lookup.
const r2 = n => Math.floor(parseFloat(n) * 100) / 100;

function parseList(raw) {
  if (!raw) return [];
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a : []; }
  catch (e) { const n = parseFloat(raw); return n > 0 ? [n] : []; }
}

async function getMatrix(type, token) {
  const d = await gql(`query($type: String!) { metaobjects(type: $type, first: 250) {
      edges { node { fields { key value } } } } }`, { type }, token);
  return (d.metaobjects?.edges || []).map(({ node }) => {
    const f = {}; (node.fields || []).forEach(x => { f[x.key] = x.value; });
    return {
      quality: f.quality_label || '',
      label:   f.ct_range_label || '',
      ctMin:   parseFloat(f.ct_min || 0),
      ctMax:   parseFloat(f.ct_max || 0),
      price:   parseInt(f.price_per_ct || 0, 10)
    };
  });
}

async function getProducts(token) {
  const out = [];
  let after = null;
  for (let page = 0; page < 5; page++) {           // up to 500 products
    const d = await gql(`query($after: String) { products(first: 100, after: $after, query: "status:active") {
        pageInfo { hasNextPage endCursor }
        edges { node { id title handle metafields(namespace: "custom", first: 30) { edges { node { key value } } } } } } }`,
      { after }, token);
    for (const { node } of d.products.edges) {
      const m = {}; node.metafields.edges.forEach(({ node: f }) => { m[f.key] = f.value; });
      out.push({ id: node.id, title: node.title, handle: node.handle, m });
    }
    if (!d.products.pageInfo.hasNextPage) break;
    after = d.products.pageInfo.endCursor;
  }
  return out;
}

async function getGoldRates() {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  const res = await fetch(`https://${host}/api/gold-rates`);
  return res.json();
}

// ── Checks ──────────────────────────────────────────────────────────────────
function findRow(matrix, quality, perCt) {
  return matrix.find(r => r.quality === quality && perCt >= r2(r.ctMin) && perCt <= r2(r.ctMax));
}

function tableProblems(matrix) {
  const problems = [];
  const byQuality = {};
  matrix.forEach(r => { (byQuality[r.quality] = byQuality[r.quality] || []).push(r); });
  for (const [q, rows] of Object.entries(byQuality)) {
    rows.sort((a, b) => a.ctMin - b.ctMin);
    rows.forEach(r => {
      if (r.ctMax < r.ctMin) problems.push(`${q}: row "${r.label}" has max ${r.ctMax} below min ${r.ctMin} — it never matches.`);
      if (!(r.price > 0)) problems.push(`${q}: row "${r.label}" has no price per ct.`);
    });
    const valid = rows.filter(r => r.ctMax >= r.ctMin);
    for (let i = 1; i < valid.length; i++) {
      const prevMax = r2(valid[i - 1].ctMax), nextMin = r2(valid[i].ctMin);
      if (nextMin > +(prevMax + 0.01).toFixed(2)) {
        problems.push(`${q}: no price between ${prevMax} and ${nextMin} ct per stone.`);
      }
    }
    if (valid.length) {
      const top = Math.max(...valid.map(r => r.ctMax));
      problems.push({ info: true, text: `${q}: priced up to ${top} ct per stone.` });
    }
  }
  return { problems, qualities: Object.keys(byQuality) };
}

function productProblems(products, matrices) {
  const rows = [];
  for (const p of products) {
    const gold = parseList(p.m.gold_weight_18kt_options);
    if (!gold.length) continue;                    // not a calculator product
    const sol = parseList(p.m.solitaire_ct_options);
    const side = parseList(p.m.side_ct_options);
    const solCount = parseInt(p.m.solitaire_count || 0, 10);
    const sideCount = parseInt(p.m.side_count || 0, 10);
    for (let i = 0; i < gold.length; i++) {
      const issues = [];
      if (!(parseFloat(gold[i]) > 0)) issues.push('no 18K gold weight');
      const sw = parseFloat(sol[i]) || 0, dw = parseFloat(side[i]) || 0;
      if (sw <= 0 && dw <= 0) issues.push('no diamond weights');
      for (const [type, { matrix, qualities }] of Object.entries(matrices)) {
        const missing = [];
        for (const q of qualities) {
          const groups = [[sw, solCount], [dw, sideCount]].filter(([w]) => w > 0);
          for (const [w, c] of groups) {
            const perCt = r2(c > 0 ? w / c : w);
            if (!findRow(matrix, q, perCt)) missing.push(`${q} @ ${perCt}ct`);
          }
        }
        if (missing.length) issues.push(`${type}: no price for ${[...new Set(missing)].join(', ')}`);
      }
      if (issues.length) rows.push({ title: p.title, handle: p.handle, option: i + 1, ct: +(sw + dw).toFixed(2), issues });
    }
  }
  return rows;
}

// ── HTML ────────────────────────────────────────────────────────────────────
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = n => '₹' + Number(n || 0).toLocaleString('en-IN');

function page(body, clientId) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Orsia Price Calculator</title>
${clientId ? `<meta name="shopify-api-key" content="${esc(clientId)}"><script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>` : ''}
<style>
  :root{--bg:#f1f1f1;--card:#fff;--text:#303030;--muted:#616161;--line:#e3e3e3;--ok:#0c5132;--okbg:#cdfee1;--bad:#8e1f0b;--badbg:#fedad9;--warn:#5e4200;--warnbg:#ffef9d}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  main{max-width:960px;margin:0 auto;padding:20px 16px 40px}
  h1{font-size:20px;margin:0 0 4px} h2{font-size:15px;margin:0 0 12px}
  .sub{color:var(--muted);margin:0 0 18px}
  .card{background:var(--card);border-radius:12px;box-shadow:0 1px 0 rgba(0,0,0,.07),0 0 0 1px rgba(0,0,0,.04);padding:16px;margin-bottom:14px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
  .stat{border:1px solid var(--line);border-radius:10px;padding:10px 12px}
  .stat b{display:block;font-size:18px;margin-top:2px}
  .stat span{color:var(--muted);font-size:12px}
  .pill{display:inline-block;border-radius:8px;padding:2px 8px;font-size:12px;font-weight:600}
  .ok{background:var(--okbg);color:var(--ok)} .bad{background:var(--badbg);color:var(--bad)} .warn{background:var(--warnbg);color:var(--warn)}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}
  th{color:var(--muted);font-weight:600} td.num{text-align:right;font-variant-numeric:tabular-nums}
  .scroll{overflow-x:auto}
  ul{margin:0;padding-left:18px} li{margin:3px 0}
  .muted{color:var(--muted)} a{color:#005bd3}
  .row{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
</style></head><body><main>${body}</main></body></html>`;
}

function render({ shop, rates, health, matrices, productRows, productCount, generatedAt }) {
  const hRow = (label, ok, note) =>
    `<tr><td>${esc(label)}</td><td><span class="pill ${ok ? 'ok' : 'bad'}">${ok ? 'OK' : 'Problem'}</span></td><td class="muted">${esc(note || '')}</td></tr>`;

  const rateCard = rates && !rates.fallback ? `
    <div class="grid">
      <div class="stat"><span>24K</span><b>${inr(rates.rate24k)}/g</b></div>
      <div class="stat"><span>18K (79%)</span><b>${inr(rates.rate18k)}/g</b></div>
      <div class="stat"><span>14K (62%)</span><b>${inr(rates.rate14k)}/g</b></div>
      <div class="stat"><span>9K (40%)</span><b>${inr(rates.rate9k)}/g</b></div>
    </div>
    <p class="muted" style="margin:10px 0 0">From Live Gold Price Editor${rates.fetchedAt ? ` · fetched ${esc(new Date(rates.fetchedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }))} IST` : ''}. Checkout uses these same rates.</p>`
    : `<p><span class="pill bad">Unavailable</span> Live gold rates could not be read${rates?.error ? `: ${esc(rates.error)}` : ''}. Checkout is refusing orders until this is fixed.</p>`;

  const matrixCards = Object.entries(matrices).map(([type, { matrix, problems }]) => {
    const errors = problems.filter(p => typeof p === 'string');
    const infos = problems.filter(p => typeof p !== 'string').map(p => p.text);
    const sorted = [...matrix].sort((a, b) => a.quality.localeCompare(b.quality) || a.ctMin - b.ctMin);
    return `<div class="card">
      <div class="row"><h2>${type === 'lab' ? 'Lab grown' : 'Natural'} diamond prices</h2>
        <span class="pill ${errors.length ? 'bad' : 'ok'}">${errors.length ? errors.length + ' problem' + (errors.length > 1 ? 's' : '') : 'No gaps'}</span></div>
      ${errors.length ? `<ul style="margin-bottom:10px">${errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
      ${infos.length ? `<p class="muted" style="margin:0 0 10px">${infos.map(esc).join(' · ')}</p>` : ''}
      <div class="scroll"><table><thead><tr><th>Quality</th><th>CT range (per stone)</th><th class="num">Min</th><th class="num">Max</th><th class="num">Price / ct</th></tr></thead><tbody>
      ${sorted.map(r => `<tr${r.ctMax < r.ctMin ? ' style="background:#fff4f4"' : ''}><td>${esc(r.quality)}</td><td>${esc(r.label)}</td><td class="num">${r.ctMin}</td><td class="num">${r.ctMax}</td><td class="num">${inr(r.price)}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="muted" style="margin:10px 0 0">Edit in Shopify admin → Content → Metaobjects → ${type}_diamond_matrix.</p>
    </div>`;
  }).join('');

  const productCard = `<div class="card">
    <div class="row"><h2>Products that can't be priced</h2>
      <span class="pill ${productRows.length ? 'warn' : 'ok'}">${productRows.length ? productRows.length + ' option' + (productRows.length > 1 ? 's' : '') : 'All OK'}</span></div>
    <p class="muted" style="margin:0 0 10px">Checked ${productCount} active product${productCount === 1 ? '' : 's'} that use the calculator, every CT option, every quality, lab and natural. A customer choosing one of these combinations sees "This combination is not available". If you don't sell that diamond type on a product, you can ignore its line.</p>
    ${productRows.length ? `<div class="scroll"><table><thead><tr><th>Product</th><th>CT option</th><th>What's missing</th></tr></thead><tbody>
      ${productRows.map(r => `<tr><td><a href="https://${esc(shop)}/products/${esc(r.handle)}" target="_blank" rel="noopener">${esc(r.title)}</a></td><td>#${r.option} · ${r.ct} ct</td><td><ul>${r.issues.map(i => `<li>${esc(i)}</li>`).join('')}</ul></td></tr>`).join('')}
    </tbody></table></div>` : ''}
  </div>`;

  return `
    <h1>Orsia Price Calculator</h1>
    <p class="sub">Read-only status for the live price calculator and checkout · updated ${esc(generatedAt)} IST · refresh to update</p>
    <div class="card"><h2>Health check</h2><div class="scroll"><table><tbody>
      ${hRow('Shopify connection', health.shopify, health.shopifyNote)}
      ${hRow('Live gold rates', health.gold, health.goldNote)}
      ${hRow('Diamond price tables', health.tables, health.tablesNote)}
    </tbody></table></div></div>
    <div class="card"><h2>Today's gold rates</h2>${rateCard}</div>
    ${productCard}
    ${matrixCards}`;
}

// ── Handler ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const query = req.query || {};
  const store = process.env.SHOPIFY_STORE;
  const clientId = process.env.SHOPIFY_CLIENT_ID;

  // Only render when opened from Shopify admin with a valid, fresh signature.
  const ts = parseInt(query.timestamp, 10);
  const fresh = ts && Math.abs(Date.now() / 1000 - ts) < MAX_LINK_AGE_SEC;
  if (!verifyShopifyHmac(query, process.env.SHOPIFY_CLIENT_SECRET) || !fresh || query.shop !== store) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(401).send(page(`<div class="card"><h1>Orsia Price Calculator</h1>
      <p class="sub">Open this page from Shopify admin → Apps → Orsia Price Calculator 2.</p></div>`));
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', `frame-ancestors https://${store} https://admin.shopify.com;`);

  const health = { shopify: false, gold: false, tables: false };
  let rates = null, matrices = {}, productRows = [], productCount = 0;

  try {
    rates = await getGoldRates();
    health.gold = !!(rates && !rates.fallback && rates.rate18k > 1000);
    health.goldNote = health.gold ? `18K ${inr(rates.rate18k)}/g` : (rates?.error || 'fallback rates in use');
  } catch (e) {
    health.goldNote = e.message;
  }

  try {
    const token = await getAccessToken();
    const [lab, natural, products] = await Promise.all([
      getMatrix('lab_diamond_matrix', token),
      getMatrix('natural_diamond_matrix', token),
      getProducts(token)
    ]);
    health.shopify = true;
    health.shopifyNote = `${process.env.SHOPIFY_STORE}`;
    for (const [type, matrix] of [['lab', lab], ['natural', natural]]) {
      const { problems, qualities } = tableProblems(matrix);
      matrices[type] = { matrix, problems, qualities };
    }
    const tableErrors = Object.values(matrices).reduce((n, m) => n + m.problems.filter(p => typeof p === 'string').length, 0);
    health.tables = tableErrors === 0;
    health.tablesNote = `${lab.length} lab rows, ${natural.length} natural rows` + (tableErrors ? ` · ${tableErrors} problem(s) below` : '');
    const calcProducts = products.filter(p => parseList(p.m.gold_weight_18kt_options).length);
    productCount = calcProducts.length;
    productRows = productProblems(calcProducts, matrices);
  } catch (e) {
    console.error('Admin page error:', e);
    health.shopifyNote = 'Could not read store data';
  }

  const generatedAt = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  return res.status(200).send(page(render({ shop: (process.env.SHOPIFY_STORE_DOMAIN || store).replace(/^https?:\/\//, ''), rates, health, matrices, productRows, productCount, generatedAt }), clientId));
}
