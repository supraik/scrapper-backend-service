// subscribe_user.js
const ProductModel = require('../models/productModel');

async function runSubscription() {
  // --- CONFIGURATION ---
  const userId = 3; // Target User ID
  const productIds = [101, 102,103,69]; // Array of Product IDs to subscribe to

  console.log(`Attempting to subscribe User ${userId} to ${productIds.length} products...`);

  try {
    const result = await ProductModel.subscribeUser(userId, productIds);
    console.log(`✓ Subscription completed successfully.`);
    console.log(`- Newly subscribed products: ${result.newlySubscribedCount}`);
    process.exit(0);
  } catch (err) {
    console.error('❌ Failed to subscribe user:', err.message);
    process.exit(1);
  }
}

runSubscription();