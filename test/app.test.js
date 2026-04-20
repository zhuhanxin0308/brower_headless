const test = require('node:test');
const assert = require('node:assert/strict');

const { buildApp } = require('../app');
const { createStatsStore } = require('../stats-store');

function createPoolStub() {
  return {
    size: 0,
    available: 0,
    borrowed: 0,
    async drain() {},
    async clear() {},
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
