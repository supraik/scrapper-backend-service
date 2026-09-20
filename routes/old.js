// routes/productRoutes.js
const express = require('express');
const router = express.Router();
const { query } = require('../db/index');
const { runScraperPipeline } = require('../cron/scraper');

const BASE_PRODUCT_URL = 'https://demo.inelabteamdev.com/product/';

/**
 * Helper: Safely extracts price, stock, and timestamp from dynamic JSONB history
 */
function extractLatestSnapshot(historyData) {
  let currentPrice = null;
  let stockStatus = 'Unknown';
  let lastScrapedAt = null;

  if (historyData) {
    let latest = null;

    if (Array.isArray(historyData) && historyData.length > 0) {
      latest = historyData[historyData.length - 1];
    } else if (typeof historyData === 'object') {
      if (Array.isArray(historyData.history) && historyData.history.length > 0) {
        latest = historyData.history[historyData.history.length - 1];
      } else {
        latest = historyData;
      }
    }

    if (latest) {
      currentPrice =
        latest.price !== undefined && latest.price !== null
          ? parseFloat(latest.price)
          : null;
      stockStatus = latest.stock || latest.stockStatus || 'Unknown';
      lastScrapedAt = latest.timestamp
        ? new Date(latest.timestamp).toISOString()
        : null;
    }
  }

  return { currentPrice, stockStatus, lastScrapedAt };
}

/**
 * 1. GET /api/products/search?q={query}
 * Searches catalog by name, category, or brand, merging latest scrape data
 */
router.get('/search', async (req, res) => {
  const searchTerm = req.query.q;

  if (!searchTerm || !searchTerm.trim()) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Query parameter "q" is required and cannot be empty.',
        details: null,
      },
    });
  }

  try {
    const sql = `
      SELECT 
        p.product_id, 
        p.name, 
        p.brand,
        p.category, 
        p.users_subscribed,
        h.data AS history_data
      FROM products p
      LEFT JOIN history h ON p.product_id = h.product_id
      WHERE p.name ILIKE $1 OR p.category ILIKE $1 OR p.brand ILIKE $1
      ORDER BY p.name ASC
      LIMIT 20;
    `;

    const { rows } = await query(sql, [`%${searchTerm.trim()}%`]);

    const data = rows.map((row) => {
      const { currentPrice, stockStatus, lastScrapedAt } = extractLatestSnapshot(row.history_data);

      return {
        id: row.product_id,
        name: row.name,
        brand: row.brand || null,
        category: row.category || 'Uncategorized',
        url: `${BASE_PRODUCT_URL}${row.product_id}`,
        currentPrice,
        stockStatus,
        isTracking: Number(row.users_subscribed) > 0,
        lastScrapedAt,
      };
    });

    return res.status(200).json({
      success: true,
      data,
      meta: {
        count: data.length,
        query: searchTerm.trim(),
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('Error during product search:', error);
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: error.message,
        details: process.env.NODE_ENV === 'development' ? error.stack : null,
      },
    });
  }
});

/**
 * 2. GET /api/products
 * Retrieves all tracked products for a user (dashboard view)
 */
router.get('/', async (req, res) => {
  const userId = req.query ? req.query.userId : NaN;

  if (isNaN(userId)) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Query parameter "userId" must be a valid integer.',
        details: null,
      },
    });
  }

  try {
    const sql = `
      SELECT 
        p.product_id, 
        p.name, 
        p.brand, 
        p.category, 
        p.users_subscribed,
        h.data AS history_data
      FROM products p
      INNER JOIN user_products up ON p.product_id = up.product_id
      LEFT JOIN history h ON p.product_id = h.product_id
      WHERE up.user_id = $1
      ORDER BY p.name ASC;
    `;

    const { rows } = await query(sql, [userId]);

    const data = rows.map((row) => {
      const { currentPrice, stockStatus, lastScrapedAt } = extractLatestSnapshot(row.history_data);

      return {
        id: row.product_id,
        name: row.name,
        brand: row.brand || null,
        category: row.category || 'Uncategorized',
        url: `${BASE_PRODUCT_URL}${row.product_id}`,
        currentPrice,
        stockStatus,
        isTracking: true,
        lastScrapedAt,
      };
    });

    return res.status(200).json({
      success: true,
      data,
      meta: {
        count: data.length,
        userId,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('Error fetching tracked products:', error);
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: error.message,
        details: process.env.NODE_ENV === 'development' ? error.stack : null,
      },
    });
  }
});

/**
 * 3. POST /api/products/track
 * Subscribes a user to a product and increments users_subscribed
 */
