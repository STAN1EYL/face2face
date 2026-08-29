require('dotenv').config();
const express = require('express');
const path = require('path');
const config = require('./config/default.json');

const app = express();

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Routes - Perxona Connect API (遵循 Handbook 規範)
app.use('/api', require('./src/routes/connect'));
// Routes - Face2Face 談判引擎 (MASTER_PLAN §20-25)
app.use('/api', require('./src/routes/negotiation'));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
const PORT = process.env.PORT || config.server.port || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Perxona AI Assistant running on http://localhost:${PORT}`);
});

module.exports = app;
