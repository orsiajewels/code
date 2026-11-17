// Orsia Jewels — daily product sync (error log E-05 + E-06)
//
// For every active calculator product whose variant is made to order
// (inventory NOT tracked):
//   • E-05  variant price  = price of the product page's default selection,
//                            computed by the same code as checkout
//                            (lib/pricing.js → priceLine), so Google/Meta feeds
//                            and express checkout show a real price.
//   • E-06  inventory policy = CONTINUE, so switching inventory tracking on can
//                            never make a made-to-order piece "sold out".
// Variants with tracked inventory (ready-stock pieces) are never touched.
//
// Runs daily via Vercel Cron (vercel.json). Can also be previewed or run from
// the admin page (Shopify-signed link). ?dry=1 previews without writing.

import crypto from 'node:crypto';
import {
  getAccessToken, shopifyGraphQL, getGoldRates, getDiamondMatrix, priceLine,
  GoldRateUnavailable, sortedList, parseList
} from '../lib/pricing.js';

const MAX_LINK_AGE_SEC = 10 * 60;

// Same default as the theme: 9K Yellow if shown, else the first shown metal.
const METALS = [
  { key: 'show_18k_yellow', kt: 18, label: '18K Yellow Gold' },
  { key: 'show_18k_white',  kt: 18, label: '18K White Gold'  },
  { key: 'show_18k_rose',   kt: 18, label: '18K Rose Gold'   },
  { key: 'show_14k_yellow', kt: 14, label: '14K Yellow Gold' },
  { key: 'show_14k_white',  kt: 14, label: '14K White Gold'  },
  { key: 'show_14k_rose',   kt: 14, label: '14K Rose Gold'   },
  { key: 'show_9k_yellow',  kt: 9,  label: '9K Yellow Gold'  },
  { key: 'show_9k_white',   kt: 9,  label: '9K White Gold'   },
  { key: 'show_9k_rose',    kt: 9,  label: '9K Rose Gold'    },
];

export function verifyShopifyHmac(query, secret) {
  const { hmac, signature, ...rest } = query || {};
  if (!hmac || !secret) return false;
  const message = Object.keys(rest).sort()
    .map(k => `${k}=${Array.isArray(rest[k]) ? rest[k].join(',') : rest[k]}`).join('&');
  const digest = crypto.createHmac('sha256', secret).update(message).digest('hex');
  const a = Buffer.from(digest), b = Buffer.from(String(hmac));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function authorised(req) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers?.authorization || '';
  if (secret) {
    if (auth === `Bearer ${secret}`) return true;
  } else if (String(req.headers?.['user-agent'] || '').startsWith('vercel-cron/')) {
    return true;   // Vercel Cron without CRON_SECRET configured
  }
  // Manual run/preview from the admin page: Shopify-signed, fresh, this store.
  const q = req.query || {};
  const ts = parseInt(q.timestamp, 10);
  return verifyShopifyHmac(q, process.env.SHOPIFY_CLIENT_SECRET)
    && ts && Math.abs(Date.now() / 1000 - ts) < MAX_LINK_AGE_SEC
    && q.shop === process.env.SHOPIFY_STORE;
}

export function defaultSelection(meta, matrices) {
  const flag = k => String(meta[k] ?? '').toLowerCase();
  const diamondType = flag('show_lab_diamond') !== 'false' ? 'lab'
    : (flag('show_natural_diamond') === 'true' ? 'natural' : null);
  if (!diamondType) return null;

  const visible = METALS.filter(m => flag(m.key) !== 'false');
  const metal = visible.find(m => m.key === 'show_9k_yellow') || visible[0];
  if (!metal) return null;

  // Theme: qualities ordered by the price of their lowest-carat row, cheapest
  // first, then narrowed by custom.diamond_quality_options when that matches.
  const lowest = {};
  for (const r of matrices[diamondType]) {
    if (!r.quality) continue;
    if (!lowest[r.quality] || r.ctMin < lowest[r.quality].ctMin) lowest[r.quality] = r;
  }
  let qualities = Object.keys(lowest).sort((a, b) => lowest[a].price - lowest[b].price);
  const filter = parseList(meta.diamond_quality_options);
  const filtered = qualities.filter(q => filter.includes(q));
  if (filtered.length) qualities = filtered;
  if (!qualities.length) return null;

  return { diamondType, purityKt: metal.kt, metalLabel: metal.label, quality: qualities[0], ctIndex: 0 };
}

async function listProducts(token) {
  const out = [];
  let after = null;
  for (let page = 0; page < 10; page++) {
    const d = await shopifyGraphQL(`query($after: String) {
      products(first: 50, after: $after, query: "status:active") {
        pageInfo { hasNextPage endCursor }
        edges { node {
          id title
          metafields(namespace: "custom", first: 50) { edges { node { key value } } }
          variants(first: 10) { edges { node { id title price inventoryPolicy inventoryItem { tracked } } } }
        } } } }`, { after }, token);
    for (const { node } of d.products.edges) {
      const meta = {};
      node.metafields.edges.forEach(({ node: f }) => { meta[f.key] = f.value; });
      out.push({ id: node.id, title: node.title, meta, variants: node.variants.edges.map(e => e.node) });
    }
    if (!d.products.pageInfo.hasNextPage) break;
    after = d.products.pageInfo.endCursor;
  }
  return out;
}

async function updateVariants(productId, variants, token) {
  const d = await shopifyGraphQL(`mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        userErrors { field message } } }`, { productId, variants }, token);
  const errs = d.productVariantsBulkUpdate?.userErrors || [];
  if (errs.length) throw new Error(errs.map(e => e.message).join('; '));
}