router.post('/track', async (req, res) => {
  const { productId, userId = 1 } = req.body;

  if (!productId) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Field "productId" is required.',
        details: null,
      },
    });
  }

  const parsedProductId = parseInt(productId, 10);
  const parsedUserId = parseInt(userId, 10);

  if (isNaN(parsedProductId)) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Field "productId" must be an integer.',
        details: null,
      },
    });
  }

  try {
    const checkProductSql = `SELECT product_id, name, brand, category FROM products WHERE product_id = $1;`;
    const checkRes = await query(checkProductSql, [parsedProductId]);

    if (checkRes.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'PRODUCT_NOT_FOUND',
          message: `Product with ID ${parsedProductId} does not exist.`,
          details: null,
        },
      });
    }

    const linkSql = `
      INSERT INTO user_products (user_id, product_id)
      VALUES ($1, $2)
      ON CONFLICT (user_id, product_id) DO NOTHING;
    `;
    const linkRes = await query(linkSql, [parsedUserId, parsedProductId]);

    let updatedProductSql;
    if (linkRes.rowCount > 0) {
      updatedProductSql = `
        UPDATE products 
        SET users_subscribed = users_subscribed + 1 
        WHERE product_id = $1 
        RETURNING product_id, name, brand, category, users_subscribed;
      `;
    } else {
      updatedProductSql = `
        SELECT product_id, name, brand, category, users_subscribed 
        FROM products 
        WHERE product_id = $1;
      `;
    }

    const { rows: productRows } = await query(updatedProductSql, [parsedProductId]);
    const updatedProduct = productRows[0];

    const historySql = `SELECT data FROM history WHERE product_id = $1;`;
    const { rows: historyRows } = await query(historySql, [parsedProductId]);
    const historyData = historyRows.length > 0 ? historyRows[0].data : null;
    const { currentPrice, stockStatus, lastScrapedAt } = extractLatestSnapshot(historyData);

    return res.status(200).json({
      success: true,
      data: {
        id: updatedProduct.product_id,
        name: updatedProduct.name,
        brand: updatedProduct.brand || null,
        category: updatedProduct.category || 'Uncategorized',
        url: `${BASE_PRODUCT_URL}${updatedProduct.product_id}`,
        currentPrice,
        stockStatus,
        isTracking: Number(updatedProduct.users_subscribed) > 0,
        lastScrapedAt,
      },
      meta: {
        message: linkRes.rowCount > 0 ? 'Product tracked successfully.' : 'Product is already being tracked by this user.',
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('Error tracking product:', error);
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: error.message,
        details: process.env.NODE_ENV === 'development' ? error.stack : null,
      },
    });
  }
});

/**
 * 4. DELETE /api/products/:id/track
 * Unsubscribes a user and decrements users_subscribed safely
 */
router.delete('/:id/track', async (req, res) => {
  const productId = parseInt(req.params.id, 10);
  const userId = parseInt(req.query.userId || req.body?.userId || 1, 10);

  if (isNaN(productId)) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Product ID in route path must be a valid integer.',
        details: null,
      },
    });
  }

  try {
    const unlinkSql = `
      DELETE FROM user_products
      WHERE user_id = $1 AND product_id = $2
      RETURNING product_id;
    `;
    const unlinkRes = await query(unlinkSql, [userId, productId]);

    if (unlinkRes.rowCount === 0) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOT_TRACKED',
          message: `Product with ID ${productId} is not currently tracked by this user.`,
          details: null,
        },
      });
    }

    const updateSql = `
      UPDATE products
      SET users_subscribed = GREATEST(users_subscribed - 1, 0)
      WHERE product_id = $1
      RETURNING product_id, name, brand, category, users_subscribed;
    `;
    const { rows: productRows } = await query(updateSql, [productId]);
    const updatedProduct = productRows[0];

    return res.status(200).json({
      success: true,
      data: {
        id: updatedProduct.product_id,
        name: updatedProduct.name,
        brand: updatedProduct.brand || null,
        category: updatedProduct.category || 'Uncategorized',
        url: `${BASE_PRODUCT_URL}${updatedProduct.product_id}`,
        isTracking: false,
        usersSubscribed: updatedProduct.users_subscribed,
      },
      meta: {
        message: 'Product removed from watchlist successfully.',
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('Error untracking product:', error);
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: error.message,
        details: process.env.NODE_ENV === 'development' ? error.stack : null,
      },
    });
  }
});

/**
 * 5. GET /api/products/:id/history
 * Retrieves full historical pricing data points for charts
 */
