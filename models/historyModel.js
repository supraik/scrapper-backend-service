// models/historyModel.js
const db = require('../db');

const HistoryModel = {
  // Add or update history log for a product
  async setHistory(productId, jsonData) {
    const query = `
      INSERT INTO history (product_id, data)
      VALUES ($1, $2::jsonb)
      ON CONFLICT (product_id) 
      DO UPDATE SET data = $2::jsonb
      RETURNING *;
    `;
    const { rows } = await db.query(query, [productId, JSON.stringify(jsonData)]);
    return rows[0];
  },

  async getHistory(productId) {
    const { rows } = await db.query(`SELECT * FROM history WHERE product_id = $1;`, [productId]);
    return rows[0];
  },

  // BULK APPEND LOGS TO HISTORY
  async appendBulkHistory(logsArray) {
    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      const upsertQuery = `
        INSERT INTO history (product_id, data)
        VALUES ($1, jsonb_build_array($2::jsonb))
        ON CONFLICT (product_id)
        DO UPDATE SET data = 
          CASE
            WHEN jsonb_typeof(history.data) = 'array' 
              THEN history.data || jsonb_build_array($2::jsonb)
            ELSE 
              jsonb_build_array(history.data) || jsonb_build_array($2::jsonb)
          END;
      `;

      for (const item of logsArray) {
        // Extract product_id, store the remaining object attributes in history
        const { product_id, ...historyPayload } = item;

        await client.query(upsertQuery, [
          parseInt(product_id, 10),
          JSON.stringify(historyPayload)
        ]);
      }

      await client.query('COMMIT');
      return { success: true, processedCount: logsArray.length };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
};

module.exports = HistoryModel;