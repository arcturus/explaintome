require('dotenv').config();
const { createApp } = require('./app');

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4';

if (!OPENROUTER_API_KEY) {
  console.error('Error: OPENROUTER_API_KEY environment variable is required');
  process.exit(1);
}

const app = createApp();

const PORT = process.env.PORT || 6565;
app.listen(PORT, () => {
  console.log(`ExplainToMe running at http://localhost:${PORT}`);
  console.log(`Model: ${OPENROUTER_MODEL}`);
});
