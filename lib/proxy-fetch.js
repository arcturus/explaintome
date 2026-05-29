const { BROWSER_USER_AGENT } = require('./constants');

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

async function fetchPdfAsBase64(fetchFn, url) {
  const response = await fetchFn(url, { method: 'GET', headers: PROXY_HEADERS });
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
    const response = await fetchFn(url, { method: 'HEAD', headers: PROXY_HEADERS });
    if (!response.ok) return false;
    return isPdfContentType(response.headers.get('content-type'));
  } catch {
    return false;
  }
}

module.exports = {
  PROXY_HEADERS,
  isPdfPath,
  isPdfContentType,
  fetchPdfAsBase64,
  headIsPdf,
};
