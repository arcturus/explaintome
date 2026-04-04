const request = require('supertest');
const { createApp } = require('./app');

// ── Helpers ──

function mockFetch(handler) {
  return vi.fn(handler);
}

function makeFetchResponse({ status = 200, statusText = 'OK', headers = {}, body = '' }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: new Map(Object.entries(headers)),
    text: () => Promise.resolve(body),
    body: null,
  };
}

function makeSSEStream(chunks) {
  let index = 0;
  const encoder = new TextEncoder();
  return {
    getReader() {
      return {
        read() {
          if (index < chunks.length) {
            const chunk = chunks[index++];
            return Promise.resolve({ done: false, value: encoder.encode(chunk) });
          }
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
}

function makeStreamingFetchResponse(chunks) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Map([['content-type', 'text/event-stream']]),
    body: makeSSEStream(chunks),
  };
}

// ── Tests ──

describe('POST /api/proxy', () => {
  it('returns 400 when no URL is provided', async () => {
    const app = createApp({ openrouterApiKey: 'test-key' });
    const res = await request(app).post('/api/proxy').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('URL is required');
  });

  it('proxies HTML content and rewrites relative URLs', async () => {
    const fetchFn = mockFetch(() =>
      Promise.resolve(makeFetchResponse({
        headers: { 'content-type': 'text/html' },
        body: '<html><head></head><body><a href="/about">About</a><img src="/img/logo.png"></body></html>',
      }))
    );

    const app = createApp({ openrouterApiKey: 'test-key', fetchFn });
    const res = await request(app)
      .post('/api/proxy')
      .send({ url: 'https://example.com/page' });

    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://example.com/page');
    expect(res.body.html).toContain('href="https://example.com/about"');
    expect(res.body.html).toContain('src="https://example.com/img/logo.png"');
  });

  it('does not rewrite absolute URLs', async () => {
    const fetchFn = mockFetch(() =>
      Promise.resolve(makeFetchResponse({
        headers: { 'content-type': 'text/html' },
        body: '<a href="//cdn.example.com/file.js">CDN</a>',
      }))
    );

    const app = createApp({ openrouterApiKey: 'test-key', fetchFn });
    const res = await request(app)
      .post('/api/proxy')
      .send({ url: 'https://example.com' });

    expect(res.status).toBe(200);
    expect(res.body.html).toContain('href="//cdn.example.com/file.js"');
  });

  it('returns error when remote returns non-HTML content', async () => {
    const fetchFn = mockFetch(() =>
      Promise.resolve(makeFetchResponse({
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }))
    );

    const app = createApp({ openrouterApiKey: 'test-key', fetchFn });
    const res = await request(app)
      .post('/api/proxy')
      .send({ url: 'https://example.com/api' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('URL does not return HTML content');
  });

  it('forwards upstream HTTP errors', async () => {
    const fetchFn = mockFetch(() =>
      Promise.resolve(makeFetchResponse({
        status: 404,
        statusText: 'Not Found',
        headers: { 'content-type': 'text/html' },
        body: 'Not Found',
      }))
    );

    const app = createApp({ openrouterApiKey: 'test-key', fetchFn });
    const res = await request(app)
      .post('/api/proxy')
      .send({ url: 'https://example.com/missing' });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('Not Found');
  });

  it('returns 500 on network error', async () => {
    const fetchFn = mockFetch(() => Promise.reject(new Error('DNS resolution failed')));

    const app = createApp({ openrouterApiKey: 'test-key', fetchFn });
    const res = await request(app)
      .post('/api/proxy')
      .send({ url: 'https://nonexistent.invalid' });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('DNS resolution failed');
  });
});

describe('POST /api/explain', () => {
  it('returns 400 when no selectedText is provided', async () => {
    const app = createApp({ openrouterApiKey: 'test-key' });
    const res = await request(app).post('/api/explain').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('No text selected');
  });

  it('streams explanation from OpenRouter', async () => {
    const fetchFn = mockFetch((url) => {
      if (typeof url === 'string' && url.includes('chat/completions')) {
        return Promise.resolve(makeStreamingFetchResponse([
          'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"world"}}]}\n\n',
          'data: [DONE]\n\n',
        ]));
      }
      return Promise.reject(new Error('unexpected fetch'));
    });

    const app = createApp({
      openrouterApiKey: 'test-key',
      openrouterModel: 'test/model',
      openrouterBaseUrl: 'https://mock.api',
      fetchFn,
    });

    const res = await request(app)
      .post('/api/explain')
      .send({ selectedText: 'quantum entanglement', level: 'eli5' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.text).toContain('"text":"Hello "');
    expect(res.text).toContain('"text":"world"');
    expect(res.text).toContain('[DONE]');

    // Verify the fetch was called with correct params
    const call = fetchFn.mock.calls.find(c => typeof c[0] === 'string' && c[0].includes('chat/completions'));
    expect(call[0]).toBe('https://mock.api/chat/completions');
    const body = JSON.parse(call[1].body);
    expect(body.model).toBe('test/model');
    expect(body.stream).toBe(true);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toContain('like I\'m 5 years old');
    expect(body.messages[1].content).toContain('quantum entanglement');
  });

  it('includes surrounding context in the prompt when provided', async () => {
    const fetchFn = mockFetch((url) => {
      if (typeof url === 'string' && url.includes('chat/completions')) {
        return Promise.resolve(makeStreamingFetchResponse([
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
          'data: [DONE]\n\n',
        ]));
      }
      return Promise.reject(new Error('unexpected fetch'));
    });

    const app = createApp({ openrouterApiKey: 'test-key', fetchFn, openrouterBaseUrl: 'https://mock.api' });

    await request(app)
      .post('/api/explain')
      .send({
        selectedText: 'photosynthesis',
        surroundingContext: 'Plants convert sunlight into energy through photosynthesis.',
        pageTitle: 'Biology 101',
        pageUrl: 'https://example.com/bio',
        level: 'detailed',
      });

    const call = fetchFn.mock.calls.find(c => typeof c[0] === 'string' && c[0].includes('chat/completions'));
    const body = JSON.parse(call[1].body);
    expect(body.messages[0].content).toContain('Biology 101');
    expect(body.messages[0].content).toContain('https://example.com/bio');
    expect(body.messages[1].content).toContain('Plants convert sunlight');
    expect(body.messages[1].content).toContain('photosynthesis');
  });

  it('uses correct prompt for each level', async () => {
    const levels = {
      eli5: 'like I\'m 5 years old',
      simple: 'plain language',
      detailed: 'detailed, thorough',
      expert: 'technical deep-dive',
    };

    for (const [level, expectedPhrase] of Object.entries(levels)) {
      const fetchFn = mockFetch((url) => {
        if (typeof url === 'string' && url.includes('chat/completions')) {
          return Promise.resolve(makeStreamingFetchResponse([
            'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
            'data: [DONE]\n\n',
          ]));
        }
        return Promise.reject(new Error('unexpected fetch'));
      });

      const app = createApp({ openrouterApiKey: 'test-key', fetchFn, openrouterBaseUrl: 'https://mock.api' });

      await request(app)
        .post('/api/explain')
        .send({ selectedText: 'test', level });

      const call = fetchFn.mock.calls.find(c => typeof c[0] === 'string' && c[0].includes('chat/completions'));
      const body = JSON.parse(call[1].body);
      expect(body.messages[0].content).toContain(expectedPhrase);
    }
  });

  it('defaults to detailed level for unknown level', async () => {
    const fetchFn = mockFetch((url) => {
      if (typeof url === 'string' && url.includes('chat/completions')) {
        return Promise.resolve(makeStreamingFetchResponse([
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
          'data: [DONE]\n\n',
        ]));
      }
      return Promise.reject(new Error('unexpected fetch'));
    });

    const app = createApp({ openrouterApiKey: 'test-key', fetchFn, openrouterBaseUrl: 'https://mock.api' });

    await request(app)
      .post('/api/explain')
      .send({ selectedText: 'test', level: 'nonexistent' });

    const call = fetchFn.mock.calls.find(c => typeof c[0] === 'string' && c[0].includes('chat/completions'));
    const body = JSON.parse(call[1].body);
    expect(body.messages[0].content).toContain('detailed, thorough');
  });

  it('includes conversation history when provided', async () => {
    const fetchFn = mockFetch((url) => {
      if (typeof url === 'string' && url.includes('chat/completions')) {
        return Promise.resolve(makeStreamingFetchResponse([
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
          'data: [DONE]\n\n',
        ]));
      }
      return Promise.reject(new Error('unexpected fetch'));
    });

    const app = createApp({ openrouterApiKey: 'test-key', fetchFn, openrouterBaseUrl: 'https://mock.api' });

    await request(app)
      .post('/api/explain')
      .send({
        selectedText: 'test',
        conversationHistory: [
          { role: 'user', content: 'previous question' },
          { role: 'assistant', content: 'previous answer' },
        ],
      });

    const call = fetchFn.mock.calls.find(c => typeof c[0] === 'string' && c[0].includes('chat/completions'));
    const body = JSON.parse(call[1].body);
    // system + 2 history + 1 new user message = 4
    expect(body.messages).toHaveLength(4);
    expect(body.messages[1].content).toBe('previous question');
    expect(body.messages[2].content).toBe('previous answer');
  });
});

describe('POST /api/chat', () => {
  it('streams follow-up response', async () => {
    const fetchFn = mockFetch((url) => {
      if (typeof url === 'string' && url.includes('chat/completions')) {
        return Promise.resolve(makeStreamingFetchResponse([
          'data: {"choices":[{"delta":{"content":"follow-up answer"}}]}\n\n',
          'data: [DONE]\n\n',
        ]));
      }
      return Promise.reject(new Error('unexpected fetch'));
    });

    const app = createApp({ openrouterApiKey: 'test-key', fetchFn, openrouterBaseUrl: 'https://mock.api' });

    const res = await request(app)
      .post('/api/chat')
      .send({
        message: 'Can you explain more?',
        conversationHistory: [
          { role: 'user', content: 'original question' },
          { role: 'assistant', content: 'original answer' },
        ],
        level: 'eli5',
      });

    expect(res.status).toBe(200);
    expect(res.text).toContain('follow-up answer');

    const call = fetchFn.mock.calls.find(c => typeof c[0] === 'string' && c[0].includes('chat/completions'));
    const body = JSON.parse(call[1].body);
    // system + 2 history + 1 new message = 4
    expect(body.messages).toHaveLength(4);
    expect(body.messages[3].content).toBe('Can you explain more?');
    expect(body.messages[0].content).toContain('like I\'m 5 years old');
  });

  it('sends correct auth headers to OpenRouter', async () => {
    const fetchFn = mockFetch((url) => {
      if (typeof url === 'string' && url.includes('chat/completions')) {
        return Promise.resolve(makeStreamingFetchResponse([
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
          'data: [DONE]\n\n',
        ]));
      }
      return Promise.reject(new Error('unexpected fetch'));
    });

    const app = createApp({
      openrouterApiKey: 'sk-test-123',
      fetchFn,
      openrouterBaseUrl: 'https://mock.api',
    });

    await request(app)
      .post('/api/chat')
      .send({ message: 'hello', conversationHistory: [] });

    const call = fetchFn.mock.calls.find(c => typeof c[0] === 'string' && c[0].includes('chat/completions'));
    expect(call[1].headers['Authorization']).toBe('Bearer sk-test-123');
    expect(call[1].headers['HTTP-Referer']).toBe('https://explaintome.website');
    expect(call[1].headers['X-Title']).toBe('ExplainToMe');
  });
});

describe('OpenRouter error handling', () => {
  it('forwards OpenRouter API errors in SSE stream', async () => {
    const fetchFn = mockFetch((url) => {
      if (typeof url === 'string' && url.includes('chat/completions')) {
        return Promise.resolve({
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          headers: new Map(),
          text: () => Promise.resolve('Rate limited'),
        });
      }
      return Promise.reject(new Error('unexpected fetch'));
    });

    const app = createApp({ openrouterApiKey: 'test-key', fetchFn, openrouterBaseUrl: 'https://mock.api' });

    const res = await request(app)
      .post('/api/explain')
      .send({ selectedText: 'test' });

    expect(res.status).toBe(200); // SSE always starts as 200
    expect(res.text).toContain('Error: 429');
    expect(res.text).toContain('Rate limited');
    expect(res.text).toContain('[DONE]');
  });
});
