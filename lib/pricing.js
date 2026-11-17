// Orsia Jewels — shared pricing + Shopify helpers.
// Used by api/create-order.js (checkout), api/admin.js and api/sync-products.js,
// so every place computes prices the same way.

// Orsia Jewels — Secure Price Calculator (Solitaire + Side Diamonds)
// Rewritten to use the GraphQL Admin API (2025-01+) so we can attach a real
// variant_id to the draft order line item AND override its price via
// lineItem.priceOverride — this makes the checkout show the product image
// while still charging the calculated price. (REST draft_orders.json
// ignores a custom `price` field when `variant_id` is present, so REST
// can't do this — confirmed via Shopify's own API changelog + community
// reports before switching.)

export const MAKING_CHARGE_PER_GRAM = 2500;
export const VALID_PURITIES         = [9, 14, 18];
export const CURRENCY_CODE          = process.env.SHOP_CURRENCY_CODE || 'INR';
export const API_VERSION            = '2025-01'; // priceOverride requires 2025-01+

// Weight-only karat factors. Admin enters 18K weight; code derives other karats.
// Rates are NOT derived here — they come directly from the gold-rates proxy.
export const KARAT_WEIGHT_FACTOR = { 18: 0.79, 14: 0.62, 9: 0.40 };

// Matches the front-end's r2() exactly — floors to 2 decimals, NOT round/toFixed.
// Keeping this identical on both sides is required so checkout price always
// matches what the customer saw on the PDP.
export function r2(n) {
  return Math.floor(parseFloat(n) * 100) / 100;
}

// base18k = admin-entered 18K weight for this CT option (from product metafield)
// Derives 24K first (÷ 0.79), then scales to the selected karat
export function getGoldWeight(base18k, purityKt) {
  const base24k  = r2(base18k) / KARAT_WEIGHT_FACTOR[18];       // ÷ 0.79 → 24K
  const factor   = KARAT_WEIGHT_FACTOR[purityKt] || KARAT_WEIGHT_FACTOR[18];
  return r2(base24k * factor);
}

// ── Basic abuse protection (best-effort, per serverless instance) ───────────
export const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
export const RATE_LIMIT_MAX       = 10;             // draft orders per IP per window
export const MAX_TEXT_LEN         = 100;            // engraving / free-text fields
export const MAX_LINES            = 10;             // different products per checkout
export const MAX_QTY_PER_LINE     = 20;             // pieces of one configuration
export const rateBuckets = new Map();

export function isRateLimited(ip) {
  const now = Date.now();
  const hits = (rateBuckets.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  hits.push(now);
  rateBuckets.set(ip, hits);
  if (rateBuckets.size > 5000) rateBuckets.clear(); // keep memory bounded
  return hits.length > RATE_LIMIT_MAX;
}

export function cleanText(v) {
  if (v === undefined || v === null) return '';
  return String(v).trim().slice(0, MAX_TEXT_LEN);
}

// Carat and gold-weight lists are always used smallest → largest, the same
// order the product page displays them in, so a list typed out of order
// can't make checkout price a different pairing than the page shows.
export function sortedList(raw) {
  return parseList(raw)
    .map(v => parseFloat(v))
    .filter(v => !Number.isNaN(v))
    .sort((a, b) => a - b);
}

export function parseList(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    const n = parseFloat(raw);
    return n > 0 ? [n] : [];
  }
}

// Access tokens from client_credentials last ~24h — reuse instead of
// requesting a new one on every order.
export let cachedToken = null;
export let tokenExpiresAt = 0;

