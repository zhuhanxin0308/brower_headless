const test = require('node:test');
const assert = require('node:assert/strict');

const { renderDashboardHtml } = require('../dashboard');

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
