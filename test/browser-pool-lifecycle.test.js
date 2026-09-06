const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { createBrowserPool, withPage } = require('../browser-pool');

const TEST_CLEANUP_TIMEOUT_MS = 20;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function abortReason() {
  return Object.assign(new Error('请求总时限已到'), { statusCode: 504 });
}

function createBrowser(overrides = {}) {
  const browser = {
    closed: false,
    contexts: [],
    isConnected() { return !this.closed; },
    async createBrowserContext() {
      const context = {
        closed: false,
        async newPage() { return { title: '隔离页面' }; },
        async close() { this.closed = true; },
      };
      this.contexts.push(context);
      return context;
    },
    async close() {
      this.closed = true;
      for (const context of this.contexts) {
        context.closed = true;
      }
    },
    ...overrides,
  };
  return browser;
}

function createTestPool(t, options = {}) {
  const launched = [];
  const pool = createBrowserPool({
    minBrowsers: 0,
    maxBrowsers: 1,
    maxPendingAcquires: 1,
    acquireTimeoutMillis: 100,
    cleanupTimeoutMillis: TEST_CLEANUP_TIMEOUT_MS,
    launchBrowser: async () => {
      const browser = createBrowser();
      launched.push(browser);
      return browser;
    },
    ...options,
  });
  t.after(async () => {
    await pool.drain();
    await pool.clear();
  });
  return { pool, launched };
}

test('真实浏览器池严格限制等待数，过载后仍能恢复借用', async (t) => {
  const { pool } = createTestPool(t);
  const borrowed = await pool.acquire();
  const queued = withPage(pool, async () => '排队请求');
  await assert.rejects(withPage(pool, async () => '不应执行'), (error) => error.statusCode === 503);
  assert.equal(pool.pending, 1);
  await pool.release(borrowed);
  assert.equal(await queued, '排队请求');
  assert.equal(await withPage(pool, async () => '恢复'), '恢复');
  assert.equal(pool.borrowed, 0);
});

test('浏览器获取超时转换为503且超时后仍可处理请求', async (t) => {
  const { pool } = createTestPool(t, { acquireTimeoutMillis: 20 });
  const browser = await pool.acquire();
  await assert.rejects(withPage(pool, async () => '不应执行'), (error) => error.statusCode === 503);
  await pool.release(browser);
  assert.equal(await withPage(pool, async () => '恢复'), '恢复');
});

test('取消排队及时返回原始原因，迟到借用资源最终归还', async (t) => {
  const { pool } = createTestPool(t);
  const borrowed = await pool.acquire();
  const controller = new AbortController();
  const reason = abortReason();
  const cancelled = withPage(pool, async () => assert.fail('已取消请求不能执行'), { signal: controller.signal });
  await delay(0);
  assert.equal(pool.pending, 1);
  controller.abort(reason);
  await assert.rejects(cancelled, (error) => error === reason);
  const pendingAfterAbort = pool.pending;
  const replacement = withPage(pool, async () => '替代请求').then((value) => ({ value }), (error) => ({ error }));
  await pool.release(borrowed);
  const replacementResult = await replacement;
  assert.equal(pendingAfterAbort, 0, '取消必须立刻腾出真实等待容量');
  assert.equal(replacementResult.value, '替代请求');
  assert.equal(pool.borrowed, 0);
  assert.equal(await withPage(pool, async () => '可再次借用'), '可再次借用');
});

test('开始时已经取消不会进入池队列', async () => {
  const controller = new AbortController();
  const reason = abortReason();
  controller.abort(reason);
  await assert.rejects(withPage({ acquire() { assert.fail('不能借用'); } }, () => {}, {
    signal: controller.signal,
  }), (error) => error === reason);
});

test('创建上下文期间取消会淘汰浏览器并关闭迟到上下文', async (t) => {
  const creation = deferred();
  const started = deferred();
  const context = { closed: false, async close() { this.closed = true; } };
  const browser = createBrowser({
    async createBrowserContext() { started.resolve(); return creation.promise; },
  });
  const { pool } = createTestPool(t, { launchBrowser: async () => browser });
  const controller = new AbortController();
  const reason = abortReason();
  const task = withPage(pool, async () => assert.fail('不能创建页面'), { signal: controller.signal });
  await started.promise;
  controller.abort(reason);
  await assert.rejects(task, (error) => error === reason);
  assert.equal(browser.closed, true);
  assert.equal(pool.borrowed, 0);
  creation.resolve(context);
  await delay(0);
  assert.equal(context.closed, true);
});

