// server.js
require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch'); // Node 18+ has global fetch; this keeps it explicit
const sharp = require('sharp');
const Airtable = require('airtable');

const app = express();

// ---- Stripe (optional) ----
let stripe = null;
if (process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY.trim() !== '') {
  console.log('STRIPE_SECRET_KEY:', process.env.STRIPE_SECRET_KEY);
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
} else {
  console.warn('⚠️  STRIPE_SECRET_KEY not found or empty. Stripe features will be disabled.');
}

// ---- Config ----
const CONFIG = {
  PORT: process.env.PORT || 3000,
  PUBLIC_BASE_URL: (process.env.PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/$/, ''),
  AWS_BUCKET_URL: (process.env.AWS_BUCKET_URL || '').replace(/\/$/, ''),
  ALLOWED_SHIP_COUNTRIES: (process.env.ALLOWED_SHIP_COUNTRIES || 'US,CA')
    .split(',')
    .map(s => s.trim().toUpperCase())
};

// ---- S3 helper ----
const { uploadBuffer, urlForKey, s3Ready } = require('./s3');

// ---- Airtable ----
const AIRTABLE = {
  apiKey: process.env.AIRTABLE_API_KEY || '',
  baseId: process.env.AIRTABLE_BASE_ID || '',
  table: process.env.AIRTABLE_TABLE_NAME || 'Products',
};
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
    pricing: pricing,
    boxes: boxesObj.boxes || [],
  };
}
let _airtableCache = { products: null, expiresAt: 0 };
async function fetchProductsFromAirtableRaw() {
  if (!AIRTABLE.apiKey || !AIRTABLE.baseId) {
    throw new Error('Missing Airtable credentials');
  }
  const base = new Airtable({ apiKey: AIRTABLE.apiKey }).base(AIRTABLE.baseId);

  const rows = [];
  await base(AIRTABLE.table).select({}).eachPage((records, next) => {
    for (const r of records) rows.push(mapAirtableRecordToProduct(r));
    next();
  });

  const cleaned = rows.filter(r => r.id && r.imageFile && Array.isArray(r.pricing));
  if (!cleaned.length) throw new Error('No valid products in Airtable');
  return cleaned;
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
async function pushMockupUrlToAirtable(productId, mockupUrl) {
  if (!AIRTABLE.apiKey || !AIRTABLE.baseId) return { ok: false, reason: 'airtable-disabled' };

  const base = new Airtable({ apiKey: AIRTABLE.apiKey }).base(AIRTABLE.baseId);
  const table = base(AIRTABLE.table);
  const results = await table
    .select({ filterByFormula: `{product_id}="${productId}"`, maxRecords: 1 })
    .firstPage();

  if (!results || !results.length) return { ok: false, reason: 'no-row' };

  const recId = results[0].id;
  await table.update(recId, { mockup_url: mockupUrl });
  return { ok: true };
}

// ---- Local fallback catalog (kept from your earlier message) ----
const PRODUCTS = [
  { id: 'PROD001', name: 'Premium T-Shirt - Black', sku: 'TSHIRT-18500-BLACK', category: 'apparel',
    description: 'Premium cotton t-shirt with custom logo',
    imageFile: '18500_Black_Flat_Front-01_big_back.png',
    pricing: [{minQty:1,maxQty:9,price:29.99},{minQty:10,maxQty:49,price:26.99},{minQty:50,maxQty:99,price:23.99},{minQty:100,maxQty:null,price:19.99}] },
  { id: 'PROD002', name: 'Premium T-Shirt - Dark Chocolate', sku: 'TSHIRT-18500-CHOC', category: 'apparel',
    description: 'Premium cotton t-shirt in dark chocolate with custom logo',
    imageFile: '18500_Dark Chocolate_Flat_Front-01_big_back.png',
    pricing: [{minQty:1,maxQty:9,price:29.99},{minQty:10,maxQty:49,price:26.99},{minQty:50,maxQty:99,price:23.99},{minQty:100,maxQty:null,price:19.99}] },
  { id: 'PROD003', name: 'Classic T-Shirt - Black', sku: 'TSHIRT-2000-BLACK', category: 'apparel',
    description: 'Classic fit t-shirt with custom logo',
    imageFile: '2000_black_flat_front-01_right_chest.png',
    pricing: [{minQty:1,maxQty:19,price:24.99},{minQty:20,maxQty:99,price:21.99},{minQty:100,maxQty:499,price:18.99},{minQty:500,maxQty:null,price:15.99}] },
  { id: 'PROD004', name: 'Classic T-Shirt - Charcoal', sku: 'TSHIRT-2000-CHARCOAL', category: 'apparel',
    description: 'Classic fit charcoal t-shirt with custom logo',
    imageFile: '2000_charcoal_flat_front-01_right_chest.png',
    pricing: [{minQty:1,maxQty:19,price:24.99},{minQty:20,maxQty:99,price:21.99},{minQty:100,maxQty:499,price:18.99},{minQty:500,maxQty:null,price:15.99}] },
  { id: 'PROD005', name: 'Heavy Cotton T-Shirt - Black', sku: 'TSHIRT-5400-BLACK', category: 'apparel',
    description: 'Heavy cotton t-shirt with custom logo',
    imageFile: '5400_black_flat_front-01_right_chest.png',
    pricing: [{minQty:1,maxQty:24,price:19.99},{minQty:25,maxQty:99,price:17.99},{minQty:100,maxQty:999,price:14.99},{minQty:1000,maxQty:null,price:12.99}] },
  { id: 'PROD006', name: 'Canvas T-Shirt - Duck Brown', sku: 'CSV40-DUCKBROWN', category: 'apparel',
    description: 'Canvas v-neck t-shirt in duck brown with custom logo',
    imageFile: 'CSV40_duckbrown_flat_front-01_right_chest.png',
    pricing: [{minQty:1,maxQty:49,price:22.99},{minQty:50,maxQty:249,price:19.99},{minQty:250,maxQty:999,price:16.99},{minQty:1000,maxQty:null,price:14.99}] },
  { id: 'PROD007', name: 'Safety T-Shirt - Yellow', sku: 'CSV106-SAFETY', category: 'apparel',
    description: 'High visibility safety yellow t-shirt with custom logo',
    imageFile: 'CSV106_safetyyellow_flat_front_right_chest.png',
    pricing: [{minQty:1,maxQty:49,price:18.99},{minQty:50,maxQty:249,price:16.99},{minQty:250,maxQty:999,price:14.99},{minQty:1000,maxQty:null,price:12.99}] },
  { id: 'PROD008', name: 'Casual T-Shirt - Black', sku: 'CT104050-BLACK', category: 'apparel',
    description: 'Casual black t-shirt with custom logo',
    imageFile: 'CT104050_black_flat_front-01_right_chest.png',
    pricing: [{minQty:1,maxQty:49,price:26.99},{minQty:50,maxQty:249,price:23.99},{minQty:250,maxQty:999,price:20.99},{minQty:1000,maxQty:null,price:17.99}] },
  { id: 'PROD009', name: 'Casual T-Shirt - Carhartt Brown', sku: 'CT104050-BROWN', category: 'apparel',
    description: 'Casual Carhartt brown t-shirt with custom logo',
    imageFile: 'CT104050_carharttbrown_flat_front-01_right_chest.png',
    pricing: [{minQty:1,maxQty:49,price:26.99},{minQty:50,maxQty:249,price:23.99},{minQty:250,maxQty:999,price:20.99},{minQty:1000,maxQty:null,price:17.99}] },
  { id: 'PROD010', name: 'Fashion T-Shirt - Black', sku: 'F170-BLACK', category: 'apparel',
    description: 'Fashion fit black t-shirt with custom logo',
    imageFile: 'F170_Black_flat_front-01_big_back.png',
    pricing: [{minQty:1,maxQty:49,price:21.99},{minQty:50,maxQty:249,price:19.99},{minQty:250,maxQty:999,price:16.99},{minQty:1000,maxQty:null,price:14.99}] },
  { id: 'PROD011', name: 'Heavy Blend T-Shirt - Black', sku: 'G2400-BLACK', category: 'apparel',
    description: 'Heavy blend black t-shirt with custom logo',
    imageFile: 'G2400_black_flat_front-01_big_back.png',
    pricing: [{minQty:1,maxQty:49,price:23.99},{minQty:50,maxQty:249,price:20.99},{minQty:250,maxQty:999,price:17.99},{minQty:1000,maxQty:null,price:15.99}] },
  { id: 'PROD012', name: 'Heavy Blend T-Shirt - Charcoal', sku: 'G2400-CHARCOAL', category: 'apparel',
    description: 'Heavy blend charcoal t-shirt with custom logo',
    imageFile: 'G2400_charcoal_flat_front-01_big_back.png',
    pricing: [{minQty:1,maxQty:49,price:23.99},{minQty:50,maxQty:249,price:20.99},{minQty:250,maxQty:999,price:17.99},{minQty:1000,maxQty:null,price:15.99}] },
  { id: 'PROD013', name: 'Heavy Blend T-Shirt - Dark Chocolate', sku: 'G2400-DARKCHOC', category: 'apparel',
    description: 'Heavy blend dark chocolate t-shirt with custom logo',
    imageFile: 'G2400_darkchocolate_flat_front-01_big_back.png',
    pricing: [{minQty:1,maxQty:49,price:23.99},{minQty:50,maxQty:249,price:20.99},{minQty:250,maxQty:999,price:17.99},{minQty:1000,maxQty:null,price:15.99}] },
  { id: 'PROD014', name: 'Lightweight T-Shirt - Black', sku: 'K540-BLACK', category: 'apparel',
    description: 'Lightweight black t-shirt with custom logo',
    imageFile: 'K540_Black_Flat_Front-01_right_chest.png',
    pricing: [{minQty:1,maxQty:49,price:27.99},{minQty:50,maxQty:249,price:24.99},{minQty:250,maxQty:999,price:21.99},{minQty:1000,maxQty:null,price:18.99}] },
  { id: 'PROD015', name: 'Nike Dri-FIT T-Shirt - Black', sku: 'NKCY9963-BLACK', category: 'apparel',
    description: 'Nike Dri-FIT performance t-shirt with custom logo',
    imageFile: 'NKDC1963_Black_Flat_Front-01_right_chest.png',
    pricing: [{minQty:1,maxQty:24,price:44.99},{minQty:25,maxQty:99,price:40.99},{minQty:100,maxQty:499,price:36.99},{minQty:500,maxQty:null,price:32.99}] },
  { id: 'PROD016', name: 'Performance T-Shirt - Black', sku: 'PC78SP-BLACK', category: 'apparel',
    description: 'Performance jet black t-shirt with custom logo',
    imageFile: 'PC78SP_JET BLACK_Flat_Front-01_right_chest.png',
    pricing: [{minQty:1,maxQty:49,price:31.99},{minQty:50,maxQty:249,price:28.99},{minQty:250,maxQty:999,price:25.99},{minQty:1000,maxQty:null,price:22.99}] },
  { id: 'PROD017', name: 'Tri-Blend T-Shirt - Black', sku: 'TL1763H-BLACK', category: 'apparel',
    description: 'Tri-blend black t-shirt with custom logo',
    imageFile: 'TLJ763H_Black_Flat_Front-01_right_chest.png',
    pricing: [{minQty:1,maxQty:49,price:34.99},{minQty:50,maxQty:249,price:31.99},{minQty:250,maxQty:999,price:27.99},{minQty:1000,maxQty:null,price:24.99}] },
  { id: 'PROD018', name: 'Tri-Blend T-Shirt - Duck Brown', sku: 'TL1763H-DUCKBROWN', category: 'apparel',
    description: 'Tri-blend duck brown t-shirt with custom logo',
    imageFile: 'TLJ763H_Duck Brown_Flat_Front-01_right_chest.png',
    pricing: [{minQty:1,maxQty:49,price:34.99},{minQty:50,maxQty:249,price:31.99},{minQty:250,maxQty:999,price:27.99},{minQty:1000,maxQty:null,price:24.99}] },
  { id: 'PROD019', name: 'Grey Steel T-Shirt - Orange Logo', sku: 'C112-GREYSTEEL', category: 'apparel',
    description: 'Grey steel t-shirt with neon orange custom logo',
    imageFile: 'C112_greysteelneonorange_full_front-01_right_chest.png',
    pricing: [{minQty:1,maxQty:49,price:28.99},{minQty:50,maxQty:249,price:25.99},{minQty:250,maxQty:999,price:22.99},{minQty:1000,maxQty:null,price:19.99}] },
  { id: 'PROD020', name: 'Classic Polo - Black', sku: 'C932-BLACK', category: 'apparel',
    description: 'Classic black polo shirt with embroidered logo',
    imageFile: 'C932_Black_Flat_Front-01_right_chest.png',
    pricing: [{minQty:1,maxQty:19,price:39.99},{minQty:20,maxQty:99,price:35.99},{minQty:100,maxQty:499,price:31.99},{minQty:500,maxQty:null,price:27.99}] },
];

// ---- Helpers ----
function emailToS3Folder(email) {
  return (email || '').toLowerCase().replace(/@/g, '_at_').replace(/\./g, '_dot_');
}
function calculatePrice(product, quantity) {
  const q = Math.max(1, parseInt(quantity, 10) || 1);
  const tier = product.pricing.find(
    (p) => q >= p.minQty && (p.maxQty === null || q <= p.maxQty)
  );
  return tier ? tier.price : product.pricing[0].price;
}

// ---- Express ----
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Admin: force Airtable reload
app.post('/api/admin/reload-products', async (_req, res) => {
  try {
    const fresh = await fetchProductsFromAirtableRaw();
    _airtableCache = { products: fresh, expiresAt: Date.now() + 5 * 60 * 1000 };
    res.json({ ok: true, count: fresh.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Products API (Airtable → fallback) with mockup/base URLs
app.get('/api/products', async (req, res) => {
  const { customerEmail } = req.query || {};
  let source = 'airtable';
  let products;
  try {
    products = await fetchProductsFromAirtableCached();
  } catch (err) {
    console.warn('⚠️ Airtable fetch failed, falling back to local PRODUCTS:', err.message);
    source = 'local';
    products = (PRODUCTS || []).map(p => ({ ...p, boxes: p.boxes || [] }));
  }

  const enriched = products.map(p => {
    const baseImageUrl = `${CONFIG.PUBLIC_BASE_URL}/images/products/${encodeURIComponent(p.imageFile)}`;
    const previewImageUrl = customerEmail
      ? `${CONFIG.AWS_BUCKET_URL}/${emailToS3Folder(customerEmail)}/mockups/${encodeURIComponent(p.imageFile)}`
      : null;
    const pricingTable = (p.pricing || []).map(t => ({
      quantity_range: t.maxQty ? `${t.minQty}-${t.maxQty}` : `${t.minQty}+`,
      price_per_unit: `$${Number(t.price || 0).toFixed(2)}`
    }));
    return { ...p, baseImageUrl, previewImageUrl, pricingTable, currentPrice: Number(p.pricing?.[0]?.price || 0) };
  });

  res.json({ source, products: enriched });
});

// ---- Mockup generation + S3 upload + Airtable push ----
async function downloadToBuffer(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download failed: ${r.status} ${url}`);
  return Buffer.from(await r.arrayBuffer());
}
function resolveBaseImageOnDisk(imageFile) {
  const p = path.join(__dirname, 'public', 'images', 'products', imageFile);
  if (!fs.existsSync(p)) return null;
  return p;
}
/**
 * Simple compositor: puts logo on the first box in product.boxes,
 * or centers it at 30% width if no boxes provided.
 */
async function composeMockup(basePath, logoBuf, product) {
  const base = sharp(basePath);
  const meta = await base.metadata();

  let x, y, w, h;
  if (Array.isArray(product.boxes) && product.boxes.length) {
    const b = product.boxes[0];
    // boxes are normalized 0..1? If your boxes are in px, adjust here:
    const nx1 = (b.x1 ?? b.left ?? 0.35), ny1 = (b.y1 ?? b.top ?? 0.25);
    const nx2 = (b.x2 ?? b.right ?? 0.65), ny2 = (b.y2 ?? b.bottom ?? 0.45);
    w = Math.round((nx2 - nx1) * meta.width);
    h = Math.round((ny2 - ny1) * meta.height);
    x = Math.round(nx1 * meta.width);
    y = Math.round(ny1 * meta.height);
  } else {
    // default: center block
    w = Math.round(meta.width * 0.30);
    h = Math.round(w * 0.6);
    x = Math.round((meta.width - w) / 2);
    y = Math.round(meta.height * 0.30);
  }

  const logoResized = await sharp(logoBuf).resize({ width: w, height: h, fit: 'inside' }).png().toBuffer();

  const out = await base
    .composite([{ input: logoResized, left: x, top: y }])
    .png()
    .toBuffer();

  return out;
}

/**
 * POST /api/products/:productId/mockup
 * body: { email, logoUrl }
 * Generates mockup, uploads to S3 (if configured), pushes URL to Airtable.
 */
app.post('/api/products/:productId/mockup', async (req, res) => {
  try {
    const { productId } = req.params;
    const { email, logoUrl } = req.body || {};
    if (!productId || !logoUrl) return res.status(400).json({ error: 'Missing productId or logoUrl' });

    // Get product (Airtable first)
    let prods;
    try { prods = await fetchProductsFromAirtableCached(); }
    catch { prods = PRODUCTS; }

    const product = (prods || []).find(p => p.id === productId);
    if (!product) return res.status(404).json({ error: 'Product not found' });

    const basePath = resolveBaseImageOnDisk(product.imageFile);
    if (!basePath) {
      return res.status(404).json({ error: `Base image not found on server: ${product.imageFile}` });
    }

    const logoBuf = await downloadToBuffer(logoUrl);
    const mockupBuf = await composeMockup(basePath, logoBuf, product);

    const fileName = product.imageFile; // save with same name for easy preview fallback
    const key = `${emailToS3Folder(email || 'default@example.com')}/mockups/${fileName}`;

    let publicUrl = null;
    if (s3Ready()) {
      await uploadBuffer(key, mockupBuf, 'image/png');
      publicUrl = urlForKey(key);
    }

    if (publicUrl) {
      // best-effort: write back to Airtable
      try { await pushMockupUrlToAirtable(productId, publicUrl); } catch (_) {}
    }

    res.json({
      ok: true,
      uploaded: !!publicUrl,
      url: publicUrl || null,
      key
    });
  } catch (err) {
    console.error('mockup error:', err);
    res.status(500).json({ error: 'mockup-failed', detail: err.message });
  }
});

// Health
app.get('/health', (_req, res) => res.json({ ok: true }));

// Start
app.listen(CONFIG.PORT, () => {
  console.log(`Server running on port ${CONFIG.PORT}`);
  console.log(`Open ${CONFIG.PUBLIC_BASE_URL}`);
});
