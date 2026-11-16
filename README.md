# Orsia Jewels — Price Calculator (Vercel)

Secure serverless function that:
1. Receives customer selections from the product page widget
2. Fetches live gold rates from GPE metafields
3. Calculates the correct price server-side
4. Creates a Shopify Draft Order at that price
5. Returns the checkout URL to the customer

---

## Setup Instructions

### Step 1 — Create a Shopify app (client credentials)

1. Shopify Admin → Settings → Apps → Develop apps → create an app ("Orsia Price Calculator")
2. Admin API scopes: `read_products`, `write_draft_orders`, `read_metaobjects`, `read_metafields`
3. Install the app and copy its **Client ID** and **Client secret**.
   The functions exchange these for a short-lived access token automatically.

### Step 2 — Deploy to Vercel

1. Create a free account at vercel.com
2. Install Vercel CLI:
   ```
   npm install -g vercel
   ```
3. Inside this folder, run:
   ```
   vercel deploy
   ```
4. Follow the prompts — choose "No" for existing project, create new

### Step 3 — Add Environment Variables in Vercel

1. Go to vercel.com → your project → Settings → Environment Variables
2. Add these variables (see `.env.example`):

   | Name | Value |
   |------|-------|
   | SHOPIFY_STORE | your-store.myshopify.com |
   | SHOPIFY_STORE_DOMAIN | orsiajewels.com |
   | SHOPIFY_CLIENT_ID | from Step 1 |
   | SHOPIFY_CLIENT_SECRET | from Step 1 |
   | SHOP_CURRENCY_CODE | INR (optional) |

3. After adding, go to Deployments → Redeploy

### Step 4 — Update your Shopify liquid file

Replace `YOUR-APP.vercel.app` in the liquid file with your actual Vercel URL.
Your Vercel URL looks like: `orsia-price-calculator.vercel.app`

The fetch call in your liquid file should be:
```
https://orsia-price-calculator.vercel.app/api/create-order
```

### Step 5 — Test

1. Visit any product page
2. Select purity + CT + quality
3. Click Calculate
4. Click Buy Now
5. Confirm you land on Shopify checkout at the correct price

---

## File Structure

```
orsia-vercel/
├── api/
│   ├── create-order.js   ← Price calculation + draft order
│   └── gold-rates.js     ← Live gold rate proxy (GPE metafield)
├── .env.example          ← Template for environment variables
├── .gitignore            ← Prevents .env from being committed
├── package.json          ← Project config
├── vercel.json           ← Vercel config
└── README.md             ← This file
```

---

## Updating Diamond Prices

If your diamond matrix prices change, edit `api/create-order.js` —
find the `DIAMOND_MATRIX` array at the top and update the price values.
Then redeploy:
```
vercel deploy --prod
```

## Updating Making Charges

Find `MAKING_CHARGE_PER_GRAM` at the top of `api/create-order.js`
and change the value. Then redeploy.

---

## Security

- Browser sends only selections (product, purity, CT option index, quality, type).
  Gold weight **and diamond weights** are read from product metafields
  (`gold_weight_18kt_options`, `solitaire_ct_options`, `side_ct_options`) by CT index.
- An unknown quality / unmatched CT bucket refuses the order (never prices diamonds at 0).
- If live gold rates are unavailable, orders are refused (HTTP 503) instead of using stale fallback rates.
- Requests from other website origins are rejected; each IP is limited to 10 orders per 10 minutes (best-effort, per instance).
- Shopify credentials never reach the browser; error responses don't expose internal details.
