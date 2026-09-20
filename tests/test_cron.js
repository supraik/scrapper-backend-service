// app.js
const ProductModel = require('../models/productModel');
const HistoryModel = require('../models/historyModel');

async function testNewFeatures() {
  try {
    // -------------------------------------------------------------
    // FEATURE 1: Get all product_ids with users_subscribed > 0
    // -------------------------------------------------------------
    console.log('Fetching all product_ids with users_subscribed > 0...');
    const activeProductIds = await ProductModel.getSubscribedProductIds();
    console.log('Active Subscribed Product IDs:', activeProductIds);

    // -------------------------------------------------------------
    // FEATURE 2: Bulk Append Logs to Product History
    // -------------------------------------------------------------
    const scrapedData = [
      {
        product_id: '1',
        price: null,
        timestamp: '2026-09-18T19:47:26.510Z',
        error: 'Waiting failed: 15000ms exceeded'
      },
      {
        product_id: '8',
        price: 35667,
        timestamp: '2026-09-18T19:46:46.683Z'
      },
      {
        product_id: '9',
        price: 187470,
        timestamp: '2026-09-18T19:46:39.920Z'
      }
    ];

    // Append batch 1
    await HistoryModel.appendBulkHistory(scrapedData);
    console.log('Batch 1 appended to history successfully!');

    // Append batch 2 (Simulating a second run for product 666 to test array growth)
    const newScrapedData = [
      {
        product_id: '9',
        price: 34999,
        timestamp: '2026-09-18T20:00:00.000Z'
      }
    ];

    await HistoryModel.appendBulkHistory(newScrapedData);
    console.log('Batch 2 appended to history successfully!');

    // Verify history output for product 666
    const history666 = await HistoryModel.getHistory(9);
    console.log('\nUpdated History for Product 666:');
    console.log(JSON.stringify(history666, null, 2));

  } catch (err) {
    console.error('Execution Error:', err.message);
  }
}

testNewFeatures();