// scripts/rename_product_images.js
// Usage:
//   node scripts/rename_product_images.js               # live rename
//   DRY_RUN=1 node scripts/rename_product_images.js     # preview only
//
// This assumes your images live at: public/images/products

const fs = require('fs');
const path = require('path');

const IMAGES_DIR = path.resolve(__dirname, '..', 'public', 'images', 'products');

const RENAMES = [
  ['18500_Black_Flat_Front-01.png',                '18500_Black_Flat_Front-01_big_back.png'],
  ['18500_Dark Chocolate_Flat_Front-01.png',       '18500_Dark Chocolate_Flat_Front-01_big_back.png'],
  ['2000_black_flat_front-01.png',                 '2000_black_flat_front-01_right_chest.png'],
  ['2000_charcoal_flat_front-01.png',              '2000_charcoal_flat_front-01_right_chest.png'],
  ['5400_black_flat_front-01.png',                 '5400_black_flat_front-01_right_chest.png'],
  ['C112_greysteelneonorange_full_front-01.png',   'C112_greysteelneonorange_full_front-01_right_chest.png'],
  ['C932_Black_Flat_Front-01.png',                 'C932_Black_Flat_Front-01_right_chest.png'],
];

function renameOne(fromName, toName) {
  const fromPath = path.join(IMAGES_DIR, fromName);
  const toPath   = path.join(IMAGES_DIR, toName);

  if (!fs.existsSync(fromPath)) {
    console.warn(`⚠️  Missing source: ${fromName}`);
    return false;
  }
  if (fs.existsSync(toPath)) {
    console.log(`⏭  Already exists, skipping: ${toName}`);
    return true;
  }
  if (process.env.DRY_RUN) {
    console.log(`[DRY] ${fromName}  ->  ${toName}`);
    return true;
  }
  fs.renameSync(fromPath, toPath);
  console.log(`✅  ${fromName}  ->  ${toName}`);
  return true;
}

(function main() {
  if (!fs.existsSync(IMAGES_DIR)) {
    console.error('Images folder not found:', IMAGES_DIR);
    process.exit(1);
  }
  let ok = 0;
  for (const [from, to] of RENAMES) {
    if (renameOne(from, to)) ok++;
  }
  console.log(`Done. ${ok}/${RENAMES.length} processed.`);
})();
