const dns = require('dns').promises;
const { URL } = require('url');

const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal']);

function isPrivateIpv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  const [a, b] = parts;
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 0) return true;
  return false;
}

function isPrivateIpv6(ip) {
  const normalized = ip.toLowerCase();
  if (normalized === '::1' || normalized === '::') return true;
  if (normalized.startsWith('fe80:')) return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  return false;
}

function assertPublicAddress(address) {
  const ip = address.address;
  if (address.family === 4 && isPrivateIpv4(ip)) {
    throw new Error('URL resolves to a private network address');
  }
  if (address.family === 6 && isPrivateIpv6(ip)) {
    throw new Error('URL resolves to a private network address');
  }
}

async function validateUrl(urlString) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error('Invalid URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http and https URLs are allowed');
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTNAMES.has(hostname.toLowerCase())) {
    throw new Error('URL hostname is not allowed');
  }

  if (parsed.username || parsed.password) {
    throw new Error('URLs with credentials are not allowed');
  }

  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
  if (port < 1 || port > 65535) {
    throw new Error('Invalid port');
  }

  if (hostname.includes(':') || hostname.includes('%')) {
    assertPublicAddress({ address: hostname, family: 6 });
    return parsed;
  }

  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    assertPublicAddress({ address: hostname, family: 4 });
    return parsed;
  }

  const addresses = await dns.lookup(hostname, { all: true });
  for (const addr of addresses) {
    assertPublicAddress(addr);
  }

  return parsed;
}

module.exports = { validateUrl };
