const test = require('node:test');
const assert = require('node:assert/strict');

const { buildApp, parseBoolean, parseInteger, safeEqual, ensurePoolCapacity } = require('../app');
const { createStatsStore } = require('../stats-store');

function createPoolStub(overrides = {}) {
  return {
    size: 0,
    available: 0,
    borrowed: 0,
    pending: 0,
    async drain() {},
    async clear() {},
    ...overrides,
  };
}

function createRendererStub() {
  return {
    async renderPage() {
      return { html: '<html></html>', title: 'ok', finalUrl: 'https://example.com' };
    },
    async screenshotPage() {
      return { buffer: Buffer.from('image'), contentType: 'image/png' };
    },
    async interceptRequests() {
      return { finalUrl: 'https://example.com', captured: [], files: [] };
    },
    async fetchFile() {
      return { buffer: Buffer.from('file'), contentType: 'application/octet-stream' };
    },
  };
}

// ====== parseBoolean ======

test('parseBoolean 对 null/undefined/空字符串返回默认值', () => {
  assert.equal(parseBoolean(null), false);
  assert.equal(parseBoolean(undefined), false);
  assert.equal(parseBoolean(''), false);
  assert.equal(parseBoolean(null, true), true);
  assert.equal(parseBoolean('', true), true);
});

test('parseBoolean 识别 true/1/yes/on 及其大写变体', () => {
  assert.equal(parseBoolean('true'), true);
  assert.equal(parseBoolean('TRUE'), true);
  assert.equal(parseBoolean('True'), true);
  assert.equal(parseBoolean('1'), true);
  assert.equal(parseBoolean('yes'), true);
  assert.equal(parseBoolean('YES'), true);
  assert.equal(parseBoolean('on'), true);
  assert.equal(parseBoolean('ON'), true);
});

test('parseBoolean 对其他值返回 false', () => {
  assert.equal(parseBoolean('false'), false);
  assert.equal(parseBoolean('0'), false);
  assert.equal(parseBoolean('no'), false);
  assert.equal(parseBoolean('off'), false);
  assert.equal(parseBoolean('random'), false);
});

// ====== parseInteger ======

test('parseInteger 解析有效整数字符串', () => {
  assert.equal(parseInteger('42', 0), 42);
  assert.equal(parseInteger('0', 10), 0);
  assert.equal(parseInteger('-5', 0), -5);
});

test('parseInteger 对无效值返回默认值', () => {
  assert.equal(parseInteger(null, 10), 10);
  assert.equal(parseInteger(undefined, 10), 10);
  assert.equal(parseInteger('', 10), 10);
  assert.equal(parseInteger('abc', 10), 10);
  assert.equal(parseInteger('NaN', 10), 10);
});

test('parseInteger 对浮点数字符串截断小数部分', () => {
  assert.equal(parseInteger('3.14', 0), 3);
  assert.equal(parseInteger('9.9', 0), 9);
});

// ====== safeEqual ======

test('safeEqual 相同字符串返回 true', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('', ''), true);
});

test('safeEqual 不同字符串返回 false', () => {
  assert.equal(safeEqual('abc', 'def'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
});

test('safeEqual 对非字符串输入返回 false', () => {
  assert.equal(safeEqual(null, 'abc'), false);
  assert.equal(safeEqual('abc', null), false);
  assert.equal(safeEqual(undefined, undefined), false);
  assert.equal(safeEqual(123, '123'), false);
});

// ====== ensurePoolCapacity ======

test('ensurePoolCapacity 在 pool 为 null 时抛出 503', () => {
  assert.throws(
    () => ensurePoolCapacity(null, 10),
    (error) => error.statusCode === 503 && /浏览器池尚未初始化/.test(error.message),
  );
});

test('ensurePoolCapacity 在排队超限时抛出 503', () => {
  const pool = createPoolStub({ pending: 11 });
  assert.throws(
    () => ensurePoolCapacity(pool, 10),
    (error) => error.statusCode === 503 && /服务繁忙/.test(error.message),
  );
});

test('ensurePoolCapacity 在排队未超限时正常通过', () => {
  const pool = createPoolStub({ pending: 5 });
  assert.doesNotThrow(() => ensurePoolCapacity(pool, 10));
});

test('ensurePoolCapacity 在排队等于上限时正常通过', () => {
  const pool = createPoolStub({ pending: 10 });
  assert.doesNotThrow(() => ensurePoolCapacity(pool, 10));
});

// ====== API Key 鉴权 ======

test('buildApp 会拦截未携带 API Key 的请求', async (t) => {
  const app = buildApp({
    apiKey: 'secret',
    logger: false,
    browserPoolFactory: createPoolStub,
    rendererApi: createRendererStub(),
  });

  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: 'GET',
    url: '/health',
  });

  assert.equal(response.statusCode, 401);
});

