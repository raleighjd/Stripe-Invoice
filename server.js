// server.js
require('dotenv').config();
console.log('STRIPE_SECRET_KEY:', process.env.STRIPE_SECRET_KEY);

const express = require('express');
const axios = require('axios');
const app = express();

// Initialize Stripe only if we have a valid API key
let stripe = null;
if (process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY.trim() !== '') {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
} else {
  console.warn('⚠️  STRIPE_SECRET_KEY not found or empty. Stripe features will be disabled.');
}

const CONFIG = {
  AWS_BUCKET_URL: process.env.AWS_BUCKET_URL || 'https://leadprocessor.s3.us-east-2.amazonaws.com',
  PORT: process.env.PORT || 3000,
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || 'http://localhost:3000',
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || '',
  ALLOWED_SHIP_COUNTRIES: (process.env.ALLOWED_SHIP_COUNTRIES || 'US,CA')
    .split(',')
    .map(s => s.trim().toUpperCase())
};

// ---- Airtable loader with PAT (cached) ----
const AIRTABLE = {
  token: process.env.AIRTABLE_PAT,             // ← Personal Access Token (pat_…)
  baseId: process.env.AIRTABLE_BASE_ID,        // e.g. appXXXXXXXXXXXXXX
  table: process.env.AIRTABLE_TABLE_NAME || 'Products',
};

// In-memory cache (5 minutes TTL)
let _airtableCache = { products: null, expiresAt: 0 };