router.get('/:id/history', async (req, res) => {
  const productId = parseInt(req.params.id, 10);

  if (isNaN(productId)) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Product ID in route path must be a valid integer.',
        details: null,
      },
    });
  }

  try {
    const sql = `
      SELECT 
        p.product_id, 
        p.name, 
        p.brand, 
        p.category, 
        p.users_subscribed,
        h.data AS history_data
      FROM products p
      LEFT JOIN history h ON p.product_id = h.product_id
      WHERE p.product_id = $1;
    `;

    const { rows } = await query(sql, [productId]);

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'PRODUCT_NOT_FOUND',
          message: `Product with ID ${productId} does not exist.`,
          details: null,
        },
      });
    }

    const row = rows[0];
    let rawHistoryList = [];

    if (row.history_data) {
      if (Array.isArray(row.history_data)) {
        rawHistoryList = row.history_data;
      } else if (typeof row.history_data === 'object') {
        if (Array.isArray(row.history_data.history)) {
          rawHistoryList = row.history_data.history;
        } else {
          rawHistoryList = [row.history_data];
        }
      }
    }

    const history = rawHistoryList
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry) => ({
        price:
          entry.price !== undefined && entry.price !== null
            ? parseFloat(entry.price)
            : null,
        stockStatus: entry.stock || entry.stockStatus || 'Unknown',
        timestamp: entry.timestamp
          ? new Date(entry.timestamp).toISOString()
          : null,
      }));

    return res.status(200).json({
      success: true,
      data: {
        id: row.product_id,
        name: row.name,
        brand: row.brand || null,
        category: row.category || 'Uncategorized',
        url: `${BASE_PRODUCT_URL}${row.product_id}`,
        isTracking: Number(row.users_subscribed) > 0,
        history,
      },
      meta: {
        dataPoints: history.length,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('Error fetching product history:', error);
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: error.message,
        details: process.env.NODE_ENV === 'development' ? error.stack : null,
      },
    });
  }
});

/**
 * 6. GET /api/products/:id/logs
 * Retrieves scrape execution logs and audit entries
 */
router.get('/:id/logs', async (req, res) => {
  const productId = parseInt(req.params.id, 10);

  if (isNaN(productId)) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Product ID in route path must be a valid integer.',
        details: null,
      },
    });
  }

  try {
    const sql = `
      SELECT 
        p.product_id, 
        p.name, 
        p.brand,
        p.category,
        h.data AS history_data
      FROM products p
      LEFT JOIN history h ON p.product_id = h.product_id
      WHERE p.product_id = $1;
    `;

    const { rows } = await query(sql, [productId]);

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'PRODUCT_NOT_FOUND',
          message: `Product with ID ${productId} does not exist.`,
          details: null,
        },
      });
    }

    const row = rows[0];
    let rawEntries = [];

    if (row.history_data) {
      if (Array.isArray(row.history_data.logs)) {
        rawEntries = row.history_data.logs;
      } else if (Array.isArray(row.history_data)) {
        rawEntries = row.history_data;
      } else if (typeof row.history_data === 'object') {
        if (Array.isArray(row.history_data.history)) {
          rawEntries = row.history_data.history;
        } else {
          rawEntries = [row.history_data];
        }
      }
    }

    const logs = rawEntries
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry, index) => {
        const timestamp = entry.timestamp
          ? new Date(entry.timestamp).toISOString()
          : null;
        const price =
          entry.price !== undefined && entry.price !== null
            ? parseFloat(entry.price)
            : null;
        const stockStatus = entry.stock || entry.stockStatus || 'Unknown';

        let message = entry.message;
        if (!message) {
          if (price !== null) {
            message = `Scrape successful. Recorded price: $${price.toFixed(2)}, Stock: ${stockStatus}.`;
          } else {
            message = `Scrape completed with null price data. Stock: ${stockStatus}.`;
          }
        }

        return {
          id: entry.logId || index + 1,
          timestamp,
          level: entry.level || (price !== null ? 'INFO' : 'WARN'),
          status: entry.status || (price !== null ? 'SUCCESS' : 'NO_DATA'),
          message,
          price,
          stockStatus,
        };
      })
      .reverse();

    return res.status(200).json({
      success: true,
      data: {
        id: row.product_id,
        name: row.name,
        brand: row.brand || null,
        category: row.category || 'Uncategorized',
        logs,
      },
      meta: {
        totalLogs: logs.length,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('Error fetching product logs:', error);
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: error.message,
        details: process.env.NODE_ENV === 'development' ? error.stack : null,
      },
    });
  }
});


module.exports = router;