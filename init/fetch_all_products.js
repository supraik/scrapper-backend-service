const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://demo.inelabteamdev.com/api/catalog';
const TOTAL_PAGES = 20;
const PAGE_SIZE = 50;
const TARGET_COUNT = 1000;
const OUTPUT_FILE = path.join(__dirname, 'products.json');

async function fetchAllProducts() {
  const productsMap = new Map();
  let pass = 1;

  console.log(`Starting continuous loop to fetch all ${TARGET_COUNT} unique products...\n`);

  while (productsMap.size < TARGET_COUNT) {
    console.log(`--- Pass ${pass} (Current Unique Products: ${productsMap.size}/${TARGET_COUNT}) ---`);

    for (let page = 1; page <= TOTAL_PAGES; page++) {
      try {
        const response = await fetch(`${BASE_URL}?page=${page}&pageSize=${PAGE_SIZE}`);

        if (!response.ok) {
          console.error(`Page ${page} failed with status ${response.status}`);
          continue;
        }

        const data = await response.json();
        const items = data.items || [];

        for (const item of items) {
          if (item && item.id !== undefined && !productsMap.has(item.id)) {
            productsMap.set(item.id, item);
          }
        }
      } catch (err) {
        console.error(`Fetch error on Page ${page}: ${err.message}`);
      }
    }

    const remaining = TARGET_COUNT - productsMap.size;
    console.log(`Pass ${pass} finish. Unique collected: ${productsMap.size}/${TARGET_COUNT} | Remaining: ${remaining}\n`);

    if (productsMap.size < TARGET_COUNT) {
      pass++;
    }
  }

  // Sort products sequentially by ID (1 to 1000)
  const sortedProducts = Array.from(productsMap.values()).sort((a, b) => a.id - b.id);

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(sortedProducts, null, 2));
  console.log(`\n🎉 Collected all 1,000 products! File saved to: ${OUTPUT_FILE}`);
}

fetchAllProducts();