function safeJsonParse(str, fallback) {
  if (!str || typeof str !== 'string') return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

function mapAirtableRecordToProduct(rec) {
  const f = rec.fields || {};
  const pricing = safeJsonParse(f.pricing_json, []);
  const boxesObj = safeJsonParse(f.boxes, { boxes: [] });
  return {
    id: f.product_id || f.id || rec.id,
    name: f.name || '',
    sku: f.sku || '',
    description: f.description || '',
    imageFile: f.image_file || '',
    pricing: Array.isArray(pricing) ? pricing : [],
    boxes: Array.isArray(boxesObj?.boxes) ? boxesObj.boxes : [],
  };
}

async function fetchAirtablePage(offset) {
  if (!AIRTABLE.token || !AIRTABLE.baseId) {
    throw new Error('Missing AIRTABLE_PAT or AIRTABLE_BASE_ID');
  }
  const url = `https://api.airtable.com/v0/${AIRTABLE.baseId}/${encodeURIComponent(AIRTABLE.table)}`;
  const params = { pageSize: 100, ...(offset ? { offset } : {}) };
  const { data } = await axios.get(url, {
    params,
    headers: { Authorization: `Bearer ${AIRTABLE.token}` },
    timeout: 15000,
  });
  return data;
}

async function fetchProductsFromAirtableRaw() {
  let records = [];
  let offset;
  do {
    const page = await fetchAirtablePage(offset);
    records = records.concat(page.records || []);
    offset = page.offset;
  } while (offset);

  const rows = records
    .map(mapAirtableRecordToProduct)
    .filter(r => r.id && r.imageFile && Array.isArray(r.pricing));

  if (!rows.length) throw new Error('No valid products from Airtable');
  return rows;
}

async function fetchProductsFromAirtableCached() {
  const now = Date.now();
  if (_airtableCache.products && _airtableCache.expiresAt > now) {
    return _airtableCache.products;
  }
  const fresh = await fetchProductsFromAirtableRaw();
  _airtableCache = { products: fresh, expiresAt: now + 5 * 60 * 1000 };
  return fresh;
}

// Admin-only: force cache reload
app.post('/api/admin/reload-products', async (req, res) => {
  try {
    const fresh = await fetchProductsFromAirtableRaw();
    _airtableCache = { products: fresh, expiresAt: Date.now() + 5 * 60 * 1000 };
    res.json({ ok: true, count: fresh.length });
  } catch (e) {
    const hint = /403/.test(String(e)) ? ' (check PAT scopes & base access)' : '';
    res.status(500).json({ error: e.message + hint });
  }
});

/* ---------------------------------
   Product Catalog (local fallback)
   --------------------------------- */
const PRODUCTS = [
  {
    id: 'PROD001',
    name: 'Premium T-Shirt - Black',
    sku: 'TSHIRT-18500-BLACK',
    category: 'apparel',
    description: 'Premium cotton t-shirt with custom logo',
    imageFile: '18500_Black_Flat_Front-01_big_back.png',
    pricing: [
      { minQty: 1, maxQty: 9, price: 29.99 },
      { minQty: 10, maxQty: 49, price: 26.99 },
      { minQty: 50, maxQty: 99, price: 23.99 },
      { minQty: 100, maxQty: null, price: 19.99 }
    ]
  },
  {
    id: 'PROD002',
    name: 'Premium T-Shirt - Dark Chocolate',
    sku: 'TSHIRT-18500-CHOC',
    category: 'apparel',
    description: 'Premium cotton t-shirt in dark chocolate with custom logo',
    imageFile: '18500_Dark Chocolate_Flat_Front-01_big_back.png',
    pricing: [
      { minQty: 1, maxQty: 9, price: 29.99 },
      { minQty: 10, maxQty: 49, price: 26.99 },
      { minQty: 50, maxQty: 99, price: 23.99 },
      { minQty: 100, maxQty: null, price: 19.99 }
    ]
  },
  {
    id: 'PROD003',
    name: 'Classic T-Shirt - Black',
    sku: 'TSHIRT-2000-BLACK',
    category: 'apparel',
    description: 'Classic fit t-shirt with custom logo',
    imageFile: '2000_black_flat_front-01_right_chest.png',
    pricing: [
      { minQty: 1, maxQty: 19, price: 24.99 },
      { minQty: 20, maxQty: 99, price: 21.99 },
      { minQty: 100, maxQty: 499, price: 18.99 },
      { minQty: 500, maxQty: null, price: 15.99 }
    ]
  },
  {
    id: 'PROD004',
    name: 'Classic T-Shirt - Charcoal',
    sku: 'TSHIRT-2000-CHARCOAL',
    category: 'apparel',
    description: 'Classic fit charcoal t-shirt with custom logo',
    imageFile: '2000_charcoal_flat_front-01_right_chest.png',
    pricing: [
      { minQty: 1, maxQty: 19, price: 24.99 },
      { minQty: 20, maxQty: 99, price: 21.99 },
      { minQty: 100, maxQty: 499, price: 18.99 },
      { minQty: 500, maxQty: null, price: 15.99 }
    ]
  },
  {
    id: 'PROD005',
    name: 'Heavy Cotton T-Shirt - Black',
    sku: 'TSHIRT-5400-BLACK',
    category: 'apparel',
    description: 'Heavy cotton t-shirt with custom logo',
    imageFile: '5400_black_flat_front-01_right_chest.png',
    pricing: [
      { minQty: 1, maxQty: 24, price: 19.99 },
      { minQty: 25, maxQty: 99, price: 17.99 },
      { minQty: 100, maxQty: 999, price: 14.99 },
      { minQty: 1000, maxQty: null, price: 12.99 }
    ]
  },
  {
    id: 'PROD006',
    name: 'Canvas T-Shirt - Duck Brown',
    sku: 'CSV40-DUCKBROWN',
    category: 'apparel',
    description: 'Canvas v-neck t-shirt in duck brown with custom logo',
    imageFile: 'CSV40_duckbrown_flat_front-01_right_chest.png',
    pricing: [
      { minQty: 1, maxQty: 49, price: 22.99 },
      { minQty: 50, maxQty: 249, price: 19.99 },
      { minQty: 250, maxQty: 999, price: 16.99 },
      { minQty: 1000, maxQty: null, price: 14.99 }
    ]
  },
  {
    id: 'PROD007',
    name: 'Safety T-Shirt - Yellow',
    sku: 'CSV106-SAFETY',
    category: 'apparel',
    description: 'High visibility safety yellow t-shirt with custom logo',
    imageFile: 'CSV106_safetyyellow_flat_front_right_chest.png',
    pricing: [
      { minQty: 1, maxQty: 49, price: 18.99 },
      { minQty: 50, maxQty: 249, price: 16.99 },
      { minQty: 250, maxQty: 999, price: 14.99 },
      { minQty: 1000, maxQty: null, price: 12.99 }
    ]
  },
  {
    id: 'PROD008',
    name: 'Casual T-Shirt - Black',
    sku: 'CT104050-BLACK',
    category: 'apparel',
    description: 'Casual black t-shirt with custom logo',
    imageFile: 'CT104050_black_flat_front-01_right_chest.png',
    pricing: [
      { minQty: 1, maxQty: 49, price: 26.99 },
      { minQty: 50, maxQty: 249, price: 23.99 },
      { minQty: 250, maxQty: 999, price: 20.99 },
      { minQty: 1000, maxQty: null, price: 17.99 }
    ]
  },
  {
    id: 'PROD009',
    name: 'Casual T-Shirt - Carhartt Brown',
    sku: 'CT104050-BROWN',
    category: 'apparel',
    description: 'Casual Carhartt brown t-shirt with custom logo',
    imageFile: 'CT104050_carharttbrown_flat_front-01_right_chest.png',
    pricing: [
      { minQty: 1, maxQty: 49, price: 26.99 },
      { minQty: 50, maxQty: 249, price: 23.99 },
      { minQty: 250, maxQty: 999, price: 20.99 },
      { minQty: 1000, maxQty: null, price: 17.99 }
    ]
  },
  {
    id: 'PROD010',
    name: 'Fashion T-Shirt - Black',
    sku: 'F170-BLACK',
    category: 'apparel',
    description: 'Fashion fit black t-shirt with custom logo',
    imageFile: 'F170_Black_flat_front-01_big_back.png',
    pricing: [
      { minQty: 1, maxQty: 49, price: 21.99 },
      { minQty: 50, maxQty: 249, price: 19.99 },
      { minQty: 250, maxQty: 999, price: 16.99 },
      { minQty: 1000, maxQty: null, price: 14.99 }
    ]
  },
  {
    id: 'PROD011',
    name: 'Heavy Blend T-Shirt - Black',
    sku: 'G2400-BLACK',
    category: 'apparel',
    description: 'Heavy blend black t-shirt with custom logo',
    imageFile: 'G2400_Black_flat_front-01_big_back.png',
    pricing: [
      { minQty: 1, maxQty: 49, price: 23.99 },
      { minQty: 50, maxQty: 249, price: 20.99 },
      { minQty: 250, maxQty: 999, price: 17.99 },
      { minQty: 1000, maxQty: null, price: 15.99 }
    ]
  },
  {
    id: 'PROD012',
    name: 'Heavy Blend T-Shirt - Charcoal',
    sku: 'G2400-CHARCOAL',
    category: 'apparel',
    description: 'Heavy blend charcoal t-shirt with custom logo',
    imageFile: 'G2400_charcoal_flat_front-01_big_back.png',
    pricing: [
      { minQty: 1, maxQty: 49, price: 23.99 },
      { minQty: 50, maxQty: 249, price: 20.99 },
      { minQty: 250, maxQty: 999, price: 17.99 },
      { minQty: 1000, maxQty: null, price: 15.99 }
    ]
  },
  {
    id: 'PROD013',
    name: 'Heavy Blend T-Shirt - Dark Chocolate',
    sku: 'G2400-DARKCHOC',
    category: 'apparel',
    description: 'Heavy blend dark chocolate t-shirt with custom logo',
    imageFile: 'G2400_darkchocolate_flat_front-01_big_back.png',
    pricing: [
      { minQty: 1, maxQty: 49, price: 23.99 },
      { minQty: 50, maxQty: 249, price: 20.99 },
      { minQty: 250, maxQty: 999, price: 17.99 },
      { minQty: 1000, maxQty: null, price: 15.99 }
    ]
  },
  {
    id: 'PROD014',
    name: 'Lightweight T-Shirt - Black',
    sku: 'K540-BLACK',
    category: 'apparel',
    description: 'Lightweight black t-shirt with custom logo',
    imageFile: 'K540_Black_Flat_Front-01_right_chest.png',
    pricing: [
      { minQty: 1, maxQty: 49, price: 27.99 },
      { minQty: 50, maxQty: 249, price: 24.99 },
      { minQty: 250, maxQty: 999, price: 21.99 },
      { minQty: 1000, maxQty: null, price: 18.99 }
    ]
  },
  {
    id: 'PROD015',
    name: 'Nike Dri-FIT T-Shirt - Black',
    sku: 'NKCY9963-BLACK',
    category: 'apparel',
    description: 'Nike Dri-FIT performance t-shirt with custom logo',
    imageFile: 'NKDC1963_Black_Flat_Front-01_right_chest.png',
    pricing: [
      { minQty: 1, maxQty: 24, price: 44.99 },
      { minQty: 25, maxQty: 99, price: 40.99 },
      { minQty: 100, maxQty: 499, price: 36.99 },
      { minQty: 500, maxQty: null, price: 32.99 }
    ]
  },
  {
    id: 'PROD016',
    name: 'Performance T-Shirt - Black',
    sku: 'PC78SP-BLACK',
    category: 'apparel',
    description: 'Performance jet black t-shirt with custom logo',
    imageFile: 'PC78SP_JET BLACK_Flat_Front-01_right_chest.png',
    pricing: [
      { minQty: 1, maxQty: 49, price: 31.99 },
      { minQty: 50, maxQty: 249, price: 28.99 },
      { minQty: 250, maxQty: 999, price: 25.99 },
      { minQty: 1000, maxQty: null, price: 22.99 }
    ]
  },
  {
    id: 'PROD017',
    name: 'Tri-Blend T-Shirt - Black',
    sku: 'TL1763H-BLACK',
    category: 'apparel',
    description: 'Tri-blend black t-shirt with custom logo',
    imageFile: 'TLJ763H_Black_Flat_Front-01_right_chest.png',
    pricing: [
      { minQty: 1, maxQty: 49, price: 34.99 },
      { minQty: 50, maxQty: 249, price: 31.99 },
      { minQty: 250, maxQty: 999, price: 27.99 },
      { minQty: 1000, maxQty: null, price: 24.99 }
    ]
  },
  {
    id: 'PROD018',
    name: 'Tri-Blend T-Shirt - Duck Brown',
    sku: 'TL1763H-DUCKBROWN',
    category: 'apparel',
    description: 'Tri-blend duck brown t-shirt with custom logo',
    imageFile: 'TLJ763H_Duck Brown_Flat_Front-01_right_chest.png',
    pricing: [
      { minQty: 1, maxQty: 49, price: 34.99 },
      { minQty: 50, maxQty: 249, price: 31.99 },
      { minQty: 250, maxQty: 999, price: 27.99 },
      { minQty: 1000, maxQty: null, price: 24.99 }
    ]
  },
  {
    id: 'PROD019',
    name: 'Grey Steel T-Shirt - Orange Logo',
    sku: 'C112-GREYSTEEL',
    category: 'apparel',
    description: 'Grey steel t-shirt with neon orange custom logo',
    imageFile: 'C112_greysteelneonorange_full_front-01_right_chest.png',
    pricing: [
      { minQty: 1, maxQty: 49, price: 28.99 },
      { minQty: 50, maxQty: 249, price: 25.99 },
      { minQty: 250, maxQty: 999, price: 22.99 },
      { minQty: 1000, maxQty: null, price: 19.99 }
    ]
  },
  {
    id: 'PROD020',
    name: 'Classic Polo - Black',
    sku: 'C932-BLACK',
    category: 'apparel',
    description: 'Classic black polo shirt with embroidered logo',
    imageFile: 'C932_Black_Flat_Front-01_right_chest.png',
    pricing: [
      { minQty: 1, maxQty: 19, price: 39.99 },
      { minQty: 20, maxQty: 99, price: 35.99 },
      { minQty: 100, maxQty: 499, price: 31.99 },
      { minQty: 500, maxQty: null, price: 27.99 }
    ]
  }
];

/* ---------------------------------
   Helpers
   --------------------------------- */
function emailToS3Folder(email) {
  return (email || '').toLowerCase().replace(/@/g, '_at_').replace(/\./g, '_dot_');
}

function getProductImageUrl(product, customerEmail) {
  const emailFolder = emailToS3Folder(customerEmail || 'default@example.com');
  const encodedFile = encodeURIComponent(product.imageFile);
  const baseUrl = CONFIG.AWS_BUCKET_URL.replace(/\/$/, '');
  return `${baseUrl}/${emailFolder}/mockups/${encodedFile}`;
}

function calculatePrice(product, quantity) {
  const q = Math.max(1, parseInt(quantity, 10) || 1);
  const tier = product.pricing.find(
    (p) => q >= p.minQty && (p.maxQty === null || q <= p.maxQty)
  );
  return tier ? tier.price : product.pricing[0].price;
}

function getPricingTable(product) {
  return product.pricing.map((t) => ({
    quantity_range: t.maxQty ? `${t.minQty}-${t.maxQty}` : `${t.minQty}+`,
    price_per_unit: `$${Number(t.price).toFixed(2)}`
  }));
}

function normalizeAddress(addr = {}) {
  return {
    line1: addr.line1 || '',
    line2: addr.line2 || undefined,
    city: addr.city || '',
    state: addr.state || '',
    postal_code: addr.postal_code || addr.zip || '',
    country: (addr.country || 'US').toUpperCase()
  };
}

/** Resolve active product list (Airtable preferred, fallback local) */
async function getActiveProducts() {
  try {
    return await fetchProductsFromAirtableCached();
  } catch (err) {
    console.warn('⚠️ Airtable fetch failed, using local PRODUCTS:', err.message);
    return PRODUCTS;
  }
}

/** Build shipping options per session (taxed) */
function shippingOptionsFor(subtotalCents, shippingAddress) {
  const isUS = (shippingAddress?.country || 'US').toUpperCase() === 'US';
  const options = [];
  if (isUS) {
    const standardAmount = subtotalCents < 10000 ? 1000 : 0; // <$100 => $10, else free
    options.push({
      shipping_rate_data: {
        display_name: standardAmount === 0 ? 'Standard (Free over $100)' : 'Standard',
        type: 'fixed_amount',
        fixed_amount: { amount: standardAmount, currency: 'usd' },
        tax_behavior: 'exclusive',
        delivery_estimate: {
          minimum: { unit: 'business_day', value: 5 },
          maximum: { unit: 'business_day', value: 8 }
        }
      }
    });
    options.push({
      shipping_rate_data: {
        display_name: 'Express',
        type: 'fixed_amount',
        fixed_amount: { amount: 2500, currency: 'usd' },
        tax_behavior: 'exclusive',
        delivery_estimate: {
          minimum: { unit: 'business_day', value: 2 },
          maximum: { unit: 'business_day', value: 3 }
        }
      }
    });
  } else {
    options.push({
      shipping_rate_data: {
        display_name: 'Standard (Intl.)',
        type: 'fixed_amount',
        fixed_amount: { amount: 2500, currency: 'usd' },
        tax_behavior: 'exclusive'
      }
    });
    options.push({
      shipping_rate_data: {
        display_name: 'Express (Intl.)',
        type: 'fixed_amount',
        fixed_amount: { amount: 5000, currency: 'usd' },
        tax_behavior: 'exclusive'
      }
    });
  }
  return options;
}

/* ---------------------------------
   Express
   --------------------------------- */
app.use(express.json());
app.use(express.static('public'));

/* Products (Airtable preferred; returns array for your UI) */
app.get('/api/products', async (req, res) => {
  const { customerEmail } = req.query || {};
  let products;
  let fromAirtable = true;

  try {
    products = await fetchProductsFromAirtableCached();
  } catch (err) {
    fromAirtable = false;
    products = PRODUCTS;
  }

  const enriched = products.map(p => {
    const baseImageUrl = `${CONFIG.PUBLIC_BASE_URL}/images/products/${encodeURIComponent(p.imageFile)}`;
    const previewImageUrl = customerEmail
      ? `${CONFIG.AWS_BUCKET_URL}/${emailToS3Folder(customerEmail)}/mockups/${encodeURIComponent(p.imageFile)}`
      : null;

    const pricing = p.pricing || [];
    const pricingTable = pricing.map(t => ({
      quantity_range: t.maxQty ? `${t.minQty}-${t.maxQty}` : `${t.minQty}+`,
      price_per_unit: `$${Number(t.price || 0).toFixed(2)}`
    }));

    return {
      ...p,
      baseImageUrl,
      previewImageUrl,
      pricingTable,
      currentPrice: Number(pricing?.[0]?.price || 0)
    };
  });

  // Return a plain array to match your front-end expectations
  res.json(enriched);
});

/* Price calculation per quantity (uses Airtable data first) */
app.post('/api/calculate-price', async (req, res) => {
  const { productId, quantity } = req.body || {};
  if (!productId) return res.status(400).json({ error: 'productId required' });

  const list = await getActiveProducts();
  const product = list.find(p => p.id === productId);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  const qty = Math.max(1, parseInt(quantity, 10) || 1);
  const unitPrice = calculatePrice(product, qty);
  const totalPrice = unitPrice * qty;
  const basePrice = product.pricing?.[0]?.price || unitPrice;
  const savings = qty > 1 ? (basePrice - unitPrice) * qty : 0;

  res.json({
    productId,
    quantity: qty,
    unitPrice,
    totalPrice,
    savings: Number(savings.toFixed(2)),
    pricingTier: product.pricing.find((p) => qty >= p.minQty && (p.maxQty === null || qty <= p.maxQty))
  });
});

/* Tax calculation endpoint */
app.post('/api/calculate-tax', async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: 'Missing STRIPE_SECRET_KEY' });
    }

    const { zip, items } = req.body || {};
    if (!zip || !Array.isArray(items) || !items.length) {
      return res.json({ taxAmount: 0 });
    }

    const line_items = items.map((item) => ({
      amount: Math.round(Number(item.unitPrice || 0) * 100), // client-sent unitPrice
      quantity: item.quantity,
      reference: item.productId
    }));

    const calculation = await stripe.tax.calculations.create({
      currency: 'usd',
      line_items,
      customer_details: {
        address: { postal_code: zip, country: 'US' },
        address_source: 'shipping'
      }
    });

    const taxAmount = calculation.tax_amount_exclusive / 100;
    res.json({ taxAmount: Number(taxAmount.toFixed(2)), taxBreakdown: calculation.tax_breakdown });
  } catch (err) {
    console.error('Tax calculation error:', err);
    res.status(500).json({ error: 'Failed to calculate tax', taxAmount: 0 });
  }
});

