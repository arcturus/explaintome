const dns = require('dns').promises;
const { URL } = require('url');

const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal']);

function isPrivateIpv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 0) return true;
  return false;
}

function expandIpv6(ip) {
  const normalized = ip.toLowerCase().split('%')[0];
  if (normalized.includes('.')) return null;

  const halves = normalized.split('::');
  if (halves.length > 2) return null;

  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (missing < 0) return null;

  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8) return null;

  return groups.map((group) => {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    return parseInt(group, 16);
  });
}

function getEmbeddedIpv4(ip) {
  const groups = expandIpv6(ip);
  if (!groups || groups.some((group) => group === null)) return null;

  const firstFiveZero = groups.slice(0, 5).every((group) => group === 0);
  const firstSixZero = groups.slice(0, 6).every((group) => group === 0);
  if (!firstFiveZero || (groups[5] !== 0xffff && !firstSixZero)) return null;

  return [
    groups[6] >> 8,
    groups[6] & 0xff,
    groups[7] >> 8,
    groups[7] & 0xff,
  ].join('.');
}

function isPrivateIpv6(ip) {
  const normalized = ip.toLowerCase();
  const embeddedIpv4 = getEmbeddedIpv4(normalized);
  if (embeddedIpv4 && isPrivateIpv4(embeddedIpv4)) return true;
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
