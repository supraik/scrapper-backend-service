// helper/getNewUserId.js
const crypto = require('crypto');

/**
 * Generates a random positive 32-bit integer.
 * Marked async to match the await contract in the auth middleware.
 */
async function getNewUserId() {
  // Returns an integer between 1 and 2,147,483,647
  return crypto.randomInt(1, 2147483647);
}

module.exports = getNewUserId;