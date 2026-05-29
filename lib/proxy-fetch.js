const { BROWSER_USER_AGENT } = require('./constants');
const { validateUrl } = require('./validate-url');

const MAX_REDIRECTS = 10;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const PROXY_HEADERS = {
  'User-Agent': BROWSER_USER_AGENT,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

function isPdfPath(urlString) {
  const pathname = new URL(urlString).pathname.toLowerCase();
  return pathname.endsWith('.pdf');
}

function isPdfContentType(contentType) {
  return (contentType || '').includes('application/pdf');
}

function getHeader(headers, name) {
  return typeof headers?.get === 'function' ? headers.get(name) : undefined;
}

async function fetchWithValidatedRedirects(fetchFn, url, options = {}) {
  let currentUrl = url;

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    await validateUrl(currentUrl);

    const response = await fetchFn(currentUrl, {
      ...options,
      redirect: 'manual',
    });

    if (!REDIRECT_STATUSES.has(response.status)) {
      return response;
    }

    const location = getHeader(response.headers, 'location');
    if (!location) return response;
    if (redirects === MAX_REDIRECTS) {
      const err = new Error('Too many redirects');
      err.status = 508;
      throw err;
    }

    currentUrl = new URL(location, currentUrl).href;
  }

  throw new Error('Too many redirects');
}

async function fetchPdfAsBase64(fetchFn, url) {
  const response = await fetchWithValidatedRedirects(fetchFn, url, { method: 'GET', headers: PROXY_HEADERS });
  if (!response.ok) {
    const err = new Error(`Failed to fetch: ${response.statusText}`);
    err.status = response.status;
    throw err;
  }
  const arrayBuffer = await response.arrayBuffer();
  return {
    isPdf: true,
    pdfBase64: Buffer.from(arrayBuffer).toString('base64'),
    url,
  };
}

async function headIsPdf(fetchFn, url) {
  try {
    const response = await fetchWithValidatedRedirects(fetchFn, url, { method: 'HEAD', headers: PROXY_HEADERS });
    if (!response.ok) return false;
    return isPdfContentType(getHeader(response.headers, 'content-type'));
  } catch {
    return false;
  }
}

module.exports = {
  PROXY_HEADERS,
  isPdfPath,
  isPdfContentType,
  fetchWithValidatedRedirects,
  fetchPdfAsBase64,
  headIsPdf,
};
