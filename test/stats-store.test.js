const test = require('node:test');
const assert = require('node:assert/strict');

const { createStatsStore, TRACKED_API_ROUTES, TRACKED_API_ROUTE_KEYS } = require('../stats-store');

// ====== 核心指标聚合 ======

test('createStatsStore 会聚合整体与接口级延迟指标', () => {
  let currentTime = 1710000000000;
  const statsStore = createStatsStore({
    now: () => currentTime,
    maxRecentRequests: 5,
    maxRecentLatencies: 10,
  });

  const firstStartedAt = statsStore.markRequestStart('POST', '/render');
  currentTime += 120;
  statsStore.recordRequest({
    method: 'POST',
    path: '/render',
    statusCode: 200,
    durationMs: currentTime - firstStartedAt,
    requestedAt: new Date(currentTime).toISOString(),
  });

  const secondStartedAt = statsStore.markRequestStart('POST', '/render');
  currentTime += 280;
  statsStore.recordRequest({
    method: 'POST',
    path: '/render',
    statusCode: 500,
    durationMs: currentTime - secondStartedAt,
    requestedAt: new Date(currentTime).toISOString(),
    errorMessage: 'boom',
  });

  const snapshot = statsStore.buildSnapshot();

  assert.equal(snapshot.overview.totalRequests, 2);
  assert.equal(snapshot.overview.successRequests, 1);
  assert.equal(snapshot.overview.errorRequests, 1);
  assert.equal(snapshot.overview.avgDurationMs, 200);
  assert.equal(snapshot.overview.p95DurationMs, 272);
  assert.equal(snapshot.overview.maxDurationMs, 280);
  assert.equal(snapshot.inflightRequests, 0);
  assert.equal(snapshot.endpoints.length, 1);
  assert.equal(snapshot.endpoints[0].name, 'POST /render');
  assert.equal(snapshot.endpoints[0].successRate, 50);
  assert.equal(snapshot.recentRequests[0].errorMessage, 'boom');
});

// ====== 首页请求过滤与进行中请求 ======

test('createStatsStore 不会统计首页请求并会维护进行中请求数', () => {
  let currentTime = 1710000000000;
  const statsStore = createStatsStore({
    now: () => currentTime,
    maxRecentRequests: 2,
    maxRecentLatencies: 2,
  });

  const dashboardStartedAt = statsStore.markRequestStart('GET', '/');
  assert.equal(dashboardStartedAt, null);

  const unknownRouteStartedAt = statsStore.markRequestStart('GET', '/unknown-route');
  assert.equal(unknownRouteStartedAt, null);

  const startedAt = statsStore.markRequestStart('POST', '/screenshot');
  assert.equal(statsStore.buildSnapshot().inflightRequests, 1);

  currentTime += 90;
  statsStore.recordRequest({
    method: 'POST',
    path: '/screenshot',
    statusCode: 200,
    durationMs: currentTime - startedAt,
    requestedAt: new Date(currentTime).toISOString(),
  });

  const snapshot = statsStore.buildSnapshot();

  assert.equal(snapshot.overview.totalRequests, 1);
  assert.equal(snapshot.inflightRequests, 0);
  assert.deepEqual(snapshot.trackedRoutes, [
    'GET /health',
    'POST /render',
    'POST /screenshot',
    'POST /intercept',
    'POST /fetch-file',
  ]);
  assert.equal(snapshot.recentRequests.length, 1);
  assert.equal(snapshot.recentRequests[0].path, '/screenshot');
});

// ====== 环形缓冲区窗口限制 ======

test('createStatsStore 会限制历史窗口大小避免请求量放大写入成本', () => {
  let currentTime = 1710000000000;
  const statsStore = createStatsStore({
    now: () => currentTime,
    maxRecentRequests: 3,
    maxRecentLatencies: 4,
  });

  for (let index = 0; index < 10; index += 1) {
    const startedAt = statsStore.markRequestStart('POST', '/render');
    currentTime += (index + 1) * 10;
    statsStore.recordRequest({
      method: 'POST',
      path: '/render',
      statusCode: 200,
      durationMs: currentTime - startedAt,
      requestedAt: new Date(currentTime).toISOString(),
    });
  }

  const snapshot = statsStore.buildSnapshot();

  assert.equal(snapshot.overview.totalRequests, 10);
  assert.equal(snapshot.recentRequests.length, 3);
  assert.equal(snapshot.recentRequests[0].durationMs, 100);
  assert.equal(snapshot.recentRequests[1].durationMs, 90);
  assert.equal(snapshot.recentRequests[2].durationMs, 80);
  assert.equal(snapshot.endpoints[0].p50DurationMs, 85);
});

// ====== 环形缓冲区边界条件 ======

test('createStatsStore 在 maxRecentRequests=0 时不会崩溃', () => {
  let currentTime = 1710000000000;
  const statsStore = createStatsStore({
    now: () => currentTime,
    maxRecentRequests: 0,
    maxRecentLatencies: 2,
  });

  const startedAt = statsStore.markRequestStart('POST', '/render');
  currentTime += 50;
  statsStore.recordRequest({
    method: 'POST',
    path: '/render',
    statusCode: 200,
    durationMs: 50,
    requestedAt: new Date(currentTime).toISOString(),
  });

  const snapshot = statsStore.buildSnapshot();
  assert.equal(snapshot.overview.totalRequests, 1);
  assert.equal(snapshot.recentRequests.length, 0);
});

