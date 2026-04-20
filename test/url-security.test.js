const test = require('node:test');
const assert = require('node:assert/strict');

const { assertAllowedUrl } = require('../url-security');

test('assertAllowedUrl 会拒绝非 http 协议', async () => {
  await assert.rejects(
    () => assertAllowedUrl('file:///etc/passwd'),
    /仅支持 HTTP 和 HTTPS 协议/,
  );
});

test('assertAllowedUrl 默认拒绝本地回环地址', async () => {
  await assert.rejects(
    () => assertAllowedUrl('http://127.0.0.1/admin'),
    /禁止访问本地或内网地址/,
  );
});

test('assertAllowedUrl 会拒绝解析到内网地址的域名', async () => {
  const lookup = async () => [{ address: '10.0.0.8', family: 4 }];

  await assert.rejects(
    () => assertAllowedUrl('https://internal.example.com', { lookup }),
    /禁止访问本地或内网地址/,
  );
});

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