export async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
  const res = await fetch(
    `https://${process.env.SHOPIFY_STORE}/admin/oauth/access_token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id:     process.env.SHOPIFY_CLIENT_ID,
        client_secret: process.env.SHOPIFY_CLIENT_SECRET,
        grant_type:    'client_credentials'
      })
    }
  );
  const data = await res.json();
  if (!data.access_token) throw new Error('Failed to get access token');
  cachedToken = data.access_token;
  const ttlSec = parseInt(data.expires_in, 10) || 3600;
  tokenExpiresAt = Date.now() + Math.max(ttlSec - 300, 60) * 1000; // refresh 5 min early
  return cachedToken;
}

// ── Shared GraphQL helper ────────────────────────────────────────────────
export async function shopifyGraphQL(query, variables, token) {
  const res = await fetch(
    `https://${process.env.SHOPIFY_STORE}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query, variables })
    }
  );
  const data = await res.json();
  if (data.errors) {
    console.error('GraphQL errors:', JSON.stringify(data.errors));
    throw new Error(data.errors[0]?.message || 'GraphQL request failed');
  }
  return data.data;
}

export function toProductGid(productId) {
  return String(productId).startsWith('gid://')
    ? productId
    : `gid://shopify/Product/${productId}`;
}

// ── Live gold rate fetch — returns per-karat rates directly from proxy ────────
// (External Vercel proxy — unrelated to Shopify's API, stays REST.)
// Never sell at a stale/hardcoded rate: if live rates are unavailable, or the
// proxy itself is serving its fallback, this throws and the order is refused.
// Calls this same deployment's /api/gold-rates. Vercel sets
// VERCEL_PROJECT_PRODUCTION_URL automatically, so no address is hardcoded.
// GOLD_RATES_URL can override it if ever needed.
export function goldRatesUrl() {
  if (process.env.GOLD_RATES_URL) return process.env.GOLD_RATES_URL;
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  if (!host) throw new GoldRateUnavailable('Cannot determine gold-rates URL');
  return `https://${host}/api/gold-rates`;
}

export async function getGoldRates() {
  const res = await fetch(goldRatesUrl(), {
    headers: { 'Accept': 'application/json' }
  });
  const data = await res.json();
  if (data.fallback) {
    throw new GoldRateUnavailable('Proxy is serving fallback rates: ' + (data.error || 'unknown'));
  }
  if (!(data.rate18k > 1000 && data.rate14k > 1000 && data.rate9k > 1000)) {
    throw new GoldRateUnavailable('Invalid rates from proxy');
  }
  return { 18: data.rate18k, 14: data.rate14k, 9: data.rate9k };
}

export class GoldRateUnavailable extends Error {}
export class PricingError extends Error {}
export class InputError extends Error {}

// ── Product metafields via GraphQL ──────────────────────────────────────
export async function getProductMetafields(productId, token) {
  const query = `
    query GetProductMetafields($id: ID!) {
      product(id: $id) {
        title
        metafields(namespace: "custom", first: 50) {
          edges {
            node { key value namespace }
          }
        }
      }
    }
  `;
  const data = await shopifyGraphQL(query, { id: toProductGid(productId) }, token);
  const edges = data.product?.metafields?.edges || [];
  const fields = {};
  edges.forEach(({ node }) => {
    fields[node.key] = node.value;
    fields[`${node.namespace}.${node.key}`] = node.value;
  });
  fields.__title = data.product?.title || '';
  return fields;
}

// ── First variant + its catalog price (for image + price-override decision) ─
export async function getVariantForPrice(productId, token) {
  const query = `
    query GetFirstVariant($id: ID!) {
      product(id: $id) {
        variants(first: 1) {
          edges {
            node { id price }
          }
        }
      }
    }
  `;
  const data = await shopifyGraphQL(query, { id: toProductGid(productId) }, token);
  const edge = data.product?.variants?.edges?.[0];
  if (!edge) return null;
  return { id: edge.node.id, price: parseFloat(edge.node.price) || 0 };
}

