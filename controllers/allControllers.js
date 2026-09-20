// controllers/allControllers.js
const db = require('../db');
const ProductModel = require('../models/productModel');
const HistoryModel = require('../models/historyModel');

const BASE_PRODUCT_URL = 'https://demo.inelabteamdev.com/product/';

// Helper: pulls latest price, stock, timestamp from JSONB history array
function extractLatest(historyData) {
  let latest = null;

  if (Array.isArray(historyData) && historyData.length > 0) {
    latest = historyData[historyData.length - 1];
  } else if (historyData && typeof historyData === 'object') {
    latest = historyData;
  }

  return {
    currentPrice: latest?.price != null ? parseFloat(latest.price) : null,
    stockStatus: latest?.stock || latest?.stockStatus || 'Unknown',
    lastFetchedAt: latest?.timestamp ? new Date(latest.timestamp).toISOString() : null,
  };
}

// Helper: shape a product row into the standard response object
function formatProduct(row, extra = {}) {
  return {
    id: row.product_id,
    name: row.name,
    brand: row.brand || null,
    category: row.category || 'Uncategorized',
    url: `${BASE_PRODUCT_URL}${row.product_id}`,
    usersSubscribed: row.users_subscribed,
    ...extra,
  };
}

// ─── 1. SEARCH ────────────────────────────────────────────────────────────────
// GET /search?q=&limit=&offset=
// Uses Postgres full-text style ILIKE across name, brand, category
const getSearch = async (req, res) => {
  const q = req.query.q?.trim();
  if (!q) return res.status(400).json({ success: false, message: 'Query param "q" is required.' });

  const limit  = parseInt(req.query.limit,  10) || 20;
  const offset = (parseInt(req.query.offset, 10) || 1) - 1; // page → row offset

  try {
    const { rows } = await db.query(
      `SELECT p.product_id, p.name, p.brand, p.category, p.users_subscribed,
              h.data AS history_data
       FROM products p
       LEFT JOIN history h ON p.product_id = h.product_id
       WHERE p.name ILIKE $1 OR p.brand ILIKE $1 OR p.category ILIKE $1
       ORDER BY p.users_subscribed DESC, p.name ASC
       LIMIT $2 OFFSET $3`,
      [`%${q}%`, limit, offset]
    );

    const data = rows.map(row => {
      const { currentPrice, stockStatus, lastFetchedAt } = extractLatest(row.history_data);
      return formatProduct(row, { currentPrice, stockStatus, lastFetchedAt });
    });

    return res.json({ success: true, data, meta: { count: data.length, query: q } });
  } catch (err) {
    console.error('[getSearch]', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── 2. ADD (SUBSCRIBE) ───────────────────────────────────────────────────────
// GET /add?productId=
const addProducts = async (req, res) => {
  const userId    = req.headers['authorization'] || req.get('authorization');
  const productId = parseInt(req.query.productId, 10);

  if (!productId || isNaN(productId))
    return res.status(400).json({ success: false, message: 'Query param "productId" must be a valid integer.' });

  try {
    const result = await ProductModel.subscribeUser(userId, [productId]);
    return res.json({
      success: true,
      message: result.newlySubscribedCount > 0 ? 'Subscribed successfully.' : 'Already subscribed.',
      data: { productId, userId },
    });
  } catch (err) {
    console.error('[addProducts]', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── 3. REMOVE (UNSUBSCRIBE) ──────────────────────────────────────────────────
// GET /remove?productId=
const removeProducts = async (req, res) => {
  const userId    = req.headers['authorization'] || req.get('authorization');
  const productId = parseInt(req.query.productId, 10);

  if (!productId || isNaN(productId))
    return res.status(400).json({ success: false, message: 'Query param "productId" must be a valid integer.' });

  try {
    const result = await ProductModel.unsubscribeUser(userId, [productId]);

    if (result.unsubscribedCount === 0)
      return res.status(404).json({ success: false, message: 'Product was not in your watchlist.' });

    return res.json({ success: true, message: 'Unsubscribed successfully.', data: { productId, userId } });
  } catch (err) {
    console.error('[removeProducts]', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── 4. DASHBOARD ─────────────────────────────────────────────────────────────
// GET /dashboard
// Returns all subscribed products with latest price + last fetched time
const getDashboard = async (req, res) => {
  const userId = req.headers['authorization'] || req.get('authorization');

  try {
    const { rows } = await db.query(
      `SELECT p.product_id, p.name, p.brand, p.category, p.users_subscribed,
              h.data AS history_data
       FROM products p
       INNER JOIN user_products up ON p.product_id = up.product_id
       LEFT JOIN history h ON p.product_id = h.product_id
       WHERE up.user_id = $1
       ORDER BY p.name ASC`,
      [userId]
    );

    const data = rows.map(row => {
      const { currentPrice, stockStatus, lastFetchedAt } = extractLatest(row.history_data);
      return formatProduct(row, { currentPrice, stockStatus, lastFetchedAt });
    });

    return res.json({ success: true, data, meta: { count: data.length } });
  } catch (err) {
    console.error('[getDashboard]', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── 5. HISTORY ───────────────────────────────────────────────────────────────
// GET /history?productId=
// Returns full history array for a product (for charts / detail view)
const getHistory = async (req, res) => {
  const productId = parseInt(req.query.productId, 10);

  if (!productId || isNaN(productId))
    return res.status(400).json({ success: false, message: 'Query param "productId" must be a valid integer.' });

  try {
    const row = await HistoryModel.getHistory(productId);

    if (!row) return res.status(404).json({ success: false, message: 'No history found for this product.' });

    // Normalise: history.data could be an array or a single object
    const rawList = Array.isArray(row.data) ? row.data : [row.data];

    const history = rawList
      .filter(entry => entry && typeof entry === 'object')
      .map(entry => ({
        price:        entry.price != null ? parseFloat(entry.price) : null,
        stockStatus:  entry.stock || entry.stockStatus || 'Unknown',
        timestamp:    entry.timestamp ? new Date(entry.timestamp).toISOString() : null,
        error:        entry.error || null,
      }));

    return res.json({ success: true, data: { productId, history }, meta: { dataPoints: history.length } });
  } catch (err) {
    console.error('[getHistory]', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { getSearch, addProducts, removeProducts, getDashboard, getHistory };