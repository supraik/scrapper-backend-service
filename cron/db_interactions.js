/**
 * Database Interaction Handlers
 */

const ProductModel = require('../models/productModel');
const HistoryModel = require('../models/historyModel');

async function getProductIdsToFetch() {
    // Dummy IDs for now. Replace with actual DB query later.
    const activeProductIds = await ProductModel.getSubscribedProductIds();
    return activeProductIds;
}

async function saveProductData(results) {
    console.log("💾 [DB] Saving scraped payload:");
    await HistoryModel.appendBulkHistory(results);
    // console log the results
    console.log(results);
    console.log("💾 [DB] Saved scraped payload successfully!");
}

module.exports = {
    getProductIdsToFetch,
    saveProductData,
};