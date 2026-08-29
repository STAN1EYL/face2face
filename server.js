require('dotenv').config();
const express = require('express');
const path = require('path');
const config = require('./config/default.json');

const app = express();

// 部署在 Render 之後 req.ip 會是 proxy 的位址；沒有這行的話
// 每個 IP 的流量限制會變成全站共用一個額度。
app.set('trust proxy', 1);

// Middleware
// 談判訊息本來就有 1000 字上限，body 再大就是濫用
app.use(express.json({ limit: '32kb' }));
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