/* Stripe Checkout with Stripe Tax + shipping */
app.post('/api/create-checkout', async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: 'Missing STRIPE_SECRET_KEY in .env' });
    }

    const { customerInfo, products: cart } = req.body || {};
    if (!Array.isArray(cart) || !cart.length) {
      return res.status(400).json({ error: 'Cart is empty' });
    }

    const safeCustomerInfo = customerInfo || { name: '', email: '', company: '', phone: '' };
    const activeProducts = await getActiveProducts();

    const line_items = cart.map((item) => {
      const p = activeProducts.find((x) => x.id === item.productId);
      if (!p) throw new Error(`Unknown product ${item.productId}`);
      const qty = Math.max(1, parseInt(item.quantity, 10) || 1);
      const unit = calculatePrice(p, qty);
      const img = getProductImageUrl(p, safeCustomerInfo.email || 'default@example.com');

      return {
        price_data: {
          currency: 'usd',
          unit_amount: Math.round(unit * 100),
          tax_behavior: 'exclusive',
          product_data: { name: p.name, description: p.description, images: [img] }
        },
        quantity: qty
      };
    });

    const subtotalCents = cart.reduce((sum, item) => {
      const p = activeProducts.find(ap => ap.id === item.productId);
      if (!p) return sum;
      const qty = Math.max(1, parseInt(item.quantity, 10) || 1);
      const unit = calculatePrice(p, qty);
      return sum + Math.round(unit * 100) * qty;
    }, 0);

    const shipping_options = shippingOptionsFor(subtotalCents, { country: 'US' });

    const sessionConfig = {
      mode: 'payment',
      billing_address_collection: 'required',
      shipping_address_collection: { allowed_countries: CONFIG.ALLOWED_SHIP_COUNTRIES },
      phone_number_collection: { enabled: true },
      customer_email: safeCustomerInfo.email || undefined,
      shipping_options,
      automatic_tax: { enabled: true },
      line_items,
      allow_promotion_codes: true,
      success_url: `${CONFIG.PUBLIC_BASE_URL}/?success=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${CONFIG.PUBLIC_BASE_URL}/?canceled=1`
    };

    const session = await stripe.checkout.sessions.create(sessionConfig);
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe create-checkout error:', err);
    res.status(500).json({ error: 'Failed to create payment link', details: err.message });
  }
});

/* Health */
app.get('/health', (_req, res) => res.json({ ok: true }));

/* Start */
app.listen(CONFIG.PORT, () => {
  console.log(`Server running on port ${CONFIG.PORT}`);
  console.log(`Open ${CONFIG.PUBLIC_BASE_URL}`);
});
