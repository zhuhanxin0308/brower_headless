const test = require('node:test');
const assert = require('node:assert/strict');

const { assertAllowedUrl, isPrivateAddress, createBadRequestError } = require('../url-security');

// ====== 基本协议校验 ======

test('assertAllowedUrl 会拒绝非 http 协议', async () => {
  await assert.rejects(
    () => assertAllowedUrl('file:///etc/passwd'),
    /仅支持 HTTP 和 HTTPS 协议/,
  );
});

test('assertAllowedUrl 会拒绝 ftp 协议', async () => {
  await assert.rejects(
    () => assertAllowedUrl('ftp://example.com/file'),
    /仅支持 HTTP 和 HTTPS 协议/,
  );
});

test('assertAllowedUrl 会拒绝 javascript 协议', async () => {
  await assert.rejects(
    () => assertAllowedUrl('javascript:alert(1)'),
    /仅支持 HTTP 和 HTTPS 协议/,
  );
});

test('assertAllowedUrl 会拒绝 data 协议', async () => {
  await assert.rejects(
    () => assertAllowedUrl('data:text/html,<h1>test</h1>'),
    /仅支持 HTTP 和 HTTPS 协议/,
  );
});

// ====== 无效 URL 格式 ======

test('assertAllowedUrl 会拒绝无效 URL 格式', async () => {
  await assert.rejects(
    () => assertAllowedUrl('not a url'),
    /URL 格式不合法/,
  );
});

test('assertAllowedUrl 会拒绝空字符串', async () => {
  await assert.rejects(
    () => assertAllowedUrl(''),
    /URL 格式不合法/,
  );
});

// ====== IPv4 回环和内网地址 ======

test('assertAllowedUrl 默认拒绝本地回环地址', async () => {
  await assert.rejects(
    () => assertAllowedUrl('http://127.0.0.1/admin'),
    /禁止访问本地或内网地址/,
  );
});

test('assertAllowedUrl 会拒绝 10.x.x.x 内网地址', async () => {
  const lookup = async () => [{ address: '10.0.0.8', family: 4 }];
  await assert.rejects(
    () => assertAllowedUrl('https://internal.example.com', { lookup }),
    /禁止访问本地或内网地址/,
  );
});

test('assertAllowedUrl 会拒绝 172.16-31.x.x 内网地址', async () => {
  const lookup = async () => [{ address: '172.20.0.1', family: 4 }];
  await assert.rejects(
    () => assertAllowedUrl('https://internal.example.com', { lookup }),
    /禁止访问本地或内网地址/,
  );
});

test('assertAllowedUrl 会拒绝 192.168.x.x 内网地址', async () => {
  const lookup = async () => [{ address: '192.168.1.1', family: 4 }];
  await assert.rejects(
    () => assertAllowedUrl('https://internal.example.com', { lookup }),
    /禁止访问本地或内网地址/,
  );
});

test('assertAllowedUrl 会拒绝 169.254.x.x 链路本地地址', async () => {
  const lookup = async () => [{ address: '169.254.169.254', family: 4 }];
  await assert.rejects(
    () => assertAllowedUrl('https://metadata.example.com', { lookup }),
    /禁止访问本地或内网地址/,
  );
});

test('assertAllowedUrl 会拒绝 0.x.x.x 地址', async () => {
  const lookup = async () => [{ address: '0.0.0.0', family: 4 }];
  await assert.rejects(
    () => assertAllowedUrl('https://zero.example.com', { lookup }),
    /禁止访问本地或内网地址/,
  );
});

// ====== localhost 及其子域名 ======

test('assertAllowedUrl 会拒绝 localhost', async () => {
  await assert.rejects(
    () => assertAllowedUrl('http://localhost/admin'),
    /禁止访问本地或内网地址/,
  );
});

test('assertAllowedUrl 会拒绝 localhost 子域名', async () => {
  await assert.rejects(
    () => assertAllowedUrl('http://foo.localhost/admin'),
    /禁止访问本地或内网地址/,
  );
});

