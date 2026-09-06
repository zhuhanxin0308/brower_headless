const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');
const { buildApp } = require('../app');
const { createStatsStore } = require('../stats-store');
const { createBrowserPool, withPage } = require('../browser-pool');

function createPool() {
  return { size: 1, available: 1, borrowed: 0, pending: 0, async drain() {}, async clear() {} };
}

function createApp(t, overrides = {}) {
  const app = buildApp({
    apiKey: '', logger: false, allowPrivateNetwork: true,
    browserPoolFactory: createPool, ...overrides,
  });
  t.after(() => app.close());
  return app;
}

function waitForCancellation(signal) {
  if (!signal) return delay(50).then(() => ({ html: '未取消' }));
  return new Promise((resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

test('非法容量配置在接收请求前失败，避免关闭准入保护', () => {
  for (const options of [{ maxBrowsers: 0 }, { maxBrowsers: NaN },
    { maxPendingAcquires: -1 }, { maxPendingAcquires: Infinity },
    { minBrowsers: -1 }, { maxPendingFileResponses: 0 }]) {
    assert.throws(() => buildApp({ logger: false, ...options }), RangeError);
  }
});

test('关闭服务时排空失败仍清理空闲实例并保留原始错误', async (t) => {
  for (const clearFails of [false, true]) {
    await t.test(clearFails ? '空闲清理也失败' : '空闲清理成功', async () => {
      const drainError = new Error('借用实例已隔离');
      const clearError = new Error('空闲实例关闭失败');
      let clearCalls = 0;
      const pool = {
        ...createPool(),
        async drain() { throw drainError; },
        async clear() { clearCalls += 1; if (clearFails) throw clearError; },
      };
      const app = buildApp({ logger: false, browserPoolFactory: () => pool });
      await app.ready();
      const error = await app.close().catch((failure) => failure);
      assert.equal(clearCalls, 1);
      assert.equal(error, drainError);
      assert.equal(error.cleanupError, clearFails ? clearError : undefined);
    });
  }
});

test('totalTimeout 在 DNS 尚未完成时结束操作且不会迟到启动浏览器', async (t) => {
  let completeLookup;
  let rendererCalls = 0;
  const app = createApp(t, {
    allowPrivateNetwork: false,
    urlLookup: () => new Promise((resolve) => { completeLookup = resolve; }),
    rendererApi: { async renderPage() { rendererCalls += 1; return { html: 'ok' }; } },
  });
  const response = await app.inject({
    method: 'POST', url: '/render', payload: { url: 'https://example.com', totalTimeout: 20 },
  });
  assert.equal(response.statusCode, 504);
  assert.match(response.json().error, /总时限/);
  completeLookup([{ address: '93.184.216.34', family: 4 }]);
  await delay(0);
  assert.equal(rendererCalls, 0);
});

test('totalTimeout 传播取消且保留 timeout 的导航语义', async (t) => {
  let received;
  const app = createApp(t, { rendererApi: {
    async renderPage(_pool, options) { received = options; return waitForCancellation(options.signal); },
  } });
  const response = await app.inject({
    method: 'POST', url: '/render',
    payload: { url: 'http://localhost', timeout: 500, totalTimeout: 20 },
  });
  assert.equal(response.statusCode, 504);
  assert.equal(received.timeout, 500);
  assert.equal(received.signal.aborted, true);
});

test('迟到 DNS 查询仍受容量限制且解析完成后恢复', async (t) => {
  let resolveLookup;
  let pending = true;
  const addresses = [{ address: '93.184.216.34', family: 4 }];
  const app = createApp(t, {
    minBrowsers: 1, maxBrowsers: 1, maxPendingAcquires: 0, allowPrivateNetwork: false,
    urlLookup: () => pending ? new Promise((resolve) => { resolveLookup = resolve; }) : addresses,
    rendererApi: { async renderPage() { return { html: 'ok' }; } },
  });
  const request = { method: 'POST', url: '/render',
    payload: { url: 'https://example.com', totalTimeout: 20 } };
  assert.equal((await app.inject(request)).statusCode, 504);
  assert.equal((await app.inject(request)).statusCode, 503);
  pending = false;
  resolveLookup(addresses);
  await delay(0);
  assert.equal((await app.inject(request)).statusCode, 200);
});

test('未设置 totalTimeout 时保持已有导航超时约定', async (t) => {
  let received;
  const app = createApp(t, { rendererApi: {
    async renderPage(_pool, options) { received = options; await delay(15); return { html: 'ok' }; },
  } });
  const response = await app.inject({
    method: 'POST', url: '/render', payload: { url: 'http://localhost', timeout: 1 },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(received.timeout, 1);
  assert.equal(received.signal.aborted, false);
});

test('Cookie 字符串和对象数组在校验后保持原始格式', async (t) => {
  const inputs = ['session=first', [{ name: 'session', value: 'first' }],
    [{ name: 'a', value: '1' }, { name: 'b', value: '2' }], []];
  const received = [];
  const app = createApp(t, { rendererApi: {
    async renderPage(_pool, options) { received.push(options.cookies); return { html: 'ok' }; },
  } });
  for (const cookies of inputs) {
    const result = await app.inject({ method: 'POST', url: '/render',
      payload: { url: 'http://localhost', cookies } });
    assert.equal(result.statusCode, 200);
  }
  assert.deepEqual(received, inputs);
  for (const cookies of [[{}], ['session=first']]) {
    const result = await app.inject({ method: 'POST', url: '/render',
      payload: { url: 'http://localhost', cookies } });
    assert.equal(result.statusCode, 400);
  }
});

test('四个业务接口均校验 totalTimeout 范围', async (t) => {
  const app = createApp(t);
  for (const url of ['/render', '/screenshot', '/intercept', '/fetch-file']) {
    for (const totalTimeout of [0, -1, 0.5, 2147483648]) {
      const response = await app.inject({
        method: 'POST', url,
        payload: { url: 'http://localhost', fileUrl: '_any_', totalTimeout },
      });
      assert.equal(response.statusCode, 400, `${url}: ${totalTimeout}`);
    }
  }
});

test('截图、响应监听和文件读取均接收相同取消信号', async (t) => {
  const rendererApi = {};
  for (const method of ['screenshotPage', 'interceptRequests', 'fetchFile']) {
    rendererApi[method] = (_pool, options) => waitForCancellation(options.signal);
  }
  const app = createApp(t, { rendererApi });
  for (const url of ['/screenshot', '/intercept', '/fetch-file']) {
    const response = await app.inject({
      method: 'POST', url, payload: { url: 'http://localhost', fileUrl: '_any_', totalTimeout: 20 },
    });
    assert.equal(response.statusCode, 504, url);
  }
});

test('准入容量覆盖 DNS 校验期间的并发且完成后恢复', async (t) => {
  const lookups = [];
  const app = createApp(t, {
    minBrowsers: 1, maxBrowsers: 1, maxPendingAcquires: 1, allowPrivateNetwork: false,
    urlLookup: () => new Promise((resolve) => lookups.push(resolve)),
    rendererApi: { async renderPage() { return { html: 'ok' }; } },
  });
  const payload = { url: 'https://example.com', totalTimeout: 500 };
  const requests = [app.inject({ method: 'POST', url: '/render', payload }),
    app.inject({ method: 'POST', url: '/render', payload })];
  // 主动启动注入请求，保证第三个请求确实发生在两个 DNS 等待期间。
  const pending = Promise.all(requests);
  while (lookups.length < 2) await delay(1);
  const rejected = await app.inject({ method: 'POST', url: '/render', payload });
  assert.equal(rejected.statusCode, 503);
  assert.equal(lookups.length, 2);
  lookups.forEach((resolve) => resolve([{ address: '93.184.216.34', family: 4 }]));
  assert.deepEqual((await pending).map((response) => response.statusCode), [200, 200]);
  const recovered = app.inject({ method: 'POST', url: '/render', payload });
  const completion = recovered.then((response) => response.statusCode);
  while (lookups.length < 3) await delay(1);
  lookups[2]([{ address: '93.184.216.34', family: 4 }]);
  assert.equal(await completion, 200);
});

test('零排队且最小浏览器为零时首个请求仍可按需创建实例', async (t) => {
  let launches = 0;
  const pool = createBrowserPool({ minBrowsers: 0, maxBrowsers: 1, maxPendingAcquires: 0,
    launchBrowser: async () => {
      launches += 1;
      return { isConnected: () => true, async close() {},
        async createBrowserContext() { return { async newPage() { return {}; }, async close() {} }; } };
    },
  });
  const app = createApp(t, { minBrowsers: 0, maxBrowsers: 1, maxPendingAcquires: 0,
    browserPoolFactory: () => pool, rendererApi: {
      renderPage: (activePool, { signal }) => withPage(activePool, async () => ({ html: 'ok' }), { signal }),
    } });
  const response = await app.inject({ method: 'POST', url: '/render', payload: { url: 'http://localhost' } });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(launches, 1);
});

test('文件候选容量使用服务端配置且调用方不能扩大', async (t) => {
  let received;
  const app = createApp(t, {
    maxPendingFileResponses: 7,
    rendererApi: { async fetchFile(_pool, options) {
      received = options; return { buffer: Buffer.from('ok'), contentType: 'text/plain' };
    } },
  });
  const response = await app.inject({ method: 'POST', url: '/fetch-file',
    payload: { url: 'http://localhost', fileUrl: '_any_', maxPendingResponses: 1000 } });
  assert.equal(response.statusCode, 200);
  assert.equal(received.maxPendingResponses, 7);
});

test('客户端完整发送请求后断开仍会取消浏览器操作并回收统计', async (t) => {
  let notifyStarted;
  const started = new Promise((resolve) => { notifyStarted = resolve; });
  let signal;
  const statsStore = createStatsStore();
  const app = createApp(t, { statsStore, rendererApi: {
    async renderPage(_pool, options) {
      signal = options.signal;
      notifyStarted();
      return waitForCancellation(signal);
    },
  } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const request = http.request({ host: '127.0.0.1', port: app.server.address().port,
    path: '/render', method: 'POST', headers: { 'content-type': 'application/json' } });
  request.on('error', () => {});
  request.end(JSON.stringify({ url: 'http://localhost' }));
  await started;
  request.destroy();
  for (let attempt = 0; attempt < 100 && !signal?.aborted; attempt += 1) await delay(2);
  assert.equal(signal?.aborted, true);
  assert.equal(signal.reason.statusCode, 499);
  await delay(0);
  const snapshot = statsStore.buildSnapshot();
  assert.equal(snapshot.inflightRequests, 0);
  assert.equal(snapshot.overview.totalRequests, 1);
  assert.equal(snapshot.overview.errorRequests, 1);
});

test('总时限先触发且清理期间客户端断连仍只记录一次超时', async (t) => {
  let notifyTimedOut;
  const timedOut = new Promise((resolve) => { notifyTimedOut = resolve; });
  const statsStore = createStatsStore();
  const app = createApp(t, { statsStore, rendererApi: {
    async renderPage(_pool, { signal }) {
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      notifyTimedOut();
      // 模拟浏览器取消后仍需等待资源关闭，覆盖截止时间与断连先后交错。
      await delay(40);
      throw signal.reason;
    },
  } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const request = http.request({ host: '127.0.0.1', port: app.server.address().port,
    path: '/render', method: 'POST', headers: { 'content-type': 'application/json' } });
  request.on('error', () => {});
  request.end(JSON.stringify({ url: 'http://localhost', totalTimeout: 20 }));
  await timedOut;
  request.destroy();
  await delay(60);
  const snapshot = statsStore.buildSnapshot();
  assert.equal(snapshot.inflightRequests, 0);
  assert.equal(snapshot.overview.totalRequests, 1);
  assert.equal(snapshot.overview.statusCounts[504], 1);
});