test('buildApp 会拦截错误的 API Key', async (t) => {
  const app = buildApp({
    apiKey: 'secret',
    logger: false,
    browserPoolFactory: createPoolStub,
    rendererApi: createRendererStub(),
  });

  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: 'GET',
    url: '/health',
    headers: { 'x-api-key': 'wrong-key' },
  });

  assert.equal(response.statusCode, 401);
});

// ====== Dashboard 公开访问 ======

test('buildApp 会允许无鉴权访问首页且首页不进入统计', async (t) => {
  const statsStore = createStatsStore();
  const app = buildApp({
    apiKey: 'secret',
    logger: false,
    browserPoolFactory: createPoolStub,
    rendererApi: createRendererStub(),
    statsStore,
  });

  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: 'GET',
    url: '/',
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'], /text\/html/);
  assert.match(response.body, /服务运行看板/);
  assert.equal(statsStore.buildSnapshot().overview.totalRequests, 0);
});

test('buildApp 会允许无鉴权访问 favicon', async (t) => {
  const app = buildApp({
    apiKey: 'secret',
    logger: false,
    browserPoolFactory: createPoolStub,
    rendererApi: createRendererStub(),
  });

  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: 'GET',
    url: '/favicon.ico',
  });

  assert.equal(response.statusCode, 204);
});

// ====== URL 安全校验 ======

test('buildApp 会在进入渲染逻辑前拒绝内网地址', async (t) => {
  let called = false;
  const rendererApi = createRendererStub();
  rendererApi.renderPage = async () => {
    called = true;
    return { html: '<html></html>', title: 'ok', finalUrl: 'https://example.com' };
  };

  const app = buildApp({
    apiKey: 'secret',
    logger: false,
    browserPoolFactory: createPoolStub,
    rendererApi,
    urlLookup: async () => [{ address: '127.0.0.1', family: 4 }],
  });

  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: 'POST',
    url: '/render',
    headers: { 'x-api-key': 'secret' },
    payload: { url: 'http://example.com' },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(called, false);
});

test('buildApp 允许在显式配置下访问内网地址', async (t) => {
  let called = false;
  const rendererApi = createRendererStub();
  rendererApi.renderPage = async () => {
    called = true;
    return { html: '<html></html>', title: 'ok', finalUrl: 'http://internal.example.com' };
  };

  const app = buildApp({
    apiKey: 'secret',
    allowPrivateNetwork: true,
    logger: false,
    browserPoolFactory: createPoolStub,
    rendererApi,
    urlLookup: async () => [{ address: '10.0.0.8', family: 4 }],
  });

  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: 'POST',
    url: '/render',
    headers: { 'x-api-key': 'secret' },
    payload: { url: 'http://internal.example.com' },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(called, true);
});

// ====== 统计功能 ======

test('buildApp 首页会展示历史接口统计结果', async (t) => {
  const statsStore = createStatsStore();
  const app = buildApp({
    apiKey: 'secret',
    logger: false,
    browserPoolFactory: createPoolStub,
    rendererApi: createRendererStub(),
    statsStore,
    urlLookup: async () => [{ address: '93.184.216.34', family: 4 }],
  });

  t.after(async () => {
    await app.close();
  });

  const renderResponse = await app.inject({
    method: 'POST',
    url: '/render',
    headers: { 'x-api-key': 'secret' },
    payload: { url: 'https://example.com' },
  });

  assert.equal(renderResponse.statusCode, 200);

  const snapshot = statsStore.buildSnapshot();
  assert.equal(snapshot.overview.totalRequests, 1);
  assert.equal(snapshot.endpoints.length, 1);
  assert.equal(snapshot.endpoints[0].name, 'POST /render');

  const dashboardResponse = await app.inject({
    method: 'GET',
    url: '/',
  });

  assert.equal(dashboardResponse.statusCode, 200);
  assert.match(dashboardResponse.body, /POST \/render/);
  assert.equal(statsStore.buildSnapshot().overview.totalRequests, 1);
});

test('buildApp 不会把未知路径计入统计', async (t) => {
  const statsStore = createStatsStore();
  const app = buildApp({
    apiKey: 'secret',
    logger: false,
    browserPoolFactory: createPoolStub,
    rendererApi: createRendererStub(),
    statsStore,
  });

  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: 'GET',
    url: '/unknown-route',
    headers: { 'x-api-key': 'secret' },
  });

  assert.equal(response.statusCode, 404);
  assert.equal(statsStore.buildSnapshot().overview.totalRequests, 0);
});

// ====== screenshot 接口 ======

test('buildApp 的 screenshot 接口会返回图片流并写入统计', async (t) => {
  const statsStore = createStatsStore();
  const app = buildApp({
    apiKey: 'secret',
    logger: false,
    browserPoolFactory: createPoolStub,
    rendererApi: createRendererStub(),
    statsStore,
    urlLookup: async () => [{ address: '93.184.216.34', family: 4 }],
  });

  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: 'POST',
    url: '/screenshot',
    headers: { 'x-api-key': 'secret' },
    payload: { url: 'https://example.com', format: 'png' },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-type'], 'image/png');

  const snapshot = statsStore.buildSnapshot();
  assert.equal(snapshot.overview.totalRequests, 1);
  assert.equal(snapshot.endpoints[0].name, 'POST /screenshot');
});

