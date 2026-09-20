const getNewUserId = require('../helpers/getNewUserId');

async function auth(req, res, nxt) {
  try {
    // In Express, headers are accessed via req.headers or req.get()
    let userId = req.headers['authorization'] || req.get('authorization');

    if (!userId) {
      // 1. Generate a new user ID if none exists
      userId = await getNewUserId();

      // 2. Set it on the incoming request header
      req.headers['authorization'] = userId;
    }

    // 3. Set custom 'userid' header on the response
    res.setHeader('userid', userId);

    // 4. Proceed to next middleware
    nxt();
  } catch (error) {
    nxt(error);
  }
}

module.exports = { auth };