const { chromium } = require('playwright');
const { validateUrl } = require('./validate-url');
const { BROWSER_USER_AGENT } = require('./constants');
const { PROXY_HEADERS, fetchWithValidatedRedirects } = require('./proxy-fetch');
const { logger } = require('./logger');

const ABSOLUTIZE_ATTRS = ['href', 'src', 'srcset', 'poster', 'action', 'data-src', 'data-srcset'];

const ABSOLUTIZE_SCRIPT = `
(() => {
  const base = document.baseURI;
  const abs = (u) => {
    try { return new URL(u, base).href; } catch { return u; }
  };
  const attrs = ${JSON.stringify(ABSOLUTIZE_ATTRS)};
  for (const el of document.querySelectorAll('*')) {
    for (const a of attrs) {
      const v = el.getAttribute(a);
      if (!v) continue;
      if (a === 'srcset' || a === 'data-srcset') {
        el.setAttribute(a, v.split(',').map((part) => {
          const bits = part.trim().split(/\\s+/);
          const url = bits[0];
          if (!url) return part.trim();
          return bits.length > 1 ? abs(url) + ' ' + bits.slice(1).join(' ') : abs(url);
        }).join(', '));
      } else {
        el.setAttribute(a, abs(v));
      }
    }
  }
})();
`;

let browserPromise = null;

const PREVENT_PAGE_CLOSE_SCRIPT = `
  window.close = () => {};
`;

function isClosedTargetError(err) {
  const msg = err?.message || '';
  return /has been closed|Target closed|Browser has been closed/i.test(msg);
}

function getTimeoutMs() {
  const n = Number(process.env.RENDER_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 30000;
}

function getWaitUntil() {
  const v = process.env.RENDER_WAIT_UNTIL;
  if (v === 'load' || v === 'domcontentloaded' || v === 'commit' || v === 'networkidle') {
    return v;
  }
  return 'domcontentloaded';
}

async function resetBrowser() {
  if (!browserPromise) return;
  try {
    const browser = await browserPromise;
    if (browser.isConnected()) await browser.close();
  } catch {
    // ignore shutdown errors
  }
  browserPromise = null;
}

async function getBrowser() {
  if (browserPromise) {
    const browser = await browserPromise;
    if (browser.isConnected()) return browser;
    browserPromise = null;
  }

  const browser = await chromium.launch({ headless: true });
  browser.on('disconnected', () => {
    if (browserPromise) browserPromise = null;
  });
  browserPromise = Promise.resolve(browser);
  return browser;
}

async function fetchHtmlFallback(url) {
  const response = await fetchWithValidatedRedirects(fetch, url, { method: 'GET', headers: PROXY_HEADERS });
  if (!response.ok) {
    const err = new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
    err.status = response.status;
    throw err;
  }
  const contentType = response.headers.get('content-type') || '';
  if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
    const err = new Error('URL did not return HTML');
    err.status = 502;
    throw err;
  }
  return response.text();
}

async function readPageHtml(page) {
  if (page.isClosed()) {
    throw new Error('Page closed before HTML could be read');
  }
  return page.content();
}

function isLocalBrowserUrl(url) {
  return url.startsWith('data:') || url.startsWith('blob:') || url === 'about:blank';
}

async function installNetworkGuard(context) {
  await context.route('**/*', async (route) => {
    const request = route.request();
    const requestUrl = request.url();

    if (isLocalBrowserUrl(requestUrl)) {
      await route.continue();
      return;
    }

    try {
      await validateUrl(requestUrl);
      await route.continue();
    } catch (err) {
      logger.warn('blocked proxy request', {
        url: requestUrl,
        resourceType: request.resourceType(),
        error: err.message,
      });
      await route.abort('blockedbyclient');
    }
  });
}

async function renderPageAttempt(url) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: BROWSER_USER_AGENT,
  });

  try {
    await installNetworkGuard(context);
    const page = await context.newPage();
    await page.addInitScript(PREVENT_PAGE_CLOSE_SCRIPT);

    const response = await page.goto(url, {
      waitUntil: getWaitUntil(),
      timeout: getTimeoutMs(),
    });

    if (response) await validateUrl(response.url());

    if (response && !response.ok()) {
      throw new Error(`Failed to load page: ${response.status()} ${response.statusText()}`);
    }

    let html = await readPageHtml(page);

    if (!page.isClosed()) {
      try {
        await page.evaluate(ABSOLUTIZE_SCRIPT);
        if (!page.isClosed()) {
          html = await readPageHtml(page);
        }
      } catch (err) {
        logger.warn('in-page URL absolutize failed, using snapshot HTML', {
          url,
          error: err.message,
        });
      }
    }

    return html;
  } finally {
    await context.close();
  }
}

async function renderPageWithPlaywright(url) {
  await validateUrl(url);

  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await renderPageAttempt(url);
    } catch (err) {
      lastErr = err;
      if (!isClosedTargetError(err) || attempt === 1) break;
      logger.warn('render failed (browser/page closed), retrying', { url, attempt });
      await resetBrowser();
    }
  }

  logger.warn('render failed, using fetch fallback', { url, error: lastErr.message });
  try {
    return await fetchHtmlFallback(url);
  } catch (fetchErr) {
    const err = new Error(lastErr.message || fetchErr.message);
    err.status = fetchErr.status || 502;
    throw err;
  }
}

async function closeBrowser() {
  await resetBrowser();
}

function createRenderPage({ renderFn } = {}) {
  return (url) => (renderFn || renderPageWithPlaywright)(url);
}

module.exports = {
  createRenderPage,
  renderPageWithPlaywright,
  closeBrowser,
  installNetworkGuard,
};
