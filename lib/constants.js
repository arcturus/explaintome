/** Browser User-Agent for proxy fetch and headless render. Override via PROXY_USER_AGENT env. */
const BROWSER_USER_AGENT =
  process.env.PROXY_USER_AGENT ||
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

module.exports = { BROWSER_USER_AGENT };