export async function getDiamondMatrix(diamondType, token) {
  const handle = diamondType === 'lab' ? 'lab_diamond_matrix' : 'natural_diamond_matrix';

  const query = `
    query GetMatrix($type: String!) {
      metaobjects(type: $type, first: 250) {
        edges {
          node {
            fields { key value }
          }
        }
      }
    }
  `;

  const data = await shopifyGraphQL(query, { type: handle }, token);
  const edges = data.metaobjects?.edges || [];
  console.log(`Diamond matrix (${handle}): ${edges.length} rows fetched`);

  return edges.map(({ node }) => {
    const f = {};
    (node.fields || []).forEach(field => { f[field.key] = field.value; });
    return {
      quality: f.quality_label || '',
      ctMin:   parseFloat(f.ct_min || 0),
      ctMax:   parseFloat(f.ct_max || 0),
      price:   parseInt(f.price_per_ct || 0, 10)
    };
  });
}

export function calcDiamondGroupPrice(matrix, quality, totalWt, count) {
  if (!totalWt) return 0;
  // Trim per-stone CT to 2dp before matrix lookup — must match front-end exactly,
  // otherwise a weight near a bucket boundary can select a different price row.
  const perCt = r2(count > 0 ? totalWt / count : totalWt);
  const row = matrix.find(r => {
    const ctMinR = r2(r.ctMin);
    const ctMaxR = r2(r.ctMax);
    return r.quality === quality && perCt >= ctMinR && perCt <= ctMaxR;
  });
  if (!row) {
    // Never price diamonds at 0 — an unknown quality or an unmatched CT bucket
    // must stop the order, not give the stones away.
    throw new PricingError(`No diamond price for quality "${quality}" at ${perCt}ct per stone`);
  }
  return row.price * totalWt;
}

// ── Draft order creation via GraphQL ────────────────────────────────────
export async function createDraftOrderGraphQL(lineItems, note, token) {
  const query = `
    mutation CreateDraftOrder($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder {
          id
          invoiceUrl
        }
        userErrors {
          field
          message
        }
      }
    }
  `;
  const data = await shopifyGraphQL(
    query,
    { input: { lineItems, note } },
    token
  );

  const result = data.draftOrderCreate;
  if (result.userErrors && result.userErrors.length > 0) {
    console.error('draftOrderCreate userErrors:', JSON.stringify(result.userErrors));
    throw new Error(result.userErrors.map(e => e.message).join('; '));
  }
  return result.draftOrder;
}

// ── Diamond shape (E-01) ─────────────────────────────────────────────────────
// Order of trust: a shape the customer picked from the product's own shape
// selector (must be a known shape) → product metafield custom.diamond_shape →
// the product title as stored in Shopify (not as sent by the browser).
export const KNOWN_SHAPES = ['Round','Oval','Princess','Emerald','Asscher','Cushion','Radiant','Pear','Marquise','Heart','Baguette','Trillion','Trilliant'];
export function canonicalShape(v) {
  const t = String(v || '').trim().toLowerCase();
  return KNOWN_SHAPES.find(k => k.toLowerCase() === t) || null;
}
export function resolveShape(browserShape, meta) {
  const picked = canonicalShape(browserShape);
  if (picked) return picked;
  const fromMeta = canonicalShape(meta.diamond_shape || meta['custom.diamond_shape']);
  if (fromMeta) return fromMeta;
  const title = meta.__title || '';
  for (const k of KNOWN_SHAPES) {
    if (new RegExp('\\b' + k + '\\b', 'i').test(title)) return k;
  }
  return null;   // unknown — leave it off the order rather than guess
}

