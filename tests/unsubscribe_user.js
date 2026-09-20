// unsubscribe_user.js
const ProductModel = require('../models/productModel');

async function runUnsubscription() {
  // --- CONFIGURATION ---
  const userId = 1; // Target User ID
  const productIds = [101, 102, 103, 595, 730]; // Array of Product IDs to unsubscribe from

  console.log(`Attempting to unsubscribe User ${userId} from ${productIds.length} products...`);

  try {
    const result = await ProductModel.unsubscribeUser(userId, productIds);
    console.log(`✓ Unsubscription completed successfully.`);
    console.log(`- Successfully unsubscribed products: ${result.unsubscribedCount}`);
    process.exit(0);
  } catch (err) {
    console.error('❌ Failed to unsubscribe user:', err.message);
    process.exit(1);
  }
}

runUnsubscription();
runUnsubscription();