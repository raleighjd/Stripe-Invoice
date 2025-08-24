// server.js
require('dotenv').config();
console.log('STRIPE_SECRET_KEY:', process.env.STRIPE_SECRET_KEY);

const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { uploadFileToS3 } = require('./s3'); // Node S3 uploader (used for base placeholder upload)
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
};

// Import AWS SDK for S3 operations
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
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

/* Products (Airtable preferred; returns array for your UI) */
app.get('/api/products', async (req, res) => {
  const { customerEmail } = req.query || {};
  let products;
  try { products = await fetchProductsFromAirtableCached(); }
  catch { products = PRODUCTS; }

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

    return { ...p, baseImageUrl, previewImageUrl, pricingTable, currentPrice: Number(pricing?.[0]?.price || 0) };
  });

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

    const { customerInfo, products: cart } = req.body || {};
    if (!Array.isArray(cart) || !cart.length) return res.status(400).json({ error: 'Cart is empty' });

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
    const recordId = await airtableFindRecordIdByProductId(productId);
    if (!recordId) return res.status(404).json({ error: 'Airtable record not found for product_id' });

    await airtableUpdateFields(recordId, { boxes: JSON.stringify({ boxes }) });
    res.json({ ok: true });
  } catch (e) {
    console.error('boxes save error:', e.message);
    res.status(500).json({ error: e.message });
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

    // Return the most recent logo file
    const logoFile = logoFiles[0];
    const logoUrl = `${CONFIG.AWS_BUCKET_URL}/${logoFile.Key}`;

    res.json({
      hasLogo: true,
      logoUrl: logoUrl,
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
    const { email, logoUrl } = req.body || {};
    if (!email || !logoUrl) return res.status(400).json({ error: 'email and logoUrl required' });

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
    const py = spawn('python3', args);
    py.stdout.on('data', (d) => { pyStdout += d.toString(); });
    py.stderr.on('data', (d) => { pyStderr += d.toString(); });
    py.on('close', async (code) => {
      if (code !== 0) {
        console.error('mockup stderr:', pyStderr);
        return res.status(500).json({ error: `mockup generation failed (${code})` });
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

      if (recId) {
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
