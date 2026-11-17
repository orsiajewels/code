// Orsia Jewels — Secure Price Calculator: checkout endpoint.
// Pricing logic lives in lib/pricing.js (shared with the admin page and the
// daily product sync).

import {
  MAX_LINES,
  isRateLimited,
  getAccessToken,
  getGoldRates,
  GoldRateUnavailable,
  PricingError,
  InputError,
  getDiamondMatrix,
  createDraftOrderGraphQL,
  priceLine
} from '../lib/pricing.js';

export default async function handler(req, res) {

  const rawDomain    = (process.env.SHOPIFY_STORE_DOMAIN || '').replace(/^https?:\/\//, '');
  const allowedOrigin = `https://${rawDomain}`;
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  // Browsers always send Origin on cross-site POSTs — reject other sites.
  const origin = req.headers.origin;
  if (origin && origin !== allowedOrigin && origin !== `https://www.${rawDomain}`) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many requests, please try again in a few minutes' });
  }

  try {
    const body = req.body || {};

    // The product page sends one item at the top level. The cart drawer sends
    // one item with `quantity`, or { items: [...] } for several products.
    const rawItems = Array.isArray(body.items) ? body.items : [body];
    if (rawItems.length === 0 || rawItems.length > MAX_LINES) {
      throw new InputError(`You can check out up to ${MAX_LINES} different items at once`);
    }

    const token     = await getAccessToken();
    const goldRates = await getGoldRates();   // one live rate for the whole order
    const matrixCache = {};
    const getMatrix = (type) =>
      (matrixCache[type] = matrixCache[type] || getDiamondMatrix(type, token));

    const lines = [];
    for (const raw of rawItems) {
      lines.push(await priceLine(raw || {}, { token, goldRates, getMatrix }));
    }

    const lineItems  = lines.map(l => l.lineItem);
    const orderTotal = lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);
    const note = lines.length === 1
      ? lines[0].note + (lines[0].quantity > 1 ? ` x ${lines[0].quantity}` : '')
      : `Orsia — ${lines.length} items: ` + lines.map(l => `${l.note} x ${l.quantity}`).join(' | ');

    const draftOrder = await createDraftOrderGraphQL(lineItems, note, token);
    if (!draftOrder) {
      return res.status(500).json({ error: 'Failed to create order' });
    }

    const response = { checkoutUrl: draftOrder.invoiceUrl, calculatedPrice: orderTotal };
    if (lines.length === 1) {
      response.unitPrice = lines[0].unitPrice;
      response.quantity  = lines[0].quantity;
      response.breakdown = lines[0].breakdown;
    } else {
      response.items = lines.map(l => ({ unitPrice: l.unitPrice, quantity: l.quantity }));
    }
    return res.status(200).json(response);

  } catch(err) {
    if (err instanceof GoldRateUnavailable) {
      console.error('Order refused — live gold rate unavailable:', err.message);
      return res.status(503).json({ error: 'Live gold rates are temporarily unavailable. Please try again shortly.' });
    }
    if (err instanceof InputError) {
      return res.status(400).json({ error: err.message });
    }
    if (err instanceof PricingError) {
      console.error('Order refused — pricing error:', err.message);
      return res.status(400).json({ error: 'This combination is not available. Please choose a different option.' });
    }
    console.error('Orsia order error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
