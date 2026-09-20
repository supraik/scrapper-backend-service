const fs = require('fs');
const path = require('path');
const ProductModel = require('../models/productModel');

const INPUT_FILE = path.join(__dirname, 'products.json');
const CHUNK_SIZE = 50;

async function seedFromJSON() {
  console.log('Starting DB seeding from local products.json...\n');

  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`❌ Error: File not found at ${INPUT_FILE}`);
    console.error(`Run "node init/fetch_all_products.js" first to populate the JSON file.`);
    process.exit(1);
  }

  const productsData = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
  console.log(`Loaded ${productsData.length} total products from file.\n`);

  try {
    let totalInserted = 0;

    for (let i = 0; i < productsData.length; i += CHUNK_SIZE) {
      const chunk = productsData.slice(i, i + CHUNK_SIZE);
      const chunkNumber = Math.floor(i / CHUNK_SIZE) + 1;

      console.log(`[Chunk ${chunkNumber}] Inserting ${chunk.length} items (IDs ${chunk[0].id} to ${chunk[chunk.length - 1].id})...`);

      const rows = await ProductModel.bulkAddProducts(chunk);
      totalInserted += rows.length;

      console.log(`✓ [Chunk ${chunkNumber}] Success. ${rows.length} rows written.`);
    }

    console.log(`\n🎉 Seeding completed! Total products stored in DB: ${totalInserted}`);
    process.exit(0);
  } catch (err) {
    console.error('❌ Seeding failed with error:', err.message);
    process.exit(1);
  }
}

seedFromJSON();