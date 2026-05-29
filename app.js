const express = require('express');
const path = require('path');
const { validateUrl } = require('./lib/validate-url');
const { createRenderPage } = require('./lib/render-page');
const { isPdfPath, headIsPdf, fetchPdfAsBase64 } = require('./lib/proxy-fetch');
const { postProcessHtml } = require('./lib/html-post-process');
const { logger } = require('./lib/logger');

function createApp({ openrouterApiKey, openrouterModel, openrouterBaseUrl, fetchFn, renderPageFn } = {}) {
  const API_KEY = openrouterApiKey || process.env.OPENROUTER_API_KEY;
  const MODEL = openrouterModel || process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4';
  const BASE_URL = openrouterBaseUrl || process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
  const _fetch = fetchFn || globalThis.fetch;
  const _renderPage = createRenderPage({ renderFn: renderPageFn });

  const app = express();

  app.use(express.json({ limit: '50mb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const meta = {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Date.now() - start,
      };
      if (res.statusCode >= 500) logger.error('request', meta);
      else if (res.statusCode >= 400) logger.warn('request', meta);
      else logger.info('request', meta);
    });
    next();
  });

  // ── Proxy endpoint: renders a URL in headless Chromium and returns HTML ──
  app.post('/api/proxy', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    try {
      await validateUrl(url);
      logger.debug('proxy start', { url });

      if (isPdfPath(url) || (await headIsPdf(_fetch, url))) {
        logger.debug('proxy pdf', { url });
        return res.json(await fetchPdfAsBase64(_fetch, url));
      }

      const rawHtml = await _renderPage(url);
      const html = postProcessHtml(rawHtml, url);
      logger.debug('proxy done', { url, bytes: html.length });
      res.json({ html, url });
    } catch (err) {
      const status = err.status || 500;
      logger.error('proxy failed', { url, status, error: err.message });
      res.status(status).json({ error: err.message });
    }
  });

  // ── OpenRouter streaming helper ──
  async function streamChat(systemPrompt, messages, res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const body = {
      model: MODEL,
      max_tokens: 2048,
      stream: true,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages,
      ],
    };

    const response = await _fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://explaintome.website',
        'X-Title': 'ExplainToMe',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errBody = await response.text();
      logger.error('OpenRouter error', { status: response.status, body: errBody });
      res.write(`data: ${JSON.stringify({ text: `Error: ${response.status} — ${errBody}` })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') break;

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            res.write(`data: ${JSON.stringify({ text: delta })}\n\n`);
          }
        } catch (e) {
          // ignore parse errors in stream
        }
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();
  }

  // ── Level prompt helpers ──
  const levelPrompts = {
    eli5: 'Explain this like I\'m 5 years old. Use very simple words, analogies a child would understand, and keep it short and fun.',
    simple: 'Explain this in plain language. No jargon, no technical terms unless you define them immediately. Assume the reader is smart but has no background in this topic. Be clear and accessible.',
    detailed: 'Give a detailed, thorough explanation. Be precise, use proper terminology, and cover nuances. Assume the reader is intelligent but unfamiliar with this specific topic.',
    expert: 'Give a technical deep-dive. Assume the reader has domain familiarity. Use proper terminology freely, cover edge cases, caveats, and subtleties. Be precise and comprehensive.',
  };

  const levelFollowUps = {
    eli5: 'Continue explaining like I\'m 5 years old.',
    simple: 'Continue explaining in plain, jargon-free language.',
    detailed: 'Continue with detailed explanations.',
    expert: 'Continue with expert-level technical depth.',
  };

  // ── Explain endpoint ──
  app.post('/api/explain', async (req, res) => {
    const { selectedText, surroundingContext, pageTitle, pageUrl, level, conversationHistory } = req.body;

    if (!selectedText) return res.status(400).json({ error: 'No text selected' });

    const systemPrompt = `You are ExplainToMe, an AI assistant that explains web content. The user is reading a web page and has highlighted some text they want explained.

Page: "${pageTitle || 'Unknown'}" (${pageUrl || 'Unknown URL'})

${levelPrompts[level] || levelPrompts.detailed}

Keep your response focused and well-structured. Use markdown formatting.`;

    const messages = [];

    if (conversationHistory && conversationHistory.length > 0) {
      messages.push(...conversationHistory);
    }

    let userMessage = '';
    if (surroundingContext) {
      userMessage += `Context around the selection:\n"""\n${surroundingContext}\n"""\n\n`;
    }
    userMessage += `Highlighted text to explain:\n"""\n${selectedText}\n"""`;

    messages.push({ role: 'user', content: userMessage });

    try {
      logger.debug('explain', { level, pageUrl, textLen: selectedText.length });
      await streamChat(systemPrompt, messages, res);
    } catch (err) {
      logger.error('explain failed', { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // ── Follow-up chat endpoint ──
  app.post('/api/chat', async (req, res) => {
    const { message, conversationHistory, pageTitle, pageUrl, level } = req.body;

    const systemPrompt = `You are ExplainToMe, an AI assistant that explains web content. The user is reading a web page and asking follow-up questions about content they highlighted.

Page: "${pageTitle || 'Unknown'}" (${pageUrl || 'Unknown URL'})

${levelFollowUps[level] || levelFollowUps.detailed}

Keep your response focused and well-structured. Use markdown formatting.`;

    const messages = [...(conversationHistory || []), { role: 'user', content: message }];

    try {
      logger.debug('chat', { level, pageUrl });
      await streamChat(systemPrompt, messages, res);
    } catch (err) {
      logger.error('chat failed', { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  return app;
}

module.exports = { createApp };
