// app.js
const express = require('express');
const cors = require('cors'); // 1. Import cors
const { startCron } = require('./cron');

const app = express();
const PORT = process.env.PORT || 8000;
const routes = require('./routes/route');

// 2. Enable CORS for all routes and origins
app.use(cors({
  exposedHeaders: ['userid']
}));

// Middleware to parse incoming JSON payloads
app.use(express.json());

// Test GET API endpoint
app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'success',
    message: 'Express server is running',
    timestamp: new Date().toISOString()
  });
});

app.use(routes);

// Start the Express server and initialize cron scheduler
app.listen(PORT, () => {
  console.log(`🚀 Server listening on http://localhost:${PORT}`);
  
  // Initialize the cron job on startup
  startCron();
});

module.exports = app;