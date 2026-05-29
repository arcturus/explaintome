const request = require('supertest');
const { createApp } = require('./app');

// ── Helpers ──

function mockFetch(handler) {
  return vi.fn((url, options) => handler(url, options || {}));
}

function mockRenderPage(handler) {
  return vi.fn((url) => handler(url));
}

function makeFetchResponse({ status = 200, statusText = 'OK', headers = {}, body = '' }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: new Map(Object.entries(headers)),
    text: () => Promise.resolve(body),
    arrayBuffer: () => {
      if (body instanceof ArrayBuffer) return Promise.resolve(body);
      const encoder = new TextEncoder();
      return Promise.resolve(encoder.encode(body).buffer);
    },
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

  it('rejects non-http URLs', async () => {
    const app = createApp({ openrouterApiKey: 'test-key' });
    const res = await request(app)
      .post('/api/proxy')
      .send({ url: 'file:///etc/passwd' });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain('Only http and https');
  });

  it('renders HTML and rewrites relative URLs', async () => {
    const renderPageFn = mockRenderPage(() =>
      Promise.resolve(
        '<html><head></head><body><a href="/about">About</a><img src="/img/logo.png"></body></html>'
      )
    );

    const app = createApp({ openrouterApiKey: 'test-key', renderPageFn });
    const res = await request(app)
      .post('/api/proxy')
      .send({ url: 'https://example.com/page' });

    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://example.com/page');
    expect(renderPageFn).toHaveBeenCalledWith('https://example.com/page');
    expect(res.body.html).toContain('href="https://example.com/about"');
    expect(res.body.html).toContain('src="https://example.com/img/logo.png"');
  });

  it('strips script tags from rendered HTML', async () => {
    const renderPageFn = mockRenderPage(() =>
      Promise.resolve('<html><body><script>alert(1)</script><p>Hi</p></body></html>')
    );

    const app = createApp({ openrouterApiKey: 'test-key', renderPageFn });
    const res = await request(app)
      .post('/api/proxy')
      .send({ url: 'https://example.com' });

    expect(res.status).toBe(200);
    expect(res.body.html).not.toContain('<script');
    expect(res.body.html).toContain('<p>Hi</p>');
  });

  it('does not rewrite absolute URLs', async () => {
    const renderPageFn = mockRenderPage(() =>
      Promise.resolve('<a href="//cdn.example.com/file.js">CDN</a>')
    );

    const app = createApp({ openrouterApiKey: 'test-key', renderPageFn });
    const res = await request(app)
      .post('/api/proxy')
      .send({ url: 'https://example.com' });

    expect(res.status).toBe(200);
    expect(res.body.html).toContain('href="//cdn.example.com/file.js"');
  });

  it('returns base64 PDF data when content-type is application/pdf', async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"
    const fetchFn = mockFetch((_url, opts) =>
      Promise.resolve(makeFetchResponse({
        headers: { 'content-type': 'application/pdf' },
        body: pdfBytes.buffer,
      }))
    );

    const app = createApp({ openrouterApiKey: 'test-key', fetchFn });
    const res = await request(app)
      .post('/api/proxy')
      .send({ url: 'https://example.com/doc.pdf' });

    expect(res.status).toBe(200);
    expect(res.body.isPdf).toBe(true);
    expect(res.body.url).toBe('https://example.com/doc.pdf');
    expect(typeof res.body.pdfBase64).toBe('string');
    // Verify the base64 decodes back to the original bytes
    const decoded = Buffer.from(res.body.pdfBase64, 'base64');
    expect(decoded[0]).toBe(0x25); // %
    expect(decoded[1]).toBe(0x50); // P
  });

  it('detects PDF by .pdf URL extension even without content-type', async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const fetchFn = mockFetch(() =>
      Promise.resolve(makeFetchResponse({
        headers: { 'content-type': 'application/octet-stream' },
        body: pdfBytes.buffer,
      }))
    );

    const app = createApp({ openrouterApiKey: 'test-key', fetchFn });
    const res = await request(app)
      .post('/api/proxy')
      .send({ url: 'https://example.com/report.PDF' });

    expect(res.status).toBe(200);
    expect(res.body.isPdf).toBe(true);
  });

  it('detects PDF by content-type without .pdf extension (e.g. arxiv URLs)', async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // "%PDF-1.7"
    const fetchFn = mockFetch((_url, opts) => {
      if (opts.method === 'HEAD') {
        return Promise.resolve(makeFetchResponse({
          headers: { 'content-type': 'application/pdf' },
        }));
      }
      return Promise.resolve(makeFetchResponse({
        headers: { 'content-type': 'application/pdf' },
        body: pdfBytes.buffer,
      }));
    });

    const app = createApp({ openrouterApiKey: 'test-key', fetchFn });
    const res = await request(app)
      .post('/api/proxy')
      .send({ url: 'https://arxiv.org/pdf/2602.07432' });

    expect(res.status).toBe(200);
    expect(res.body.isPdf).toBe(true);
    expect(res.body.pdfBase64).toBeTruthy();
    expect(res.body.html).toBeUndefined();
  });

  it('preserves full PDF binary content through base64 round-trip', async () => {
    // Create a buffer with all byte values 0-255
    const allBytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) allBytes[i] = i;

    const fetchFn = mockFetch(() =>
      Promise.resolve(makeFetchResponse({
        headers: { 'content-type': 'application/pdf' },
        body: allBytes.buffer,
      }))
    );

    const app = createApp({ openrouterApiKey: 'test-key', fetchFn });
    const res = await request(app)
      .post('/api/proxy')
      .send({ url: 'https://example.com/binary.pdf' });

    expect(res.status).toBe(200);
    const decoded = Buffer.from(res.body.pdfBase64, 'base64');
    expect(decoded.length).toBe(256);
    for (let i = 0; i < 256; i++) {
      expect(decoded[i]).toBe(i);
    }
  });

  it('detects PDF with .pdf extension and query parameters', async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const fetchFn = mockFetch(() =>
      Promise.resolve(makeFetchResponse({
        headers: { 'content-type': 'application/octet-stream' },
        body: pdfBytes.buffer,
      }))
    );

    const app = createApp({ openrouterApiKey: 'test-key', fetchFn });
    const res = await request(app)
      .post('/api/proxy')
      .send({ url: 'https://example.com/doc.pdf?token=abc123' });

    expect(res.status).toBe(200);
    expect(res.body.isPdf).toBe(true);
  });

  it('does not treat .pdf in path segments as PDF extension', async () => {
    const fetchFn = mockFetch((_url, opts) => {
      if (opts.method === 'HEAD') {
        return Promise.resolve(makeFetchResponse({
          headers: { 'content-type': 'text/html' },
        }));
      }
      return Promise.resolve(makeFetchResponse({
        headers: { 'content-type': 'text/html' },
        body: '<html><body>PDF viewer page</body></html>',
      }));
    });
    const renderPageFn = mockRenderPage(() =>
      Promise.resolve('<html><body>PDF viewer page</body></html>')
    );

    const app = createApp({ openrouterApiKey: 'test-key', fetchFn, renderPageFn });
    const res = await request(app)
      .post('/api/proxy')
      .send({ url: 'https://example.com/pdf-viewer/doc123' });

    expect(res.status).toBe(200);
    expect(res.body.isPdf).toBeUndefined();
    expect(res.body.html).toContain('PDF viewer page');
    expect(renderPageFn).toHaveBeenCalled();
  });

  it('returns error when page render fails', async () => {
    const fetchFn = mockFetch((_url, opts) => {
      if (opts.method === 'HEAD') {
        return Promise.resolve(makeFetchResponse({ headers: { 'content-type': 'text/html' } }));
      }
      return Promise.resolve(makeFetchResponse({ headers: { 'content-type': 'text/html' } }));
    });
    const renderPageFn = mockRenderPage(() => {
      const err = new Error('Failed to load page: 404 Not Found');
      return Promise.reject(err);
    });

    const app = createApp({ openrouterApiKey: 'test-key', fetchFn, renderPageFn });
    const res = await request(app)
      .post('/api/proxy')
      .send({ url: 'https://example.com/missing' });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain('404');
  });

  it('returns 500 on render network error', async () => {
    const fetchFn = mockFetch((_url, opts) => {
      if (opts.method === 'HEAD') {
        return Promise.resolve(makeFetchResponse({ headers: { 'content-type': 'text/html' } }));
      }
      return Promise.resolve(makeFetchResponse({ headers: { 'content-type': 'text/html' } }));
    });
    const renderPageFn = mockRenderPage(() => Promise.reject(new Error('DNS resolution failed')));

    const app = createApp({ openrouterApiKey: 'test-key', fetchFn, renderPageFn });
    const res = await request(app)
      .post('/api/proxy')
      .send({ url: 'https://example.com/page' });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('DNS resolution failed');
  });

  it('forwards upstream HTTP errors for PDF fetch', async () => {
    const fetchFn = mockFetch(() =>
      Promise.resolve(makeFetchResponse({
        status: 404,
        statusText: 'Not Found',
        headers: { 'content-type': 'application/pdf' },
        body: 'Not Found',
      }))
    );

    const app = createApp({ openrouterApiKey: 'test-key', fetchFn });
    const res = await request(app)
      .post('/api/proxy')
      .send({ url: 'https://example.com/missing.pdf' });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('Not Found');
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
