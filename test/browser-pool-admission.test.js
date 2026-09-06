const test = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { createBrowserPool, withPage } = require('../browser-pool');

function deferred() {
  let resolve;
  const promise = new Promise((onResolve) => { resolve = onResolve; });
  return { promise, resolve };
}

function browserStub(overrides = {}) {
  return {
    closed: false,
    isConnected() { return !this.closed; },
    async close() { this.closed = true; },
    async createBrowserContext() {
      return { async newPage() { return {}; }, async close() {} };
    },
    ...overrides,
  };
}

function testPool(t, options = {}) {
  const browsers = [];
  const pool = createBrowserPool({
    minBrowsers: 0,
    maxBrowsers: 1,
    maxPendingAcquires: 1,
    acquireTimeoutMillis: 500,
    launchBrowser: async () => {
      const browser = browserStub();
      browsers.push(browser);
      return browser;
    },
    ...options,
  });
  t.after(async () => {
    await pool.drain();
    await pool.clear();
  });
  return { pool, browsers };
}

test('冷启动并发不受较小业务等待额度影响', async (t) => {
  const creation = deferred();
  let created = 0;
  const { pool } = testPool(t, {
    maxBrowsers: 3,
    maxPendingAcquires: 1,
    launchBrowser: async () => { created += 1; await creation.promise; return browserStub(); },
  });
  const initial = [pool.acquire(), pool.acquire(), pool.acquire()];
  const waiting = pool.acquire();
  await assert.rejects(pool.acquire(), (error) => error.statusCode === 503);
  creation.resolve();
  const borrowed = await Promise.all(initial);
  assert.equal(created, 3);
  assert.equal(pool.pending, 1);
  await pool.release(borrowed[0]);
  const afterQueue = await waiting;
  await Promise.all([pool.release(borrowed[1]), pool.release(borrowed[2]), pool.release(afterQueue)]);
  assert.equal(pool.borrowed, 0);
});

test('零等待额度允许立即借用并拒绝需要排队的请求', async (t) => {
  const { pool } = testPool(t, { maxPendingAcquires: 0 });
  const browser = await pool.acquire();
  await assert.rejects(pool.acquire(), (error) => error.statusCode === 503);
  assert.equal(pool.pending, 0);
  await pool.release(browser);
  const reused = await pool.acquire();
  assert.equal(reused, browser);
  await pool.release(reused);
});

test('取消中间等待请求不破坏其余请求的FIFO顺序', async (t) => {
  const { pool } = testPool(t, { maxPendingAcquires: 3 });
  const first = await pool.acquire();
  const controller = new AbortController();
  const order = [];
  const left = pool.acquire().then((browser) => { order.push('前'); return browser; });
  const cancelled = pool.acquireForRequest(controller.signal);
  const right = pool.acquire().then((browser) => { order.push('后'); return browser; });
  controller.abort(new Error('取消中间请求'));
  await assert.rejects(cancelled, /取消中间请求/);
  assert.equal(pool.pending, 2);
  await pool.release(first);
  await pool.release(await left);
  await pool.release(await right);
  assert.deepEqual(order, ['前', '后']);
});

test('排队超时立即清除等待项且不占用后续等待额度', async (t) => {
  const { pool } = testPool(t, { acquireTimeoutMillis: 20 });
  const first = await pool.acquire();
  await assert.rejects(pool.acquire(), (error) => error.statusCode === 503);
  assert.equal(pool.pending, 0);
  const next = pool.acquire();
  await pool.release(first);
  await pool.release(await next);
});

test('取消浏览器启动等待后迟到实例被归还，下一请求继续执行', async (t) => {
  const creation = deferred();
  const started = deferred();
  const browser = browserStub();
  const { pool } = testPool(t, {
    launchBrowser: async () => { started.resolve(); await creation.promise; return browser; },
  });
  const controller = new AbortController();
  const reason = Object.assign(new Error('调用方已离开'), { statusCode: 499 });
  const cancelled = withPage(pool, async () => assert.fail('取消后不能执行页面操作'), { signal: controller.signal });
  await started.promise;
  controller.abort(reason);
  await assert.rejects(cancelled, (error) => error === reason);
  const next = withPage(pool, async () => '后续请求完成');
  creation.resolve();
  assert.equal(await next, '后续请求完成');
  assert.equal(pool.borrowed, 0);
  assert.equal(pool.pending, 0);
});