// ====== intercept 接口 ======

test('buildApp 的 intercept 接口会返回抓取结果', async (t) => {
  const statsStore = createStatsStore();
  const app = buildApp({
    apiKey: 'secret',
    logger: false,
    browserPoolFactory: createPoolStub,
    rendererApi: createRendererStub(),
    statsStore,
    urlLookup: async () => [{ address: '93.184.216.34', family: 4 }],
  });

  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: 'POST',
    url: '/intercept',
    headers: { 'x-api-key': 'secret' },
    payload: {
      url: 'https://example.com',
      listenUrls: ['/api'],
      fileTypes: ['image'],
    },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.captured));
  assert.ok(Array.isArray(body.files));

  const snapshot = statsStore.buildSnapshot();
  assert.equal(snapshot.endpoints[0].name, 'POST /intercept');
});

// ====== fetch-file 接口 ======

test('buildApp 的 fetch-file 接口在未命中目标文件时会返回 404', async (t) => {
  const statsStore = createStatsStore();
  const rendererApi = createRendererStub();
  rendererApi.fetchFile = async () => ({ buffer: null, contentType: '' });

  const app = buildApp({
    apiKey: 'secret',
    logger: false,
    browserPoolFactory: createPoolStub,
    rendererApi,
    statsStore,
    urlLookup: async () => [{ address: '93.184.216.34', family: 4 }],
  });

  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: 'POST',
    url: '/fetch-file',
    headers: { 'x-api-key': 'secret' },
    payload: {
      url: 'https://example.com',
      fileUrl: 'https://cdn.example.com/file.bin',
    },
  });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), { ok: false, error: '未找到目标文件' });

  const snapshot = statsStore.buildSnapshot();
  assert.equal(snapshot.overview.errorRequests, 1);
  assert.equal(snapshot.recentRequests[0].errorMessage, '未找到目标文件');
});

test('buildApp 的 fetch-file 接口支持 _any_ 通配且不对 fileUrl 做安全校验', async (t) => {
  const rendererApi = createRendererStub();
  rendererApi.fetchFile = async () => ({
    buffer: Buffer.from('data'),
    contentType: 'application/octet-stream',
  });

  const app = buildApp({
    apiKey: 'secret',
    logger: false,
    browserPoolFactory: createPoolStub,
    rendererApi,
    urlLookup: async () => [{ address: '93.184.216.34', family: 4 }],
  });

  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: 'POST',
    url: '/fetch-file',
    headers: { 'x-api-key': 'secret' },
    payload: {
      url: 'https://example.com',
      fileUrl: '_any_',
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-type'], 'application/octet-stream');
});

// ====== 安全响应头 ======

test('buildApp 响应中包含安全响应头', async (t) => {
  const app = buildApp({
    logger: false,
    browserPoolFactory: createPoolStub,
    rendererApi: createRendererStub(),
  });

  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: 'GET',
    url: '/',
  });

  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['x-frame-options'], 'DENY');
});

// ====== 并发限制 ======

test('buildApp 在浏览器池排队超限时返回 503', async (t) => {
  const rendererApi = createRendererStub();
  rendererApi.renderPage = async () => {
    return { html: '<html></html>', title: 'ok', finalUrl: 'https://example.com' };
  };

  const app = buildApp({
    apiKey: 'secret',
    logger: false,
    maxPendingAcquires: 2,
    browserPoolFactory: () => createPoolStub({ pending: 3 }),
    rendererApi,
    urlLookup: async () => [{ address: '93.184.216.34', family: 4 }],
  });

  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: 'POST',
    url: '/render',
    headers: { 'x-api-key': 'secret' },
    payload: { url: 'https://example.com' },
  });

  assert.equal(response.statusCode, 503);
  assert.match(response.json().error, /服务繁忙/);
});

// ====== 请求体 schema 校验 ======

test('buildApp 的 render 接口会拒绝缺少 url 字段的请求', async (t) => {
  const app = buildApp({
    apiKey: 'secret',
    logger: false,
    browserPoolFactory: createPoolStub,
    rendererApi: createRendererStub(),
  });

  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: 'POST',
    url: '/render',
    headers: { 'x-api-key': 'secret' },
    payload: { waitFor: 'load' },
  });

  assert.equal(response.statusCode, 400);
});

test('buildApp 的 render 接口会拒绝无效的 waitFor 值', async (t) => {
  const app = buildApp({
    apiKey: 'secret',
    logger: false,
    browserPoolFactory: createPoolStub,
    rendererApi: createRendererStub(),
  });

  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: 'POST',
    url: '/render',
    headers: { 'x-api-key': 'secret' },
    payload: { url: 'https://example.com', waitFor: 'invalid' },
  });

  assert.equal(response.statusCode, 400);
});