// ── Price one line (one product configuration × quantity) ─────────────────
// All prices are computed here from Shopify data; the browser only sends
// choices (product, purity, CT option index, quality, type, quantity).
export async function priceLine(item, { token, goldRates, getMatrix }) {
  const {
    productId, productTitle,
    purityKt, metalLabel, quality, diamondType,
    // solWt / sideWt may still be sent by the front-end but are IGNORED —
    // diamond weights are read from product metafields by ctIndex.
    ctIndex, shape, ringSize, certType
  } = item;
  const engravingText = cleanText(item.engravingText);

  const missing = Object.entries({ productId, purityKt, quality, diamondType })
    .filter(([, v]) => v === undefined || v === null || v === '')
    .map(([k]) => k);
  if (missing.length) {
    throw new InputError('Missing required fields: ' + missing.join(', '));
  }
  if (!/^(gid:\/\/shopify\/Product\/)?\d+$/.test(String(productId))) {
    throw new InputError('Invalid product');
  }
  const purityInt = parseInt(purityKt, 10);
  if (!VALID_PURITIES.includes(purityInt)) throw new InputError('Invalid purity');
  if (!['lab', 'natural'].includes(diamondType)) throw new InputError('Invalid diamond type');

  const ctIdx = parseInt(ctIndex, 10) || 0;
  if (ctIdx < 0) throw new InputError('Invalid CT option');

  const quantity = (item.quantity === undefined || item.quantity === null || item.quantity === '')
    ? 1 : Number(item.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY_PER_LINE) {
    throw new InputError(`Quantity must be between 1 and ${MAX_QTY_PER_LINE}`);
  }

  const meta = await getProductMetafields(productId, token);

  // Only sell a diamond type the product actually offers (same rule as the theme:
  // lab is on unless show_lab_diamond = false; natural is off unless = true).
  const flag = k => String(meta[k] ?? meta['custom.' + k] ?? '').toLowerCase();
  if (diamondType === 'natural' && flag('show_natural_diamond') !== 'true') {
    throw new InputError('Natural diamonds are not available for this product');
  }
  if (diamondType === 'lab' && flag('show_lab_diamond') === 'false') {
    throw new InputError('Lab grown diamonds are not available for this product');
  }

  // ── 18K gold weight for this CT option ──────────────────────────────────
  // Metafield: custom.gold_weight_18kt_options  (type: list.number_decimal)
  // Code derives: 24K = 18K ÷ 0.79, then 14K = 24K × 0.62, 9K = 24K × 0.40
  const goldWt18kOptions = sortedList(meta.gold_weight_18kt_options || meta['custom.gold_weight_18kt_options']);
  const base18k = parseFloat(goldWt18kOptions[ctIdx]) || 0;
  if (!base18k) {
    console.warn('Gold weight not configured', { productId, ctIdx });
    throw new InputError('This option is not available for this product');
  }

  const solCount  = parseInt(meta.solitaire_count || meta['custom.solitaire_count'] || 0, 10);
  const sideCount = parseInt(meta.side_count      || meta['custom.side_count']      || 0, 10);

  // Diamond weights come from the product, never from the browser.
  // Metafields: custom.solitaire_ct_options / custom.side_ct_options
  const solOptions  = sortedList(meta.solitaire_ct_options || meta['custom.solitaire_ct_options']);
  const sideOptions = sortedList(meta.side_ct_options      || meta['custom.side_ct_options']);
  // The three lists are matched by position. If a list exists but has no entry
  // for this option, the option is misconfigured — refuse instead of pricing it
  // without those diamonds.
  if ((solOptions.length && ctIdx >= solOptions.length) || (sideOptions.length && ctIdx >= sideOptions.length)) {
    console.warn('Carat lists out of step', { productId, ctIdx, gold: goldWt18kOptions.length, sol: solOptions.length, side: sideOptions.length });
    throw new InputError('This option is not available for this product');
  }
  const solWtFloat  = parseFloat(solOptions[ctIdx])  || 0;
  const sideWtFloat = parseFloat(sideOptions[ctIdx]) || 0;
  if (solWtFloat <= 0 && sideWtFloat <= 0) {
    console.warn('Diamond weights not configured', { productId, ctIdx });
    throw new InputError('This option is not available for this product');
  }
  const totalCt = +(solWtFloat + sideWtFloat).toFixed(3);

  const goldWt    = getGoldWeight(base18k, purityInt);   // derives 24K then scales to karat
  const goldPrice = goldWt * goldRates[purityInt];

  const matrix    = await getMatrix(diamondType);
  const solPrice  = calcDiamondGroupPrice(matrix, quality, solWtFloat,  solCount);
  const sidePrice = calcDiamondGroupPrice(matrix, quality, sideWtFloat, sideCount);

  const making    = MAKING_CHARGE_PER_GRAM * goldWt;
  const subtotal  = goldPrice + solPrice + sidePrice + making;
  const certPrice = certType ? 1000 : 0;
  // GST is not added here — Shopify's tax settings apply it on the draft
  // order based on the customer's address, so this price is tax-exclusive.
  const unitPrice = Math.round(subtotal) + certPrice;

  console.log('Price calc:', {
    productId, quantity, base18k, goldWt, goldRate: goldRates[purityInt],
    goldPrice, solPrice, sidePrice, making, unitPrice
  });

  const shapeName        = resolveShape(shape, meta);
  const colorMatch       = (metalLabel || '').match(/Yellow|White|Rose/i);
  const colorName        = colorMatch ? colorMatch[0] : 'Yellow';
  const diamondTypeLabel = diamondType === 'lab' ? 'Lab Grown Diamond' : 'Natural Diamond';

  const customAttributes = [
    { key: 'Gold Purity',     value: purityInt + 'kt'        },
    { key: 'Metal Color',     value: colorName               },
    { key: 'Gold Weight',     value: goldWt.toFixed(3) + 'g' },
    { key: 'Diamond Type',    value: diamondTypeLabel        },
    { key: 'Diamond Quality', value: cleanText(quality)      },
    { key: 'Total CT',        value: totalCt + 'ct'          },
    ...(solWtFloat  > 0 ? [{ key: 'Solitaire Count',     value: solCount + ' pcs' }] : []),
    ...(solWtFloat  > 0 ? [{ key: 'Solitaire Weight',    value: solWtFloat + 'ct' }] : []),
    ...(sideWtFloat > 0 ? [{ key: 'Side Diamond Count',  value: sideCount + ' pcs' }] : []),
    ...(sideWtFloat > 0 ? [{ key: 'Side Diamond Weight', value: sideWtFloat + 'ct' }] : []),
    ...(ringSize      ? [{ key: 'Ring Size',      value: cleanText(ringSize) }] : []),
    ...(shapeName     ? [{ key: 'Diamond Shape',  value: shapeName           }] : []),
    ...(certType      ? [{ key: 'Certificate',    value: cleanText(certType) }] : []),
    ...(engravingText ? [{ key: 'Engraving Text', value: engravingText       }] : [])
  ];

  // Attach a real variant so checkout shows the product image; priceOverride
  // (GraphQL 2025-01+) sets the per-unit price. Shopify multiplies by quantity.
  const variant = await getVariantForPrice(productId, token);
  const lineItem = variant
    ? {
        variantId: variant.id,
        quantity,
        priceOverride: { amount: unitPrice.toFixed(2), currencyCode: CURRENCY_CODE },
        customAttributes
      }
    : {
        // No variant found — fall back to a custom line item (no image).
        title: cleanText(meta.__title || productTitle || 'Orsia Jewellery'),
        quantity,
        originalUnitPriceWithCurrency: { amount: unitPrice.toFixed(2), currencyCode: CURRENCY_CODE },
        requiresShipping: true,
        customAttributes
      };

  return {
    lineItem, unitPrice, quantity,
    note: `Orsia — ${purityInt}kt / ${totalCt}ct / ${cleanText(quality)} / ${diamondType}`,
    breakdown: {
      goldWeight18k:    base18k,
      goldWeightActual: goldWt,
      goldRate:         goldRates[purityInt],
      goldPrice:        Math.round(goldPrice),
      solPrice:         Math.round(solPrice),
      sidePrice:        Math.round(sidePrice),
      making:           Math.round(making),
      total:            unitPrice
    }
  };
}

