const test = require('node:test');
const assert = require('node:assert/strict');

const { renderDashboardHtml } = require('../dashboard');

// ====== 空数据场景 ======

test('renderDashboardHtml 会在空数据场景展示空状态并转义错误信息', () => {
  const html = renderDashboardHtml({
    serviceStartedAt: '2026-04-20T00:00:00.000Z',
    generatedAt: '2026-04-20T00:00:10.000Z',
    uptimeMs: 10000,
    inflightRequests: 0,
    trackedRoutes: [
      'GET /health',
      'POST /render',
      'POST /screenshot',
      'POST /intercept',
      'POST /fetch-file',
    ],
    overview: {
      totalRequests: 0,
      successRequests: 0,
      errorRequests: 0,
      avgDurationMs: 0,
      p95DurationMs: 0,
      p99DurationMs: 0,
      maxDurationMs: 0,
      successRate: 100,
    },
    pool: null,
    endpoints: [],
    recentRequests: [
      {
        requestedAt: '2026-04-20T00:00:10.000Z',
        method: 'POST',
        path: '/render',
        statusCode: 500,
        durationMs: 128.5,
        errorMessage: '<script>alert(1)</script>',
      },
    ],
  });

  assert.match(html, /浏览器池尚未完成初始化/);
  assert.match(html, /服务刚启动，暂时还没有业务调用记录/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(html, /当前页面基于进程启动以来/);
  assert.doesNotMatch(html, /用于判断当前实例是否已经逼近浏览器并发上限/);
  assert.doesNotMatch(html, /适合长期挂在监控屏/);
});

// ====== 有池信息时 ======

test('renderDashboardHtml 有池信息时展示池状态而非初始化提示', () => {
  const html = renderDashboardHtml({
    serviceStartedAt: '2026-04-20T00:00:00.000Z',
    generatedAt: '2026-04-20T00:01:00.000Z',
    uptimeMs: 60000,
    inflightRequests: 2,
    trackedRoutes: [],
    overview: {
      totalRequests: 10,
      successRequests: 9,
      errorRequests: 1,
      avgDurationMs: 150,
      p95DurationMs: 300,
      p99DurationMs: 500,
      maxDurationMs: 600,
      successRate: 90,
    },
    pool: {
      size: 5,
      available: 3,
      borrowed: 2,
      utilizationRate: 40,
      minBrowsers: 2,
      maxBrowsers: 10,
    },
    endpoints: [],
    recentRequests: [],
  });

  // 应展示池的各项指标
  assert.match(html, /池大小/);
  assert.match(html, /空闲实例/);
  assert.match(html, /借出实例/);
  assert.match(html, /利用率/);
  // 不应出现初始化提示
  assert.doesNotMatch(html, /浏览器池尚未完成初始化/);
});

// ====== 有接口端点数据时 ======

test('renderDashboardHtml 有 endpoint 数据时正确渲染表格行', () => {
  const html = renderDashboardHtml({
    serviceStartedAt: '2026-04-20T00:00:00.000Z',
    generatedAt: '2026-04-20T00:05:00.000Z',
    uptimeMs: 300000,
    inflightRequests: 0,
    trackedRoutes: [],
    overview: {
      totalRequests: 50,
      successRequests: 48,
      errorRequests: 2,
      avgDurationMs: 200,
      p95DurationMs: 400,
      p99DurationMs: 800,
      maxDurationMs: 1000,
      successRate: 96,
    },
    pool: null,
    endpoints: [
      {
        name: 'POST /render',
        method: 'POST',
        path: '/render',
        totalRequests: 30,
        successRate: 100,
        avgDurationMs: 180,
        p95DurationMs: 350,
        maxDurationMs: 500,
        lastStatusCode: 200,
        lastRequestedAt: '2026-04-20T00:04:55.000Z',
      },
      {
        name: 'POST /screenshot',
        method: 'POST',
        path: '/screenshot',
        totalRequests: 20,
        successRate: 90,
        avgDurationMs: 250,
        p95DurationMs: 600,
        maxDurationMs: 1000,
        lastStatusCode: 500,
        lastRequestedAt: '2026-04-20T00:04:50.000Z',
      },
    ],
    recentRequests: [],
  });

  // 应包含两个端点
  assert.match(html, /POST \/render/);
  assert.match(html, /POST \/screenshot/);
  // 不应出现空状态提示
  assert.doesNotMatch(html, /服务刚启动，暂时还没有业务调用记录/);
  // 500 状态码应标记为 danger
  assert.match(html, /is-danger/);
});

// ====== 最近调用记录 ======

test('renderDashboardHtml 最近调用记录为空时展示空状态提示', () => {
  const html = renderDashboardHtml({
    serviceStartedAt: '2026-04-20T00:00:00.000Z',
    generatedAt: '2026-04-20T00:00:10.000Z',
    uptimeMs: 10000,
    inflightRequests: 0,
    trackedRoutes: [],
    overview: {
      totalRequests: 0,
      successRequests: 0,
      errorRequests: 0,
      avgDurationMs: 0,
      p95DurationMs: 0,
      p99DurationMs: 0,
      maxDurationMs: 0,
      successRate: 100,
    },
    pool: null,
    endpoints: [],
    recentRequests: [],
  });

  assert.match(html, /暂无最近调用记录/);
});

// ====== HTML 结构完整性 ======

test('renderDashboardHtml 输出包含完整 HTML 结构', () => {
  const html = renderDashboardHtml({
    serviceStartedAt: '2026-04-20T00:00:00.000Z',
    generatedAt: '2026-04-20T00:00:10.000Z',
    uptimeMs: 10000,
    inflightRequests: 0,
    trackedRoutes: [],
    overview: {
      totalRequests: 0,
      successRequests: 0,
      errorRequests: 0,
      avgDurationMs: 0,
      p95DurationMs: 0,
      p99DurationMs: 0,
      maxDurationMs: 0,
      successRate: 100,
    },
    pool: null,
    endpoints: [],
    recentRequests: [],
  });

  assert.match(html, /<!doctype html>/i);
  assert.match(html, /<html lang="zh-CN">/);
  assert.match(html, /<title>Browser Service 服务运行看板<\/title>/);
  assert.match(html, /meta http-equiv="refresh"/);
});

// ====== 成功的最近请求展示 ======

test('renderDashboardHtml 成功请求显示成功标记', () => {
  const html = renderDashboardHtml({
    serviceStartedAt: '2026-04-20T00:00:00.000Z',
    generatedAt: '2026-04-20T00:00:10.000Z',
    uptimeMs: 10000,
    inflightRequests: 0,
    trackedRoutes: [],
    overview: {
      totalRequests: 1,
      successRequests: 1,
      errorRequests: 0,
      avgDurationMs: 100,
      p95DurationMs: 100,
      p99DurationMs: 100,
      maxDurationMs: 100,
      successRate: 100,
    },
    pool: null,
    endpoints: [],
    recentRequests: [
      {
        requestedAt: '2026-04-20T00:00:05.000Z',
        method: 'POST',
        path: '/render',
        statusCode: 200,
        durationMs: 100,
        errorMessage: '',
      },
    ],
  });

  assert.match(html, /is-ok/);
  assert.match(html, /成功/);
});
