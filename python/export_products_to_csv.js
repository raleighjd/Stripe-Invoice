// export_products_to_csv.js
// Usage: node python/export_products_to_csv.js [outputPath]
// Default output: ./products_full.csv

const fs = require('fs');
const path = require('path');

function escCSV(s) {
  if (s == null) return '';
  const str = String(s);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

const serverPath = path.resolve(__dirname, '..', 'server.js');
if (!fs.existsSync(serverPath)) {
  console.error('server.js not found at', serverPath);
  process.exit(1);
}
const src = fs.readFileSync(serverPath, 'utf8');

// 1) Find the literal "const PRODUCTS = [ ... ]"
const startMatch = src.match(/const\s+PRODUCTS\s*=\s*\[/m);
if (!startMatch) {
  console.error('Could not find PRODUCTS array in server.js');
  process.exit(1);
}

// 2) Slice out the array text with matching bracket depth
const startIdx = startMatch.index + startMatch[0].length - 1; // at '['
let depth = 0, endIdx = -1;
for (let i = startIdx; i < src.length; i++) {
  const ch = src[i];
  if (ch === '[') depth++;
  else if (ch === ']') {
    depth--;
    if (depth === 0) { endIdx = i + 1; break; }
  }
}
if (endIdx < 0) {
  console.error('Failed to parse PRODUCTS array bounds');
  process.exit(1);
}
const arrLiteral = src.slice(startIdx, endIdx);

// 3) Evaluate ONLY the array literal as JavaScript (no server code executes)
let PRODUCTS;
try {
  PRODUCTS = Function('"use strict"; return (' + arrLiteral + ');')();
  if (!Array.isArray(PRODUCTS)) throw new Error('PRODUCTS is not an array');
} catch (e) {
  console.error('Failed to evaluate PRODUCTS array:', e.message);
  process.exit(1);
}

// 4) Build CSV rows (Airtable schema)
const header = [ 'product_id','name','sku','description','image_file','pricing_json','boxes' ];
const rows = [header.join(',')];

for (const p of PRODUCTS) {
  const pricing_json = JSON.stringify(p.pricing || []);
  rows.push([
    escCSV(p.id),
    escCSV(p.name),
    escCSV(p.sku),
    escCSV(p.description || ''),
    escCSV(p.imageFile || ''),
    escCSV(pricing_json),
    escCSV('{"boxes": []}')
  ].join(','));
}

const outPath = path.resolve(process.cwd(), process.argv[2] || 'products_full.csv');
fs.writeFileSync(outPath, rows.join('\n'), 'utf8');
console.log('✅ Wrote', outPath);