test('createStatsStore 在 maxRecentLatencies=1 时正确计算百分位数', () => {
  let currentTime = 1710000000000;
  const statsStore = createStatsStore({
    now: () => currentTime,
    maxRecentRequests: 10,
    maxRecentLatencies: 1,
  });

  // 写入两次，环形缓冲区只保留最后一个
  statsStore.markRequestStart('POST', '/render');
  currentTime += 100;
  statsStore.recordRequest({
    method: 'POST',
    path: '/render',
    statusCode: 200,
    durationMs: 100,
    requestedAt: new Date(currentTime).toISOString(),
  });

  statsStore.markRequestStart('POST', '/render');
  currentTime += 200;
  statsStore.recordRequest({
    method: 'POST',
    path: '/render',
    statusCode: 200,
    durationMs: 200,
    requestedAt: new Date(currentTime).toISOString(),
  });

  const snapshot = statsStore.buildSnapshot();
  // 只保留最后一个 duration=200，所以所有百分位都等于 200
  assert.equal(snapshot.overview.p50DurationMs, 200);
  assert.equal(snapshot.overview.p95DurationMs, 200);
});

// ====== normalizeDuration 边界 ======

test('createStatsStore 对 NaN 和负数 durationMs 会规范化为 0', () => {
  let currentTime = 1710000000000;
  const statsStore = createStatsStore({
    now: () => currentTime,
    maxRecentRequests: 5,
    maxRecentLatencies: 5,
  });

  statsStore.markRequestStart('POST', '/render');
  currentTime += 10;
  statsStore.recordRequest({
    method: 'POST',
    path: '/render',
    statusCode: 200,
    durationMs: NaN,
    requestedAt: new Date(currentTime).toISOString(),
  });

  statsStore.markRequestStart('POST', '/render');
  currentTime += 10;
  statsStore.recordRequest({
    method: 'POST',
    path: '/render',
    statusCode: 200,
    durationMs: -100,
    requestedAt: new Date(currentTime).toISOString(),
  });

  statsStore.markRequestStart('POST', '/render');
  currentTime += 10;
  statsStore.recordRequest({
    method: 'POST',
    path: '/render',
    statusCode: 200,
    durationMs: Infinity,
    requestedAt: new Date(currentTime).toISOString(),
  });

  const snapshot = statsStore.buildSnapshot();
  assert.equal(snapshot.overview.totalRequests, 3);
  // NaN、负数、Infinity 都被规范化为 0
  assert.equal(snapshot.overview.maxDurationMs, 0);
});

// ====== inflight 请求不会变为负数 ======

test('createStatsStore 的 inflightRequests 不会变为负数', () => {
  let currentTime = 1710000000000;
  const statsStore = createStatsStore({
    now: () => currentTime,
    maxRecentRequests: 5,
    maxRecentLatencies: 5,
  });

  // 不调用 markRequestStart 直接 recordRequest
  statsStore.recordRequest({
    method: 'POST',
    path: '/render',
    statusCode: 200,
    durationMs: 50,
    requestedAt: new Date(currentTime).toISOString(),
  });

  assert.equal(statsStore.buildSnapshot().inflightRequests, 0);
});

// ====== 多个接口端点排序 ======

test('createStatsStore 按请求数降序排列端点', () => {
  let currentTime = 1710000000000;
  const statsStore = createStatsStore({
    now: () => currentTime,
    maxRecentRequests: 10,
    maxRecentLatencies: 10,
  });

  // /render 2次
  for (let i = 0; i < 2; i++) {
    statsStore.markRequestStart('POST', '/render');
    currentTime += 10;
    statsStore.recordRequest({
      method: 'POST',
      path: '/render',
      statusCode: 200,
      durationMs: 10,
      requestedAt: new Date(currentTime).toISOString(),
    });
  }

  // /screenshot 5次
  for (let i = 0; i < 5; i++) {
    statsStore.markRequestStart('POST', '/screenshot');
    currentTime += 10;
    statsStore.recordRequest({
      method: 'POST',
      path: '/screenshot',
      statusCode: 200,
      durationMs: 10,
      requestedAt: new Date(currentTime).toISOString(),
    });
  }

  const snapshot = statsStore.buildSnapshot();
  assert.equal(snapshot.endpoints.length, 2);
  assert.equal(snapshot.endpoints[0].name, 'POST /screenshot');
  assert.equal(snapshot.endpoints[1].name, 'POST /render');
});

// ====== 常量导出 ======

test('TRACKED_API_ROUTES 包含所有预期路由', () => {
  assert.ok(TRACKED_API_ROUTES.includes('GET /health'));
  assert.ok(TRACKED_API_ROUTES.includes('POST /render'));
  assert.ok(TRACKED_API_ROUTES.includes('POST /screenshot'));
  assert.ok(TRACKED_API_ROUTES.includes('POST /intercept'));
  assert.ok(TRACKED_API_ROUTES.includes('POST /fetch-file'));
  assert.equal(TRACKED_API_ROUTES.length, 5);
});

test('TRACKED_API_ROUTE_KEYS 是 Set 类型且内容与 TRACKED_API_ROUTES 一致', () => {
  assert.ok(TRACKED_API_ROUTE_KEYS instanceof Set);
  assert.equal(TRACKED_API_ROUTE_KEYS.size, TRACKED_API_ROUTES.length);
  for (const route of TRACKED_API_ROUTES) {
    assert.ok(TRACKED_API_ROUTE_KEYS.has(route));
  }
});
