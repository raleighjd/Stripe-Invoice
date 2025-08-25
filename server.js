// server.js
require('dotenv').config();

const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { uploadFileToS3 } = require('./s3'); // Node S3 uploader (used for base placeholder upload)
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const sharp = require('sharp');
const app = express();

// Configuration object - must be defined before S3Client
const CONFIG = {
  AWS_BUCKET_URL: process.env.AWS_BUCKET_URL || 'https://leadprocessor.s3.us-east-2.amazonaws.com',
  AWS_REGION: process.env.AWS_REGION || 'us-east-2',
  AWS_BUCKET_NAME: process.env.AWS_BUCKET_NAME || 'leadprocessor',
  PORT: process.env.PORT || 3000,
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || 'http://localhost:3000',
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || '',
  ALLOWED_SHIP_COUNTRIES: (process.env.ALLOWED_SHIP_COUNTRIES || 'US,CA')
    .split(',')
    .map(s => s.trim().toUpperCase())
  ,
  AIRTABLE_ENABLE_MOCKUP_FIELDS: String(process.env.AIRTABLE_ENABLE_MOCKUP_FIELDS || '').toLowerCase() === 'true'
};

// Import AWS SDK for S3 operations
const { S3Client, ListObjectsV2Command, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const s3Client = new S3Client({
  region: CONFIG.AWS_REGION,
  credentials: process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
    ? {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      }
    : undefined,
});

// Initialize Stripe only if we have a valid API key
let stripe = null;
if (process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY.trim() !== '') {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
} else {
  console.warn('⚠️  STRIPE_SECRET_KEY not found or empty. Stripe features will be disabled.');
}

// ---- Airtable loader with PAT (cached) ----
const AIRTABLE = {
  token: process.env.AIRTABLE_PAT,             // Personal Access Token (pat_…)
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

async function airtableFindRecordIdByProductId(productId) {
  const url = `https://api.airtable.com/v0/${AIRTABLE.baseId}/${encodeURIComponent(AIRTABLE.table)}`;
  const params = { filterByFormula: `{product_id}="${productId}"`, maxRecords: 1 };
  const { data } = await axios.get(url, {
    params,
    headers: { Authorization: `Bearer ${AIRTABLE.token}` },
  });
  const rec = (data.records || [])[0];
  return rec?.id || null;
}

async function airtableFindRecordIdByImageFile(imageFile) {
  const url = `https://api.airtable.com/v0/${AIRTABLE.baseId}/${encodeURIComponent(AIRTABLE.table)}`;
  // 1) Try exact match
  {
    const params = { filterByFormula: `{image_file}="${imageFile}"`, maxRecords: 1 };
    const { data } = await axios.get(url, { params, headers: { Authorization: `Bearer ${AIRTABLE.token}` } });
    const rec = (data.records || [])[0];
    if (rec?.id) return rec.id;
  }
  // 2) Try base stem match using FIND
  const stem = String(imageFile).replace(/\.png$/i, '').replace(/\.jpg$/i, '').replace(/\.jpeg$/i, '');
  const findFormula = `FIND("${stem}",{image_file})>0`;
  const { data } = await axios.get(url, {
    params: { filterByFormula: findFormula, maxRecords: 1 },
    headers: { Authorization: `Bearer ${AIRTABLE.token}` },
  });
  const rec = (data.records || [])[0];
  return rec?.id || null;
}

async function airtableUpdateFields(recordId, fields) {
  const url = `https://api.airtable.com/v0/${AIRTABLE.baseId}/${encodeURIComponent(AIRTABLE.table)}/${recordId}`;
  const payload = { fields };
  const { data } = await axios.patch(url, payload, {
    headers: {
      Authorization: `Bearer ${AIRTABLE.token}`,
      'Content-Type': 'application/json'
    }
  });
  return data;
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
  // ... keep all your existing products through PROD020 ...
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

function chooseDefaultLogoForEmail(email, s3Objects) {
  const domain = String((email || '').split('@')[1] || '').toLowerCase();
  const domainBase = (domain.split('.')[0] || '').toLowerCase();
  const filenameOf = (k) => (k || '').split('/').pop().toLowerCase();

  function score(key) {
    const fn = filenameOf(key);
    let s = 0;
    if (new RegExp(`^${domainBase}(_logo)?\\.(png|jpe?g|svg)$`, 'i').test(fn)) s += 100;
    if (new RegExp(`${domainBase}.*_logo\\.(png|jpe?g|svg)$`, 'i').test(fn)) s += 60;
    if (/_logo\.(png|jpe?g|svg)$/i.test(fn)) s += 30;
    if (fn.indexOf(domainBase) >= 0) s += 10;
    return s;
  }

  let best = null, bestScore = -1;
  for (const obj of s3Objects) {
    const s = score(obj.Key || '');
    if (s > bestScore) { best = obj; bestScore = s; }
  }
  return best || s3Objects[0];
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

async function getActiveProducts() {
  try { return await fetchProductsFromAirtableCached(); }
  catch (err) { console.warn('⚠️ Airtable fetch failed, using local PRODUCTS:', err.message); return PRODUCTS; }
}

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
        delivery_estimate: { minimum: { unit: 'business_day', value: 5 }, maximum: { unit: 'business_day', value: 8 } }
      }
    });
    options.push({
      shipping_rate_data: {
        display_name: 'Express',
        type: 'fixed_amount',
        fixed_amount: { amount: 2500, currency: 'usd' },
        tax_behavior: 'exclusive',
        delivery_estimate: { minimum: { unit: 'business_day', value: 2 }, maximum: { unit: 'business_day', value: 3 } }
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
/* Upload logo via server (avoid S3 CORS) */
app.post('/api/logo/upload', upload.single('logo'), async (req, res) => {
  try {
    const email = (req.body?.email || '').trim();
    const file = req.file;
    if (!email || !file) return res.status(400).json({ error: 'email and logo file are required' });
    const emailFolder = emailToS3Folder(email);
    const fileName = file.originalname || `logo_${Date.now()}.png`;
    const key = `${emailFolder}/logo/${fileName}`;
    // Reuse node S3 client via s3.js
    const { uploadBuffer, urlForKey } = require('./s3');
    await uploadBuffer(key, file.buffer, file.mimetype || 'application/octet-stream');
    const url = urlForKey(key);
    res.json({ ok: true, key, url });
  } catch (e) {
    console.error('logo upload error:', e);
    res.status(500).json({ error: 'Failed to upload logo' });
  }
});

/* ---------------------------------
   S3 helpers: key builders and presigners
   --------------------------------- */
function companyDomainFromEmail(email) {
  const s = String(email || '').toLowerCase();
  const at = s.split('@')[1] || 'unknown.local';
  return at;
}

function s3KeyForLogo(companyDomain, logoId, filename) {
  return `company/${companyDomain}/logos/${logoId}/${filename}`;
}
function s3KeyForDesign(companyDomain, quoteId, versionId, productId) {
  return `company/${companyDomain}/quotes/${quoteId}/versions/${versionId}/designs/${productId}.json`;
}
function s3KeyForPreview(companyDomain, quoteId, versionId, productId) {
  return `company/${companyDomain}/quotes/${quoteId}/versions/${versionId}/previews/${productId}.webp`;
}
function s3KeyForVersionIndex(companyDomain, quoteId, versionId) {
  return `company/${companyDomain}/quotes/${quoteId}/versions/${versionId}/index.json`;
}

async function presignPutObject(key, contentType, expiresSec = 900) {
  const cmd = new PutObjectCommand({ Bucket: CONFIG.AWS_BUCKET_NAME, Key: key, ContentType: contentType });
  return getSignedUrl(s3Client, cmd, { expiresIn: expiresSec });
}
async function presignGetObject(key, expiresSec = 900) {
  const cmd = new GetObjectCommand({ Bucket: CONFIG.AWS_BUCKET_NAME, Key: key });
  return getSignedUrl(s3Client, cmd, { expiresIn: expiresSec });
}

/* Presign upload for logo */
app.post('/api/logo/presign', async (req, res) => {
  try {
    const { email, logoId, filename, contentType } = req.body || {};
    if (!email || !logoId || !filename || !contentType) return res.status(400).json({ error: 'email, logoId, filename, contentType required' });
    const domain = companyDomainFromEmail(email);
    const key = s3KeyForLogo(domain, logoId, filename);
    const url = await presignPutObject(key, contentType, 900);
    const publicUrl = `${CONFIG.AWS_BUCKET_URL.replace(/\/$/, '')}/${key}`;
    const getUrl = await presignGetObject(key, 900);
    res.json({ key, url, publicUrl, getUrl });
  } catch (e) {
    console.error('presign logo error:', e);
    res.status(500).json({ error: 'Failed to presign logo upload' });
  }
});

/* Products (Airtable preferred; returns array for your UI) */
app.get('/api/products', async (req, res) => {
  const { customerEmail, quoteId, versionId } = req.query || {};
  let products;
  try { products = await fetchProductsFromAirtableCached(); }
  catch { products = PRODUCTS; }

  const enriched = products.map(p => {
    const baseImageUrl = `${CONFIG.PUBLIC_BASE_URL}/images/products/${encodeURIComponent(p.imageFile)}`;
    let previewImageUrl = null;
    if (quoteId && versionId && customerEmail) {
      const domain = companyDomainFromEmail(customerEmail);
      const key = s3KeyForPreview(domain, quoteId, versionId, p.id);
      // Client cannot access private S3 without presign; provide a presigned URL for quick display
      // Note: this is ephemeral (5 minutes). Frontend should refresh as needed.
      previewImageUrl = null; // default; will be filled by presign below
    } else if (customerEmail) {
      // Legacy email-based preview location; will presign below to support private buckets
      previewImageUrl = null;
    }

    const pricing = p.pricing || [];
    const pricingTable = pricing.map(t => ({
      quantity_range: t.maxQty ? `${t.minQty}-${t.maxQty}` : `${t.minQty}+`,
      price_per_unit: `$${Number(t.price || 0).toFixed(2)}`
    }));

    return { ...p, baseImageUrl, previewImageUrl, pricingTable, currentPrice: Number(pricing?.[0]?.price || 0) };
  });

  // If version requested, presign previews in batch (best-effort)
  if (quoteId && versionId && customerEmail) {
    const domain = companyDomainFromEmail(customerEmail);
    await Promise.all(enriched.map(async (p) => {
      let url = null;
      try {
        const key = s3KeyForPreview(domain, quoteId, versionId, p.id);
        url = await presignGetObject(key, 300);
      } catch (_) {}
      if (!url) {
        try {
          const emailFolder = emailToS3Folder(customerEmail);
          const legacyKey = `${emailFolder}/mockups/${p.imageFile}`;
          url = await presignGetObject(legacyKey, 300);
        } catch (_) {}
      }
      if (!url) {
        // Final public URL fallback
        const emailFolder = emailToS3Folder(customerEmail);
        url = `${CONFIG.AWS_BUCKET_URL.replace(/\/$/, '')}/${emailFolder}/mockups/${encodeURIComponent(p.imageFile)}`;
      }
      p.previewImageUrl = url || p.previewImageUrl || null;
    }));
  } else if (customerEmail) {
    // Legacy email-based mockups: presign each object's URL so private buckets work
    const emailFolder = emailToS3Folder(customerEmail);
    await Promise.all(enriched.map(async (p) => {
      try {
        const key = `${emailFolder}/mockups/${p.imageFile}`;
        p.previewImageUrl = await presignGetObject(key, 300);
      } catch (_) {
        // Fallback to public URL if presign fails
        p.previewImageUrl = `${CONFIG.AWS_BUCKET_URL}/${emailFolder}/mockups/${encodeURIComponent(p.imageFile)}`;
      }
    }));
  }

  res.json(enriched); // plain array for your existing front-end
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
    if (!stripe) return res.status(500).json({ error: 'Missing STRIPE_SECRET_KEY' });

    const { zip, items } = req.body || {};
    if (!zip || !Array.isArray(items) || !items.length) return res.json({ taxAmount: 0 });

    const line_items = items.map((item) => ({
      amount: Math.round(Number(item.unitPrice || 0) * 100),
      quantity: item.quantity,
      reference: item.productId
    }));

    const calculation = await stripe.tax.calculations.create({
      currency: 'usd',
      line_items,
      customer_details: { address: { postal_code: zip, country: 'US' }, address_source: 'shipping' }
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
    if (!stripe) return res.status(500).json({ error: 'Missing STRIPE_SECRET_KEY in .env' });

    const { customerInfo, products: cart, quoteId, versionId } = req.body || {};
    if (!Array.isArray(cart) || !cart.length) return res.status(400).json({ error: 'Cart is empty' });

    const safeCustomerInfo = customerInfo || { name: '', email: '', company: '', phone: '' };
    const activeProducts = await getActiveProducts();

    const line_items = await Promise.all(cart.map(async (item) => {
      const p = activeProducts.find((x) => x.id === item.productId);
      if (!p) throw new Error(`Unknown product ${item.productId}`);
      const qty = Math.max(1, parseInt(item.quantity, 10) || 1);
      const unit = calculatePrice(p, qty);
      let img = getProductImageUrl(p, safeCustomerInfo.email || 'default@example.com');
      if (quoteId && versionId && safeCustomerInfo.email) {
        try {
          const domain = companyDomainFromEmail(safeCustomerInfo.email);
          const key = s3KeyForPreview(domain, quoteId, versionId, p.id);
          img = await presignGetObject(key, 300);
        } catch (_) {}
      }

      const productData = { name: p.name || `Item ${p.id}` };
      if (p.description && String(p.description).trim() !== '') {
        productData.description = p.description;
      }
      if (img && String(img).trim() !== '') {
        productData.images = [img];
      }
      const chosenVersion = (item && typeof item.versionId === 'string') ? item.versionId : '';
      if (chosenVersion) {
        productData.metadata = Object.assign({}, productData.metadata || {}, { design_version: chosenVersion, quote_id: quoteId || '' });
      }

      return {
        price_data: {
          currency: 'usd',
          unit_amount: Math.round(unit * 100),
          tax_behavior: 'exclusive',
          product_data: productData
        },
        quantity: qty
      };
    }));

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

    // Attach quote-level metadata, including a compact versions map
    const versionsMap = Array.isArray(cart) ? cart.reduce((acc, it) => { if (it.productId) acc[it.productId] = it.versionId || ''; return acc; }, {}) : {};
    sessionConfig.metadata = { quoteId: quoteId || '', versionId: versionId || '', versions_json: JSON.stringify(versionsMap) };
    const session = await stripe.checkout.sessions.create(sessionConfig);
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe create-checkout error:', err);
    res.status(500).json({ error: 'Failed to create payment link', details: err.message });
  }
});

/* ====== Per-product endpoints: boxes, mockup+upload (combined), upload base ====== */

// Save boxes JSON to Airtable "boxes" field for a product_id
app.post('/api/products/:id/boxes', async (req, res) => {
  try {
    if (!AIRTABLE.token) return res.status(500).json({ error: 'Airtable not configured' });
    const productId = req.params.id;
    const boxes = req.body?.boxes;
    if (!Array.isArray(boxes) || boxes.length === 0) {
      return res.status(400).json({ error: 'boxes array required' });
    }
    let recordId = await airtableFindRecordIdByProductId(productId);
    if (!recordId) {
      // Fallback: try by image_file using known product list
      try {
        const list = await getActiveProducts();
        const p = list.find(x => x.id === productId);
        if (p?.imageFile) {
          recordId = await airtableFindRecordIdByImageFile(p.imageFile);
        }
      } catch (_) {}
    }
    if (!recordId) return res.status(404).json({ error: 'Airtable record not found for product_id or image_file', productId });

    await airtableUpdateFields(recordId, { boxes: JSON.stringify({ boxes }) });
    res.json({ ok: true, recordId, productId });
  } catch (e) {
    console.error('boxes save error:', e);
    res.status(500).json({ error: String(e?.response?.data?.error || e?.message || e), details: e?.response?.data || null });
  }
});

// Bulk update boxes: [{ productId, boxes: [{name,x1,y1,x2,y2}, ...] }, ...]
app.post('/api/products/boxes/bulk', async (req, res) => {
  try {
    if (!AIRTABLE.token) return res.status(500).json({ error: 'Airtable not configured' });
    let items = null;
    // Accept either {items:[...]} or a map of imageFile -> {boxes:[...]}
    if (req.body && Array.isArray(req.body.items)) {
      items = req.body.items;
    } else if (req.body && typeof req.body === 'object') {
      const keys = Object.keys(req.body);
      const looksLikeMap = keys.every(k => req.body[k] && Array.isArray(req.body[k].boxes));
      if (looksLikeMap) {
        items = keys.map(imageFile => ({ imageFile, boxes: req.body[imageFile].boxes }));
      }
    }
    if (!items || !items.length) return res.status(400).json({ error: 'Provide items[] or an object of imageFile->{boxes:[]}' });

    const results = [];
    for (const it of items) {
      const productId = it.productId || it.id;
      const boxes = it.boxes;
      if ((!productId && !it.imageFile) || !Array.isArray(boxes) || boxes.length === 0) {
        results.push({ productId: productId || it.imageFile, ok: false, error: 'invalid item' });
        continue;
      }
      try {
        let recId = null;
        if (productId) recId = await airtableFindRecordIdByProductId(productId);
        if (!recId && it.imageFile) recId = await airtableFindRecordIdByImageFile(it.imageFile);
        if (!recId) { results.push({ productId, ok: false, error: 'record not found' }); continue; }
        await airtableUpdateFields(recId, { boxes: JSON.stringify({ boxes }) });
        results.push({ productId: productId || it.imageFile, ok: true });
      } catch (e) {
        results.push({ productId: productId || it.imageFile, ok: false, error: e.message });
      }
    }
    res.json({ ok: true, results });
  } catch (e) {
    console.error('bulk boxes error:', e);
    res.status(500).json({ error: e.message });
  }
});

/* Create or update a design manifest for a product within a version */
app.post('/api/quotes/:quoteId/versions/:versionId/designs/:productId', async (req, res) => {
  try {
    const { quoteId, versionId, productId } = req.params;
    const { email, logoRef, placement, name } = req.body || {};
    if (!email || !logoRef || !placement) return res.status(400).json({ error: 'email, logoRef, placement required' });
    const domain = companyDomainFromEmail(email);

    const indexKey = s3KeyForVersionIndex(domain, quoteId, versionId);
    const designKey = s3KeyForDesign(domain, quoteId, versionId, productId);

    const now = new Date().toISOString();
    const design = { productId, logoRef, placement, updatedAt: now };

    // Write design JSON
    const designBuf = Buffer.from(JSON.stringify(design, null, 2));
    await s3Client.send(new PutObjectCommand({ Bucket: CONFIG.AWS_BUCKET_NAME, Key: designKey, Body: designBuf, ContentType: 'application/json' }));

    // Update index (best-effort; if 404, create)
    let index = { name: name || versionId, createdAt: now, products: [], writeToken: undefined };
    try {
      const url = await presignGetObject(indexKey, 60);
      const resp = await axios.get(url, { responseType: 'json' });
      if (resp?.data) index = resp.data;
    } catch (_) {}
    const existsIdx = (index.products || []).findIndex(p => p.productId === productId);
    if (existsIdx >= 0) index.products[existsIdx] = { productId, updatedAt: now };
    else (index.products = index.products || []).push({ productId, updatedAt: now });
    const indexBuf = Buffer.from(JSON.stringify(index, null, 2));
    await s3Client.send(new PutObjectCommand({ Bucket: CONFIG.AWS_BUCKET_NAME, Key: indexKey, Body: indexBuf, ContentType: 'application/json' }));

    res.json({ ok: true, designKey, indexKey });
  } catch (e) {
    console.error('save design error:', e);
    res.status(500).json({ error: 'Failed to save design' });
  }
});

/* Get presigned preview URL for a product/version */
app.get('/api/quotes/:quoteId/versions/:versionId/previews/:productId', async (req, res) => {
  try {
    const { quoteId, versionId, productId } = req.params;
    const { email } = req.query || {};
    if (!email) return res.status(400).json({ error: 'email required' });
    const domain = companyDomainFromEmail(email);
    const key = s3KeyForPreview(domain, quoteId, versionId, productId);
    const url = await presignGetObject(key, 300);
    res.json({ key, url });
  } catch (e) {
    console.error('presign preview error:', e);
    res.status(500).json({ error: 'Failed to presign preview' });
  }
});

/* Render and upload a preview image (composite) given design manifest */
app.post('/api/quotes/:quoteId/versions/:versionId/previews/:productId/render', async (req, res) => {
  try {
    const { quoteId, versionId, productId } = req.params;
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email required' });
    const domain = companyDomainFromEmail(email);

    // Load design manifest
    const designKey = s3KeyForDesign(domain, quoteId, versionId, productId);
    const designUrl = await presignGetObject(designKey, 60);
    const { data: design } = await axios.get(designUrl, { responseType: 'json' });

    // Resolve base image path (local file in public/images/products)
    const products = await getActiveProducts();
    const p = products.find(x => x.id === productId);
    if (!p) return res.status(404).json({ error: 'Unknown product' });
    const basePath = path.join(__dirname, 'public', 'images', 'products', p.imageFile);
    if (!fs.existsSync(basePath)) return res.status(404).json({ error: 'Base image missing on server' });

    // Load logo (download to buffer)
    const logoHttpUrl = design.logoRef.startsWith('s3://')
      ? await presignGetObject(design.logoRef.replace(/^s3:\/\//, '').replace(`${CONFIG.AWS_BUCKET_NAME}/`, ''), 120)
      : design.logoRef;
    const logoResp = await axios.get(logoHttpUrl, { responseType: 'arraybuffer' });
    const logoBuffer = Buffer.from(logoResp.data);

    const placement = design.placement?.px;
    if (!placement) return res.status(400).json({ error: 'placement.px required' });
    const { x1, y1, x2, y2 } = placement;

    // Composite with sharp
    const baseImage = sharp(basePath);
    const metadata = await baseImage.metadata();
    const width = Math.max(1, Math.round(x2 - x1));
    const height = Math.max(1, Math.round(y2 - y1));
    // Resize logo to fit within box with transparent letterboxing (no black bars)
    const resizedLogo = await sharp(logoBuffer)
      .ensureAlpha() // add alpha channel if source lacks one (e.g., JPEG)
      .resize({ width, height, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png() // keep transparency in intermediate buffer
      .toBuffer();
    const compositeBuf = await sharp(basePath)
      .composite([{ input: resizedLogo, left: Math.round(x1), top: Math.round(y1), blend: 'over' }])
      .webp({ quality: 90 })
      .toBuffer();

    // Upload preview to S3 (private)
    const previewKey = s3KeyForPreview(domain, quoteId, versionId, productId);
    await s3Client.send(new PutObjectCommand({ Bucket: CONFIG.AWS_BUCKET_NAME, Key: previewKey, Body: compositeBuf, ContentType: 'image/webp' }));
    const previewUrl = await presignGetObject(previewKey, 300);

    res.json({ ok: true, previewKey, previewUrl, size: compositeBuf.length, base: { width: metadata.width, height: metadata.height } });
  } catch (e) {
    console.error('render preview error:', e);
    res.status(500).json({ error: 'Failed to render preview' });
  }
});

/* Minimal quote/version create & list (index.json only) */
app.post('/api/quotes/:quoteId/versions', async (req, res) => {
  try {
    const { quoteId } = req.params;
    const { email, versionId, name } = req.body || {};
    if (!email || !versionId) return res.status(400).json({ error: 'email and versionId required' });
    const domain = companyDomainFromEmail(email);
    const key = s3KeyForVersionIndex(domain, quoteId, versionId);
    const now = new Date().toISOString();
    const index = { name: name || versionId, createdBy: email, createdAt: now, products: [] };
    await s3Client.send(new PutObjectCommand({ Bucket: CONFIG.AWS_BUCKET_NAME, Key: key, Body: Buffer.from(JSON.stringify(index, null, 2)), ContentType: 'application/json' }));
    res.json({ ok: true, key });
  } catch (e) {
    console.error('create version error:', e);
    res.status(500).json({ error: 'Failed to create version' });
  }
});

app.get('/api/quotes/:quoteId/versions/:versionId', async (req, res) => {
  try {
    const { quoteId, versionId } = req.params;
    const { email } = req.query || {};
    if (!email) return res.status(400).json({ error: 'email required' });
    const domain = companyDomainFromEmail(email);
    const key = s3KeyForVersionIndex(domain, quoteId, versionId);
    const url = await presignGetObject(key, 60);
    const { data } = await axios.get(url, { responseType: 'json' });
    res.json({ key, index: data });
  } catch (e) {
    console.error('get version error:', e);
    res.status(500).json({ error: 'Failed to get version' });
  }
});

// List versions that have a design for a specific product
app.get('/api/quotes/:quoteId/products/:productId/versions', async (req, res) => {
  try {
    const { quoteId, productId } = req.params;
    const { email } = req.query || {};
    if (!email) return res.status(400).json({ error: 'email required' });
    const domain = companyDomainFromEmail(email);
    const prefix = `company/${domain}/quotes/${quoteId}/versions/`;
    const command = new ListObjectsV2Command({ Bucket: CONFIG.AWS_BUCKET_NAME, Prefix: prefix });
    const out = await s3Client.send(command);
    const versions = new Set();
    for (const obj of out.Contents || []) {
      const key = obj.Key || '';
      // match versions/<versionId>/designs/<productId>.json
      const parts = key.split('/');
      const idx = parts.indexOf('versions');
      if (idx >= 0 && parts[idx+2] === 'designs' && parts[idx+3] === `${productId}.json`) {
        const versionId = parts[idx+1];
        if (versionId) versions.add(versionId);
      }
    }
    res.json({ versions: Array.from(versions) });
  } catch (e) {
    console.error('list product versions error:', e);
    res.status(500).json({ error: 'Failed to list product versions' });
  }
});

/* List versions for a quote by inspecting S3 prefixes */
app.get('/api/quotes/:quoteId/versions', async (req, res) => {
  try {
    const { quoteId } = req.params;
    const { email } = req.query || {};
    if (!email) return res.status(400).json({ error: 'email required' });
    const domain = companyDomainFromEmail(email);
    const prefix = `company/${domain}/quotes/${quoteId}/versions/`;
    const command = new ListObjectsV2Command({ Bucket: CONFIG.AWS_BUCKET_NAME, Prefix: prefix, Delimiter: '/' });
    const out = await s3Client.send(command);
    const versions = (out.CommonPrefixes || [])
      .map(cp => (cp.Prefix || '').slice(prefix.length).replace(/\/$/, ''))
      .filter(v => !!v);
    res.json({ versions });
  } catch (e) {
    console.error('list versions error:', e);
    res.status(500).json({ error: 'Failed to list versions' });
  }
});

/* Find logo in S3 for customer email */
app.get('/api/customer/:email/logo', async (req, res) => {
  try {
    const email = req.params.email;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const emailFolder = emailToS3Folder(email);
    const logoPrefix = `${emailFolder}/logo/`;

    // List objects in the logo folder
    const command = new ListObjectsV2Command({
      Bucket: CONFIG.AWS_BUCKET_NAME,
      Prefix: logoPrefix,
      MaxKeys: 10
    });

    const response = await s3Client.send(command);
    const logoFiles = (response.Contents || [])
      .filter(obj => obj.Key && !obj.Key.endsWith('/')) // Exclude folder markers
      .filter(obj => {
        const filename = obj.Key.toLowerCase();
        return filename.endsWith('.png') || filename.endsWith('.jpg') || 
               filename.endsWith('.jpeg') || filename.endsWith('.svg');
      })
      .sort((a, b) => new Date(b.LastModified) - new Date(a.LastModified)); // Most recent first

    if (logoFiles.length === 0) {
      return res.status(404).json({ error: 'No logo found', hasLogo: false });
    }

    // Prefer filename-based company default: match on filename only
    const domain = String(email.split('@')[1] || '').toLowerCase();
    const domainBase = (domain.split('.')[0] || '').toLowerCase();
    const filenameOf = (k) => (k || '').split('/').pop().toLowerCase();
    // Exact: d2completion_logo.* or d2completion.*
    const exactRe = new RegExp(`^${domainBase}(_logo)?\\.(png|jpe?g|svg)$`, 'i');
    // Prefer *_logo.* containing company base
    const containsLogoRe = new RegExp(`${domainBase}.*_logo\\.(png|jpe?g|svg)$`, 'i');
    const endsWithLogoRe = /_logo\.(png|jpe?g|svg)$/i;
    const preferredExact = logoFiles.find(f => exactRe.test(filenameOf(f.Key)));
    const preferredContainsLogo = logoFiles.find(f => containsLogoRe.test(filenameOf(f.Key)));
    const preferredEndsWithLogo = logoFiles.find(f => endsWithLogoRe.test(filenameOf(f.Key)));
    const logoFile = preferredExact || preferredContainsLogo || preferredEndsWithLogo || logoFiles[0];
    let logoUrl = null;
    try { logoUrl = await presignGetObject(logoFile.Key, 300); } catch { logoUrl = `${CONFIG.AWS_BUCKET_URL}/${logoFile.Key}`; }

    res.json({
      hasLogo: true,
      logoUrl: logoUrl,
      key: logoFile.Key,
      filename: logoFile.Key.split('/').pop(),
      uploadedAt: logoFile.LastModified
    });

  } catch (error) {
    console.error('Error fetching customer logo:', error);
    res.status(500).json({ error: 'Failed to fetch logo', hasLogo: false });
  }
});

/**
 * Generate mockup for a single product:
 * - Upload base image to S3 as placeholder
 * - Run Python generator (which uploads mockups to S3)
 * - Parse JSON manifest from Python stdout
 * - Update Airtable with mockup URLs + metadata
 */
// server.js  — REPLACE the existing /api/products/:id/mockup handler with this one
app.post('/api/products/:id/mockup', async (req, res) => {
  try {
    const productId = req.params.id;
    let { email, logoUrl } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email required' });

    // If logoUrl not provided, pick a default logo for this email
    if (!logoUrl) {
      try {
        const emailFolder = emailToS3Folder(email);
        const logoPrefix = `${emailFolder}/logo/`;
        const command = new ListObjectsV2Command({ Bucket: CONFIG.AWS_BUCKET_NAME, Prefix: logoPrefix, MaxKeys: 100 });
        const response = await s3Client.send(command);
        const files = (response.Contents || [])
          .filter(o => o.Key && !o.Key.endsWith('/'))
          .filter(o => /\.(png|jpe?g|svg)$/i.test(o.Key));
        if (!files.length) throw new Error('No logo files');
        const pick = chooseDefaultLogoForEmail(email, files);
        try { logoUrl = await presignGetObject(pick.Key, 300); } catch { logoUrl = `${CONFIG.AWS_BUCKET_URL.replace(/\/$/, '')}/${pick.Key}`; }
      } catch (e) {
        return res.status(400).json({ error: 'logo not found for email', details: String(e) });
      }
    }

    // Find product (Airtable preferred, else local)
    const list = await getActiveProducts();
    const p = list.find(x => x.id === productId);
    if (!p) return res.status(404).json({ error: 'Product not found' });

    // 1) Try to upload base image as placeholder if it exists locally; otherwise fallback to public URL
    const localPath = path.join(__dirname, 'public', 'images', 'products', p.imageFile);
    const folder = emailToS3Folder(email);
    const baseKey = `${folder}/mockups/${p.imageFile}`;
    const ext = (p.imageFile.split('.').pop() || '').toLowerCase();
    const type = ext === 'png' ? 'image/png' : (ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'application/octet-stream');

    let placeholderBaseUrl = `${CONFIG.PUBLIC_BASE_URL}/images/products/${encodeURIComponent(p.imageFile)}`;
    if (fs.existsSync(localPath) && typeof uploadFileToS3 === 'function') {
      try {
        placeholderBaseUrl = await uploadFileToS3(localPath, baseKey, type, true);
      } catch (e) {
        console.warn('Placeholder upload failed, continuing with public URL fallback:', e.message);
      }
    } else {
      console.warn(`Base image not on disk (${p.imageFile}); using public URL fallback.`);
    }

    // 2) Run Python generator (it will also upload mockups and can fetch the base image if missing)
    const scriptPath = path.join(__dirname, 'python', 'build_mockups_from_airtable.py');
    const args = [
      scriptPath,
      '--email', email,
      '--logo_url', logoUrl,
      '--products_dir', path.join(__dirname, 'public', 'images', 'products'),
      '--product_id', productId
    ];
    let pyStdout = '';
    let pyStderr = '';
    const isWindows = process.platform === 'win32';
    // Prefer project venv python if available
    const venvPython = isWindows
      ? path.join(__dirname, '.venv', 'Scripts', 'python.exe')
      : path.join(__dirname, '.venv', 'bin', 'python3');
    const hasVenvPython = fs.existsSync(venvPython);
    const pythonCmd = hasVenvPython ? venvPython : (isWindows ? 'py' : 'python3');
    const pythonPrefixArgs = hasVenvPython ? [] : (isWindows ? ['-3'] : []);
    const py = spawn(pythonCmd, [...pythonPrefixArgs, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    py.stdout.on('data', (d) => { pyStdout += d.toString(); });
    py.stderr.on('data', (d) => { pyStderr += d.toString(); });
    py.on('close', async (code) => {
      if (code !== 0) {
        console.error('mockup stderr:', pyStderr);
        return res.status(500).json({ error: `mockup generation failed (${code})`, stderr: pyStderr, stdout: pyStdout });
      }

      let manifest = null;
      try { manifest = JSON.parse(pyStdout.trim()); }
      catch (e) {
        console.error('Manifest parse error:', e.message, '\nSTDOUT:', pyStdout);
        return res.status(500).json({ error: 'Invalid manifest from generator' });
      }

      // Update Airtable with URLs + metadata for this product
      const recId = await airtableFindRecordIdByProductId(productId);
      const nowIso = new Date().toISOString();
      const imageFile = p.imageFile;
      const pm = (manifest.product_map && manifest.product_map[imageFile]) || {};
      const pngUrl = (pm.png_urls && pm.png_urls[0]) || placeholderBaseUrl;
      const pdfUrl = (pm.pdf_urls && pm.pdf_urls[0]) || null;
      const previewUrl = (pm.preview_urls && pm.preview_urls[0]) || null;

      if (recId && CONFIG.AIRTABLE_ENABLE_MOCKUP_FIELDS) {
        const fields = {
          last_mockup_url: pngUrl,
          last_mockup_pdf_url: pdfUrl,
          last_mockup_preview_url: previewUrl,
          last_mockup_email: email,
          last_mockup_at: nowIso,
          last_mockup_s3_key: `${folder}/mockups/${p.imageFile}`,
          last_mockup_status: 'uploaded'
        };
        try { await airtableUpdateFields(recId, fields); }
        catch (e) { console.warn('Airtable update (mockup) warning:', e.message); }
      }

      res.json({
        ok: true,
        placeholder_base_url: placeholderBaseUrl,
        mockup: { pngUrl, pdfUrl, previewUrl },
        chosen_logo_url: logoUrl,
        manifest
      });
    });
  } catch (e) {
    console.error('mockup error:', e);
    res.status(500).json({ error: e.message });
  }
});

/* Health */
app.get('/health', (_req, res) => res.json({ ok: true }));

/* Start */
app.listen(CONFIG.PORT, () => {
  console.log(`Server running on port ${CONFIG.PORT}`);
  console.log(`Open ${CONFIG.PUBLIC_BASE_URL}`);
});
