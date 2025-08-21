#!/usr/bin/env node
/**
 * Export product images in a folder to CSV
 * Usage:
 *   node scripts/export_products_to_csv.js <inputDir> [outputCsv]
 *
 * CSV columns: imageFile, relativePath, sizeBytes
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

async function* walk(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

function toCsvRow(values) {
  return values
    .map((v) => {
      const s = String(v ?? '');
      if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    })
    .join(',');
}

async function main() {
  const repoRoot = path.resolve(__dirname, '..');
  const inputDir = process.argv[2];
  const outputCsv = process.argv[3] || path.join(repoRoot, 'products_full.csv');

  if (!inputDir) {
    console.error('Usage: node scripts/export_products_to_csv.js <inputDir> [outputCsv]');
    process.exit(1);
  }

  const absInput = path.resolve(inputDir);
  const exists = fs.existsSync(absInput);
  if (!exists) {
    console.error(`❌ Input directory does not exist: ${absInput}`);
    process.exit(1);
  }

  const allowed = new Set(['.png', '.jpg', '.jpeg', '.webp']);
  const rows = [];
  let count = 0;

  for await (const file of walk(absInput)) {
    const ext = path.extname(file).toLowerCase();
    if (!allowed.has(ext)) continue;
    const stat = await fsp.stat(file);
    const imageFile = path.basename(file);
    const relPath = path.relative(path.join(repoRoot, 'public'), file).replace(/\\/g, '/');
    rows.push([imageFile, relPath, stat.size]);
    count++;
  }

  rows.sort((a, b) => a[0].localeCompare(b[0]));

  const header = toCsvRow(['imageFile', 'relativePath', 'sizeBytes']);
  const csv = [header, ...rows.map((r) => toCsvRow(r))].join('\r\n');

  await fsp.writeFile(outputCsv, csv, 'utf8');
  console.log(`✅ Exported ${count} images to ${outputCsv}`);
}

main().catch((err) => {
  console.error('❌ Error:', err);
  process.exit(1);
}); 