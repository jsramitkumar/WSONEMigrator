require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { testConnection } = require('./config/database');
const { runMigrations } = require('./config/schema');
const logger = require('./utils/logger');

// Routers
const environmentsRouter = require('./environmentsRouter');
const jobsRouter = require('./jobsRouter');

const app = express();

// ── Security & middleware ─────────────────────────────────────────────────
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
app.use('/api', rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  message: { error: 'Too many requests, please slow down.' },
}));

// Request logger
app.use((req, _res, next) => {
  logger.debug(`${req.method} ${req.path}`);
  next();
});

// ── Routes ────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  status: 'ok',
  service: 'uem-migration-tool',
  timestamp: new Date().toISOString(),
}));

app.use('/api/environments', environmentsRouter);
app.use('/api/jobs', jobsRouter);

// ── 404 & error handler ───────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

app.use((err, req, res, _next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

// ── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5271;

(async () => {
  const dbOk = await testConnection();
  if (!dbOk) {
    logger.error('Cannot start: database connection failed');
    process.exit(1);
  }

  await runMigrations();

  app.listen(PORT, () => {
    logger.info(`🚀 UEM Migration Tool running on http://localhost:${PORT}`);
    logger.info(`📋 API docs: http://localhost:${PORT}/health`);
  });
})();

module.exports = app;
