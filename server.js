require('dotenv').config();
const { createApp } = require('./app');
const { logger } = require('./lib/logger');

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4';

if (!OPENROUTER_API_KEY) {
  logger.error('OPENROUTER_API_KEY environment variable is required');
  process.exit(1);
}

const app = createApp();

process.on('unhandledRejection', (err) => {
  logger.error('unhandled rejection', { error: err?.message || String(err) });
});

const PORT = process.env.PORT || 6565;
app.listen(PORT, () => {
  logger.info('ExplainToMe started', {
    url: `http://localhost:${PORT}`,
    model: OPENROUTER_MODEL,
    logLevel: logger.level(),
    nodeEnv: process.env.NODE_ENV || 'development',
  });
});
