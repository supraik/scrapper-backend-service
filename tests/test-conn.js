// test-conn.js
const db = require('../db');

async function checkConnection() {
  try {
    console.log('Connecting to Supabase...');
    const res = await db.query('SELECT product_id FROM products WHERE users_subscribed > 0;');
    console.log('✅ Connection successful! Rows returned:', res.rows);
  } catch (err) {
    console.error('❌ Diagnostic Error Details:');
    console.error('Error Object:', err);
  }
}

checkConnection();