export async function runSync({ dry }) {
  const token = await getAccessToken();
  const goldRates = await getGoldRates();          // throws if live rates unavailable
  const matrices = {
    lab: await getDiamondMatrix('lab', token),
    natural: await getDiamondMatrix('natural', token)
  };
  const getMatrix = async type => matrices[type];
  const products = await listProducts(token);

  const result = { dry, checked: 0, changed: [], unchanged: 0, skipped: [], errors: [] };
  for (const p of products) {
    if (!sortedList(p.meta.gold_weight_18kt_options).length) continue;        // not a calculator product
    const madeToOrder = p.variants.filter(v => v.inventoryItem && v.inventoryItem.tracked === false);
    if (!madeToOrder.length) continue;                                         // ready stock — leave alone
    result.checked++;

    const sel = defaultSelection(p.meta, matrices);
    if (!sel) { result.skipped.push({ product: p.title, reason: 'no default metal/quality/type' }); continue; }

    let unitPrice;
    try {
      ({ unitPrice } = await priceLine({ productId: p.id, ...sel }, { token, goldRates, getMatrix }));
    } catch (e) {
      result.skipped.push({ product: p.title, reason: e.message });
      continue;
    }

    const updates = [];
    for (const v of madeToOrder) {
      const u = { id: v.id };
      if (Math.abs(parseFloat(v.price) - unitPrice) >= 1) u.price = unitPrice.toFixed(2);
      if (v.inventoryPolicy !== 'CONTINUE') u.inventoryPolicy = 'CONTINUE';
      if (Object.keys(u).length > 1) {
        updates.push(u);
        result.changed.push({
          product: p.title,
          variant: v.title,
          default: `${sel.metalLabel} · ${sel.quality} · ${sel.diamondType} · option 1`,
          ...(u.price ? { priceFrom: v.price, priceTo: u.price } : {}),
          ...(u.inventoryPolicy ? { policy: `${v.inventoryPolicy} → CONTINUE` } : {})
        });
      }
    }
    if (!updates.length) { result.unchanged++; continue; }
    if (!dry) {
      try { await updateVariants(p.id, updates, token); }
      catch (e) { result.errors.push({ product: p.title, error: e.message }); }
    }
  }
  return result;
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function asHtml(r) {
  const rows = r.changed.map(c => `<tr><td>${esc(c.product)}</td><td>${esc(c.default)}</td>
    <td class="num">${c.priceTo ? `₹${Number(c.priceFrom).toLocaleString('en-IN')} → <b>₹${Number(c.priceTo).toLocaleString('en-IN')}</b>` : '—'}</td>
    <td>${esc(c.policy || '—')}</td></tr>`).join('');
  const list = (items, f) => items.length ? `<ul>${items.map(i => `<li>${esc(f(i))}</li>`).join('')}</ul>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Product sync</title><style>
body{margin:0;background:#f1f1f1;color:#303030;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:960px;margin:0 auto;padding:20px 16px 40px}.card{background:#fff;border-radius:12px;padding:16px;margin-bottom:14px;box-shadow:0 1px 0 rgba(0,0,0,.07),0 0 0 1px rgba(0,0,0,.04)}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid #e3e3e3;vertical-align:top}th{color:#616161}
td.num{text-align:right;white-space:nowrap}.muted{color:#616161}.scroll{overflow-x:auto}a{color:#005bd3}
</style></head><body><main>
<div class="card"><h1 style="font-size:20px;margin:0 0 6px">Product sync ${r.dry ? '— preview (nothing changed)' : '— done'}</h1>
<p class="muted" style="margin:0">Made-to-order calculator products checked: ${r.checked} · ${r.dry ? 'would change' : 'changed'}: ${r.changed.length} · already correct: ${r.unchanged} · skipped: ${r.skipped.length}${r.errors.length ? ` · errors: ${r.errors.length}` : ''}.
Prices are before tax, the same as checkout. Ready-stock items (inventory tracked) are never changed.</p></div>
${r.changed.length ? `<div class="card scroll"><table><thead><tr><th>Product</th><th>Default selection priced</th><th class="num">Variant price</th><th>Out-of-stock policy</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}
${r.skipped.length ? `<div class="card"><h2 style="font-size:15px;margin:0 0 8px">Skipped</h2>${list(r.skipped, s => `${s.product}: ${s.reason}`)}</div>` : ''}
${r.errors.length ? `<div class="card"><h2 style="font-size:15px;margin:0 0 8px">Errors</h2>${list(r.errors, s => `${s.product}: ${s.error}`)}</div>` : ''}
</main></body></html>`;
}

export default async function handler(req, res) {
  if (!authorised(req)) return res.status(401).json({ error: 'Not authorised' });
  const q = req.query || {};
  const dry = q.dry === '1';
  try {
    const result = await runSync({ dry });
    console.log('Product sync', JSON.stringify({ dry, checked: result.checked, changed: result.changed.length, skipped: result.skipped.length, errors: result.errors.length }));
    if (q.view === 'html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Security-Policy', `frame-ancestors https://${process.env.SHOPIFY_STORE} https://admin.shopify.com;`);
      return res.status(200).send(asHtml(result));
    }
    return res.status(200).json(result);
  } catch (e) {
    console.error('Product sync failed:', e);
    const msg = e instanceof GoldRateUnavailable ? 'Live gold rates unavailable — sync skipped, prices left as they were' : e.message;
    return res.status(e instanceof GoldRateUnavailable ? 503 : 500).json({ error: msg });
  }
}
