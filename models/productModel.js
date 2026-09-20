// models/productModel.js
const db = require('../db');

const ProductModel = {

  // BULK UPSERT PRODUCTS (used by scraper/cron, not user-facing routes)
  async bulkAddProducts(productsArray) {
    if (!Array.isArray(productsArray) || productsArray.length === 0) return [];

    const productIds = productsArray.map(p => p?.id);
    const names      = productsArray.map(p => p?.name     || null);
    const brands     = productsArray.map(p => p?.brand    || null);
    const categories = productsArray.map(p => p?.category || null);

    const { rows } = await db.query(
      `INSERT INTO products (product_id, name, brand, category)
       SELECT * FROM UNNEST($1::int[], $2::text[], $3::text[], $4::text[])
       ON CONFLICT (product_id) DO UPDATE SET
         name     = EXCLUDED.name,
         brand    = EXCLUDED.brand,
         category = EXCLUDED.category
       RETURNING *`,
      [productIds, names, brands, categories]
    );

    return rows;
  },

  // SUBSCRIBE: add user→product link, increment counter for newly linked only
  async subscribeUser(userId, productIds) {
    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      const { rows: inserted } = await client.query(
        `INSERT INTO user_products (user_id, product_id)
         SELECT $1, unnest($2::int[])
         ON CONFLICT (user_id, product_id) DO NOTHING
         RETURNING product_id`,
        [userId, productIds]
      );

      const newIds = inserted.map(r => r.product_id);

      if (newIds.length > 0) {
        await client.query(
          `UPDATE products SET users_subscribed = users_subscribed + 1
           WHERE product_id = ANY($1::int[])`,
          [newIds]
        );
      }

      await client.query('COMMIT');
      return { newlySubscribedCount: newIds.length };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  // UNSUBSCRIBE: remove link, decrement counter, auto-delete history if count hits 0
  async unsubscribeUser(userId, productIds) {
    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      const { rows: deleted } = await client.query(
        `DELETE FROM user_products
         WHERE user_id = $1 AND product_id = ANY($2::int[])
         RETURNING product_id`,
        [userId, productIds]
      );

      const unsubs = deleted.map(r => r.product_id);

      if (unsubs.length > 0) {
        const { rows: updated } = await client.query(
          `UPDATE products
           SET users_subscribed = GREATEST(0, users_subscribed - 1)
           WHERE product_id = ANY($1::int[])
           RETURNING product_id, users_subscribed`,
          [unsubs]
        );

        const zeroIds = updated.filter(p => p.users_subscribed === 0).map(p => p.product_id);
        if (zeroIds.length > 0) {
          await client.query(
            `DELETE FROM history WHERE product_id = ANY($1::int[])`,
            [zeroIds]
          );
        }
      }

      await client.query('COMMIT');
      return { unsubscribedCount: unsubs.length };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  // GET all product IDs that have at least one subscriber (used by scraper)
  async getSubscribedProductIds() {
    const { rows } = await db.query(
      `SELECT product_id FROM products WHERE users_subscribed > 0`
    );
    return rows.map(r => r.product_id);
  },
};

module.exports = ProductModel;