test('assertAllowedUrl 会拒绝大写 LOCALHOST', async () => {
  await assert.rejects(
    () => assertAllowedUrl('http://LOCALHOST/admin'),
    /禁止访问本地或内网地址/,
  );
});

// ====== IPv6 私有地址 ======

test('isPrivateAddress 识别 IPv6 回环地址 ::1', () => {
  assert.equal(isPrivateAddress('::1'), true);
});

test('isPrivateAddress 识别 IPv6 未指定地址 ::', () => {
  assert.equal(isPrivateAddress('::'), true);
});

test('isPrivateAddress 识别 IPv6 链路本地地址 fe80::', () => {
  assert.equal(isPrivateAddress('fe80::1'), true);
});

test('isPrivateAddress 识别 IPv6 ULA 地址 fc/fd', () => {
  assert.equal(isPrivateAddress('fc00::1'), true);
  assert.equal(isPrivateAddress('fd12:3456:789a::1'), true);
});

test('isPrivateAddress 识别 IPv4 映射的 IPv6 地址', () => {
  assert.equal(isPrivateAddress('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateAddress('::ffff:10.0.0.1'), true);
  assert.equal(isPrivateAddress('::ffff:192.168.0.1'), true);
});

test('isPrivateAddress 放行 IPv4 映射的公网 IPv6 地址', () => {
  assert.equal(isPrivateAddress('::ffff:93.184.216.34'), false);
});

test('isPrivateAddress 放行普通公网 IPv4', () => {
  assert.equal(isPrivateAddress('93.184.216.34'), false);
  assert.equal(isPrivateAddress('8.8.8.8'), false);
});

test('isPrivateAddress 对非 IP 字符串返回 false', () => {
  assert.equal(isPrivateAddress('not-an-ip'), false);
  assert.equal(isPrivateAddress(''), false);
});

// ====== DNS 解析失败 ======

test('assertAllowedUrl 在 DNS 解析失败时返回 400', async () => {
  const lookup = async () => { throw new Error('ENOTFOUND'); };
  await assert.rejects(
    () => assertAllowedUrl('https://nonexistent.example.com', { lookup }),
    /目标域名解析失败/,
  );
});

test('assertAllowedUrl 在 DNS 解析返回空数组时返回 400', async () => {
  const lookup = async () => [];
  await assert.rejects(
    () => assertAllowedUrl('https://empty.example.com', { lookup }),
    /目标域名解析失败/,
  );
});

// ====== 允许公网和显式内网 ======

test('assertAllowedUrl 允许显式开启内网访问', async () => {
  const lookup = async () => [{ address: '10.0.0.8', family: 4 }];

  await assert.doesNotReject(() =>
    assertAllowedUrl('https://internal.example.com', {
      allowPrivateNetwork: true,
      lookup,
    }),
  );
});

test('assertAllowedUrl 允许公网地址', async () => {
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }];

  await assert.doesNotReject(() =>
    assertAllowedUrl('https://example.com/resource', { lookup }),
  );
});

// ====== createBadRequestError ======

test('createBadRequestError 创建的错误带有 statusCode 400', () => {
  const error = createBadRequestError('test error');
  assert.equal(error.message, 'test error');
  assert.equal(error.statusCode, 400);
  assert.ok(error instanceof Error);
});

// ====== 100.64-127.x.x CGN 地址 ======

test('isPrivateAddress 识别 100.64.x.x CGN 地址', () => {
  assert.equal(isPrivateAddress('100.64.0.1'), true);
  assert.equal(isPrivateAddress('100.127.255.254'), true);
});

test('isPrivateAddress 放行 100.63.x.x 非 CGN 地址', () => {
  assert.equal(isPrivateAddress('100.63.255.255'), false);
});

test('isPrivateAddress 放行 100.128.x.x 非 CGN 地址', () => {
  assert.equal(isPrivateAddress('100.128.0.1'), false);
});
