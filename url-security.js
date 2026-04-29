const dns = require('node:dns/promises');
const net = require('node:net');

// 将校验错误统一标记为 400，避免业务层重复拼装错误对象。
function createBadRequestError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function isLoopbackOrLocalHostname(hostname) {
  const normalizedHostname = hostname.toLowerCase();
  return normalizedHostname === 'localhost' || normalizedHostname.endsWith('.localhost');
}

function isPrivateIpv4(address) {
  const parts = address.split('.').map((value) => Number(value));

  if (parts.length !== 4 || parts.some((value) => Number.isNaN(value) || value < 0 || value > 255)) {
    return false;
  }

  const [first, second] = parts;

  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function isPrivateIpv6(address) {
  const normalizedAddress = address.toLowerCase();

  if (
    normalizedAddress === '::' ||
    normalizedAddress === '::1' ||
    normalizedAddress.startsWith('fe8') ||
    normalizedAddress.startsWith('fe9') ||
    normalizedAddress.startsWith('fea') ||
    normalizedAddress.startsWith('feb') ||
    normalizedAddress.startsWith('fc') ||
    normalizedAddress.startsWith('fd')
  ) {
    return true;
  }

  // 兼容 IPv4 映射的 IPv6 地址，例如 ::ffff:127.0.0.1。
  const mappedIpv4Prefix = '::ffff:';
  if (normalizedAddress.startsWith(mappedIpv4Prefix)) {
    return isPrivateIpv4(normalizedAddress.slice(mappedIpv4Prefix.length));
  }

  return false;
}

function isPrivateAddress(address) {
  const family = net.isIP(address);

  if (family === 4) {
    return isPrivateIpv4(address);
  }

  if (family === 6) {
    return isPrivateIpv6(address);
  }

  return false;
}

async function resolveAddresses(hostname, lookup) {
  const family = net.isIP(hostname);

  if (family > 0) {
    return [{ address: hostname, family }];
  }

  const results = await lookup(hostname, { all: true, verbatim: true });
  return Array.isArray(results) ? results : [results];
}

// 默认只允许访问公网的 HTTP/HTTPS 资源，避免服务退化成 SSRF 入口。
async function assertAllowedUrl(rawUrl, options = {}) {
  const {
    allowPrivateNetwork = false,
    lookup = dns.lookup,
  } = options;

  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw createBadRequestError('URL 格式不合法');
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw createBadRequestError('仅支持 HTTP 和 HTTPS 协议');
  }

  if (allowPrivateNetwork) {
    return parsedUrl;
  }

  if (isLoopbackOrLocalHostname(parsedUrl.hostname)) {
    throw createBadRequestError('禁止访问本地或内网地址');
  }

  let resolvedAddresses;
  try {
    resolvedAddresses = await resolveAddresses(parsedUrl.hostname, lookup);
  } catch {
    throw createBadRequestError('目标域名解析失败');
  }

  if (resolvedAddresses.length === 0) {
    throw createBadRequestError('目标域名解析失败');
  }

  if (resolvedAddresses.some((item) => isPrivateAddress(item.address))) {
    throw createBadRequestError('禁止访问本地或内网地址');
  }

  return parsedUrl;
}

module.exports = {
  assertAllowedUrl,
  createBadRequestError,
  isPrivateAddress,
};