test('创建页面期间取消会关闭上下文、淘汰浏览器并关闭迟到页面', async (t) => {
  const creation = deferred();
  const started = deferred();
  const page = { closed: false, async close() { this.closed = true; } };
  const context = {
    closed: false,
    async newPage() { started.resolve(); return creation.promise; },
    async close() { this.closed = true; },
  };
  const browser = createBrowser({ async createBrowserContext() { return context; } });
  const { pool } = createTestPool(t, { launchBrowser: async () => browser });
  const controller = new AbortController();
  const reason = abortReason();
  const task = withPage(pool, async () => assert.fail('不能执行任务'), { signal: controller.signal });
  await started.promise;
  controller.abort(reason);
  await assert.rejects(task, (error) => error === reason);
  assert.equal(context.closed, true);
  assert.equal(browser.closed, true);
  creation.resolve(page);
  await delay(0);
  assert.equal(page.closed, true);
  assert.equal(pool.borrowed, 0);
});

test('执行期间取消先关闭上下文终止页面工作，再释放浏览器', async (t) => {
  const started = deferred();
  const running = deferred();
  const context = {
    closed: false,
    async newPage() { return {}; },
    async close() { this.closed = true; running.reject(new Error('页面已关闭')); },
  };
  const browser = createBrowser({ async createBrowserContext() { return context; } });
  const { pool } = createTestPool(t, { launchBrowser: async () => browser });
  const controller = new AbortController();
  const reason = abortReason();
  const task = withPage(pool, async () => { started.resolve(); return running.promise; }, { signal: controller.signal });
  await started.promise;
  controller.abort(reason);
  await assert.rejects(task, (error) => error === reason);
  assert.equal(context.closed, true);
  assert.equal(pool.borrowed, 0);
  assert.equal(pool.available, 1);
});

test('上下文关闭失败时销毁浏览器而不复用污染实例', async (t) => {
  const damaged = createBrowser({
    async createBrowserContext() {
      return { async newPage() { return {}; }, async close() { throw new Error('上下文关闭失败'); } };
    },
  });
  let launches = 0;
  const { pool } = createTestPool(t, { launchBrowser: async () => launches++ === 0 ? damaged : createBrowser() });
  await assert.rejects(withPage(pool, async () => '业务结果'), /上下文关闭失败/);
  assert.equal(damaged.closed, true);
  assert.equal(pool.borrowed, 0);
  assert.equal(await withPage(pool, async () => '恢复'), '恢复');
  assert.equal(launches, 2);
});

test('上下文关闭永久挂起时有界淘汰浏览器并恢复容量', async (t) => {
  const damaged = createBrowser({
    async createBrowserContext() {
      return { async newPage() { return {}; }, close() { return new Promise(() => {}); } };
    },
  });
  const { pool } = createTestPool(t, { launchBrowser: async () => damaged });
  await assert.rejects(withPage(pool, async () => '业务结果', {
    cleanupTimeoutMillis: TEST_CLEANUP_TIMEOUT_MS,
  }), /清理超时/);
  assert.equal(damaged.closed, true);
  assert.equal(pool.borrowed, 0);
});

test('浏览器close挂起时只终止该浏览器子进程并等待退出', async (t) => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  let killed = false;
  child.kill = (signal) => {
    assert.equal(signal, 'SIGKILL');
    killed = true;
    queueMicrotask(() => { child.signalCode = signal; child.emit('exit', null, signal); });
    return true;
  };
  const browser = createBrowser({ close() { return new Promise(() => {}); }, process() { return child; } });
  const { pool } = createTestPool(t, { launchBrowser: async () => browser });
  const acquired = await pool.acquire();
  await pool.destroy(acquired);
  await pool.clear();
  assert.equal(killed, true);
  assert.equal(child.signalCode, 'SIGKILL');
});

test('软空闲回收保留最少预热浏览器并缩减多余实例', async (t) => {
  const { pool, launched } = createTestPool(t, {
    minBrowsers: 1,
    maxBrowsers: 2,
    softIdleTimeoutMillis: 10,
    evictionRunIntervalMillis: 5,
  });
  await pool.ready();
  const first = await pool.acquire();
  const second = await pool.acquire();
  await pool.release(first);
  await pool.release(second);
  await delay(40);
  assert.equal(pool.size, 1);
  assert.equal(launched.length, 2);
  assert.equal(launched.filter((browser) => !browser.closed).length, 1);
});

test('超过原硬回收时间后最小预热容量不会被销毁重建', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const { pool, launched } = createTestPool(t, { minBrowsers: 1 });
  await delay(0);
  await pool.ready();
  t.mock.timers.tick(120_000);
  await Promise.resolve();
  assert.equal(pool.size, 1);
  assert.equal(launched.length, 1);
  assert.equal(launched[0].closed, false);
  t.mock.timers.reset();
});
