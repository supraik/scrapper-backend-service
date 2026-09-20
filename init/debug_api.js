const BASE_URL = 'https://demo.inelabteamdev.com/api/catalog';
const TOTAL_PAGES = 20;
const PAGE_SIZE = 50;

async function debugApiPagination() {
  console.log('================ API PAGINATION DEBUG LOG ================');

  // Map format: ID -> Array of page numbers where it appeared
  const idToPagesMap = new Map();
  const pageItemCounts = {};
  let totalRawItemsFetched = 0;

  for (let page = 1; page <= TOTAL_PAGES; page++) {
    try {
      const response = await fetch(`${BASE_URL}?page=${page}&pageSize=${PAGE_SIZE}`);

      if (!response.ok) {
        console.error(`❌ Page ${page}: Failed with HTTP status ${response.status}`);
        continue;
      }

      const data = await response.json();
      const items = data.items || [];
      pageItemCounts[page] = items.length;
      totalRawItemsFetched += items.length;

      items.forEach(product => {
        const id = product.id;
        if (!idToPagesMap.has(id)) {
          idToPagesMap.set(id, []);
        }
        idToPagesMap.get(id).push(page);
      });

      console.log(`Page ${page.toString().padStart(2, ' ')}: Received ${items.length} items.`);
    } catch (error) {
      console.error(`❌ Page ${page}: Fetch error - ${error.message}`);
    }
  }

  // --- ANALYSIS RESULTS ---
  console.log('\n================ ANALYSIS RESULTS ================');
  console.log(`Total raw items fetched across all requests : ${totalRawItemsFetched}`);
  console.log(`Total UNIQUE Product IDs collected           : ${idToPagesMap.size}`);

  // 1. Identify Cross-Page Duplicates
  const duplicateEntries = [];
  idToPagesMap.forEach((pages, id) => {
    if (pages.length > 1) {
      duplicateEntries.push({ id, count: pages.length, pages });
    }
  });

  console.log(`\n--- DUPLICATE ANALYSIS ---`);
  console.log(`Total products that appeared MULTIPLE times: ${duplicateEntries.length}`);

  if (duplicateEntries.length > 0) {
    console.log(`Sample duplicates across pages (First 10):`);
    duplicateEntries.slice(0, 10).forEach(d => {
      console.log(`  • Product ID ${d.id}: Appeared ${d.count} times on Pages [${d.pages.join(', ')}]`);
    });
  }

  // 2. Identify Missing IDs in the 1 to 1000 range
  const missingIds = [];
  for (let expectedId = 1; expectedId <= 1000; expectedId++) {
    if (!idToPagesMap.has(expectedId)) {
      missingIds.push(expectedId);
    }
  }

  console.log(`\n--- MISSING ID ANALYSIS (Range 1..1000) ---`);
  console.log(`Total missing IDs in 1..1000 range: ${missingIds.length}`);

  if (missingIds.length > 0) {
    console.log(`Sample missing IDs (First 15): [${missingIds.slice(0, 15).join(', ')}]`);
  }

  // 3. Page Count Consistency Check
  const non50Pages = Object.entries(pageItemCounts).filter(([_, count]) => count !== 50);
  if (non50Pages.length > 0) {
    console.log(`\n--- UNEXPECTED PAGE SIZES ---`);
    non50Pages.forEach(([pg, cnt]) => {
      console.log(`  • Page ${pg} returned ${cnt} items instead of 50.`);
    });
  } else {
    console.log(`\n✓ All 20 pages returned exactly 50 items each.`);
  }

  console.log('\n==================================================');
}

debugApiPagination();