test('取消原因即使是null也不会被当成借用成功', async (t) => {
  const { pool } = testPool(t);
  const borrowed = await pool.acquire();
  const controller = new AbortController();
  const cancelled = pool.acquireForRequest(controller.signal).then(
    () => ({ resolved: true }),
    (reason) => ({ resolved: false, reason }),
  );
  controller.abort(null);
  await pool.release(borrowed);
  assert.deepEqual(await cancelled, { resolved: false, reason: null });
});

test('排空期间完成已有排队请求并拒绝新请求', async (t) => {
  const { pool } = testPool(t);
  const first = await pool.acquire();
  const waiting = pool.acquire();
  const drained = pool.drain();
  await assert.rejects(pool.acquire(), (error) => error.statusCode === 503);
  await pool.release(first);
  await pool.release(await waiting);
  await drained;
  assert.equal(pool.pending, 0);
  assert.equal(pool.borrowed, 0);
});

test('失联浏览器被验证淘汰后自动创建可用替代实例', async (t) => {
  let created = 0;
  const damaged = browserStub({ isConnected() { throw new Error('连接句柄已损坏'); } });
  const healthy = browserStub();
  const { pool } = testPool(t, { launchBrowser: async () => created++ === 0 ? damaged : healthy });
  const browser = await pool.acquire();
  assert.equal(browser, healthy);
  assert.equal(damaged.closed, true);
  await pool.release(browser);
});

test('适配器保留资源销毁失败事件且排空显式报告被隔离资源', async () => {
  const failure = new Error('浏览器关闭失败');
  const browser = browserStub({ async close() { throw failure; } });
  const pool = createBrowserPool({ minBrowsers: 0, maxBrowsers: 1, launchBrowser: async () => browser });
  const errors = [];
  pool.on('factoryDestroyError', (error) => errors.push(error));
  const borrowed = await pool.acquire();
  await assert.rejects(pool.destroy(borrowed), (error) => error === failure);
  await assert.rejects(pool.drain(), (error) => error === failure);
  await pool.clear();
  assert.equal(pool.isBorrowedResource(borrowed), true, '未确认关闭的实例必须保持隔离');
  assert.deepEqual(errors, [failure]);
});

test('无效池配置在创建资源前被拒绝，避免无界排队或计时器溢出', () => {
  for (const options of [
    { maxBrowsers: 0 },
    { maxBrowsers: 1.5 },
    { maxBrowsers: NaN },
    { maxBrowsers: Infinity },
    { minBrowsers: -1 },
    { minBrowsers: 2, maxBrowsers: 1 },
    { maxPendingAcquires: -1 },
    { maxPendingAcquires: Infinity },
    { maxPendingAcquires: 1.5 },
    { acquireTimeoutMillis: 0 },
    { cleanupTimeoutMillis: 2 ** 31 },
    { softIdleTimeoutMillis: -1 },
    { evictionRunIntervalMillis: NaN },
  ]) {
    assert.throws(() => createBrowserPool({ launchBrowser: () => assert.fail('不能启动浏览器'), ...options }), RangeError);
  }
});

test('取消发生在借用微任务开始前时不会创建浏览器', async (t) => {
  const { pool, browsers } = testPool(t);
  const controller = new AbortController();
  const cancelled = pool.acquireForRequest(controller.signal);
  controller.abort(new Error('即时取消'));
  await assert.rejects(cancelled, /即时取消/);
  await delay(0);
  assert.equal(browsers.length, 0);
  assert.equal(pool.borrowed, 0);
  assert.equal(await withPage(pool, async () => '恢复'), '恢复');
});
