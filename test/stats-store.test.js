const test = require('node:test');
const assert = require('node:assert/strict');

const { createStatsStore } = require('../stats-store');

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
