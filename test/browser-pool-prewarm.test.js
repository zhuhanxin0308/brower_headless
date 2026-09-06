const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { createBrowserPool, withPage } = require('../browser-pool');

const TEST_TIMEOUT_MS = 200;
const TEST_CLEANUP_TIMEOUT_MS = 40;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

function browserStub(options = {}) {
  const browser = new EventEmitter();
  Object.assign(browser, {
    closed: false,
    contexts: [],
    maximumOpenContexts: 0,
    isConnected() { return !this.closed; },
    async createBrowserContext() {
      const id = this.contexts.length;
      const context = {
        id,
        closed: false,
        page: Object.assign(new EventEmitter(), { id, closed: false, async close() { this.closed = true; } }),
        async newPage() { await options.beforePage?.(context); return this.page; },
        async close() {
          await options.beforeContextClose?.(context);
          this.closed = true;
          this.page.closed = true;
        },
      };
      this.contexts.push(context);
      this.maximumOpenContexts = Math.max(this.maximumOpenContexts, this.contexts.filter((value) => !value.closed).length);
      await options.beforeContext?.(context);
      return context;
    },
    async close() {
      await options.beforeBrowserClose?.();
      this.closed = true;
      for (const context of this.contexts) { context.closed = true; context.page.closed = true; }
      this.emit('disconnected');
    },
  });
  return browser;
}

function createTestPool(t, browser, options = {}) {
  const errors = [];
  const pool = createBrowserPool({
    minBrowsers: 0,
    maxBrowsers: 1,
    maxPendingAcquires: 1,
    acquireTimeoutMillis: TEST_TIMEOUT_MS,
    cleanupTimeoutMillis: TEST_CLEANUP_TIMEOUT_MS,
    launchBrowser: async () => browser,
    ...options,
  });
  pool.on('factoryCreateError', (error) => errors.push(error));
  pool.on('factoryDestroyError', (error) => errors.push(error));
  t.after(async () => { await pool.drain(); await pool.clear(); });
  return { pool, errors };
}

test('默认池在首次可借用前准备一个从未使用的独立页面', async (t) => {
  const browser = browserStub();
  const { pool } = createTestPool(t, browser, { minBrowsers: 1 });
  await pool.ready();
  assert.equal(browser.contexts.length, 1);
  assert.equal(browser.contexts[0].closed, false);
  const used = await withPage(pool, async (page, context) => {
    assert.equal(page, browser.contexts[0].page);
    return context;
  });
  assert.equal(used.closed, true);
});

test('明确关闭预热后保持按请求创建上下文的原行为', async (t) => {
  const browser = browserStub();
  const { pool } = createTestPool(t, browser, { minBrowsers: 1, prewarmPages: false });
  await pool.ready();
  assert.equal(browser.contexts.length, 0);
  await withPage(pool, async () => '业务');
  assert.equal(browser.contexts.length, 1);
  assert.equal(browser.contexts[0].closed, true);
});

test('每次只消费一个预热页面，业务结束销毁且不会复用历史上下文', async (t) => {
  const browser = browserStub();
  const { pool } = createTestPool(t, browser);
  const used = [];
  for (let index = 0; index < 4; index += 1) {
    used.push(await withPage(pool, async (page, context) => { page.emit('load'); return context; }));
  }
  assert.equal(new Set(used).size, used.length);
  assert.equal(used.every((context) => context.closed), true);
  assert.equal(browser.maximumOpenContexts, 2);
  assert.equal(browser.contexts.filter((context) => !context.closed).length, 1);
});

test('下一页面在后台准备且不会阻塞当前正常返回，等待它的请求不重复建页', async (t) => {
  const preparation = deferred();
  const started = deferred();
  const browser = browserStub({ beforePage: async (context) => {
    if (context.id === 1) { started.resolve(); await preparation.promise; }
  } });
  const { pool } = createTestPool(t, browser);
  let finished = false;
  const first = withPage(pool, async (page) => { page.emit('load'); return '首个结果'; }).then((value) => { finished = true; return value; });
  await started.promise;
  await delay(0);
  const returnedBeforePreparation = finished;
  let secondRan = false;
  const second = withPage(pool, async (page) => { secondRan = true; return page.id; });
  await delay(0);
  const countBeforePreparation = browser.contexts.length;
  const ranBeforePreparation = secondRan;
  preparation.resolve();
  assert.equal(await first, '首个结果');
  assert.equal(await second, 1);
  assert.equal(returnedBeforePreparation, true);
  assert.equal(ranBeforePreparation, false);
  assert.equal(countBeforePreparation, 2);
  assert.equal(browser.maximumOpenContexts, 2);
});

test('关闭池先等待进行中的页面初始化并关闭上下文，再关闭浏览器', async (t) => {
  const preparation = deferred();
  const started = deferred();
  let preparationFinished = false;
  let browserClosedEarly = false;
  const browser = browserStub({
    beforePage: async (context) => {
      if (context.id === 1) { started.resolve(); await preparation.promise; preparationFinished = true; }
    },
    beforeBrowserClose: () => { browserClosedEarly = !preparationFinished; },
  });
  const { pool } = createTestPool(t, browser);
  await withPage(pool, async () => '结果');
  await started.promise;
  await pool.drain();
  const clearing = pool.clear();
  await delay(0);
  assert.equal(browser.closed, false);
  preparation.resolve();
  await clearing;
  assert.equal(browserClosedEarly, false);
  assert.equal(browser.contexts.every((context) => context.closed), true);
  assert.equal(browser.contexts.length, 2);
});

test('预热失败但上下文已清理时仅降级一次并报告错误，业务仍使用隔离页面', async (t) => {
  const failure = new Error('预热页面初始化失败');
  const browser = browserStub({ beforePage: (context) => { if (context.id === 0) throw failure; } });
  const { pool, errors } = createTestPool(t, browser);
  const first = await withPage(pool, async (page) => page.id);
  const second = await withPage(pool, async (page) => page.id);
  assert.equal(first, 1);
  assert.equal(second, 2);
  assert.equal(browser.contexts.every((context) => context.closed), true);
  assert.equal(browser.maximumOpenContexts, 1);
  assert.deepEqual(errors, [failure]);
});

test('后台补充失败被观察且不会影响已完成业务或无限重试', async (t) => {
  const preparation = deferred();
  const started = deferred();
  const failure = new Error('后台补充失败');
  const browser = browserStub({ beforePage: async (context) => {
    if (context.id === 1) { started.resolve(); await preparation.promise; }
  } });
  const { pool, errors } = createTestPool(t, browser);
  assert.equal(await withPage(pool, async () => '已完成业务'), '已完成业务');
  await started.promise;
  preparation.reject(failure);
  await delay(0);
  assert.equal(browser.contexts[1].closed, true);
  assert.deepEqual(errors, [failure]);
  assert.equal(await withPage(pool, async (page) => page.id), 2);
  assert.equal(browser.contexts.length, 3);
});

test('取消等待补充页面时保留取消原因并等待迟到准备清理后淘汰浏览器', async (t) => {
  const preparation = deferred();
  const started = deferred();
  const browser = browserStub({ beforePage: async (context) => {
    if (context.id === 1) { started.resolve(); await preparation.promise; }
  } });
  const { pool } = createTestPool(t, browser);
  await withPage(pool, async () => '第一请求');
  await started.promise;
  const controller = new AbortController();
  const reason = Object.assign(new Error('客户端断连'), { statusCode: 499 });
  const cancelled = withPage(pool, async () => assert.fail('取消请求不能执行业务'), { signal: controller.signal });
  await delay(0);
  controller.abort(reason);
  await delay(0);
  const closedBeforePreparation = browser.closed;
  preparation.resolve();
  await assert.rejects(cancelled, (error) => error === reason);
  assert.equal(closedBeforePreparation, false);
  assert.equal(browser.closed, true);
  assert.equal(browser.contexts.every((context) => context.closed), true);
  assert.equal(pool.borrowed, 0);
});

test('执行期间取消关闭业务上下文，尚未使用的预热页面仍可独立服务后续请求', async (t) => {
  const running = deferred();
  const started = deferred();
  const browser = browserStub();
  const { pool } = createTestPool(t, browser);
  const controller = new AbortController();
  const reason = new Error('终止业务');
  const cancelled = withPage(pool, async () => { started.resolve(); return running.promise; }, { signal: controller.signal });
  await started.promise;
  controller.abort(reason);
  await assert.rejects(cancelled, (error) => error === reason);
  running.resolve();
  assert.equal(browser.contexts[0].closed, true);
  assert.equal(await withPage(pool, async (page) => page.id), 1);
  assert.equal(browser.closed, false);
});

test('预热期间断连会停止补充并关闭迟到资源', async (t) => {
  const preparation = deferred();
  const started = deferred();
  const browser = browserStub({ beforePage: async (context) => {
    if (context.id === 1) { started.resolve(); await preparation.promise; }
  } });
  const { pool } = createTestPool(t, browser);
  await withPage(pool, async () => '业务');
  await started.promise;
  browser.closed = true;
  browser.emit('disconnected');
  preparation.resolve();
  await delay(0);
  assert.equal(browser.contexts[1].closed, true);
  assert.equal(browser.contexts.length, 2);
});

test('预热配置必须为布尔值，防止字符串false被误启用', () => {
  for (const prewarmPages of ['false', 0, null, {}]) {
    assert.throws(() => createBrowserPool({ prewarmPages, launchBrowser: () => assert.fail('不能启动') }), TypeError);
  }
});

test('预热创建上下文失败时无残留页面，下一请求退回独立创建流程', async (t) => {
  const browser = browserStub();
  const originalCreate = browser.createBrowserContext;
  const failure = new Error('创建预热上下文失败');
  let creates = 0;
  browser.createBrowserContext = function createContext() {
    if (++creates === 1) return Promise.reject(failure);
    return originalCreate.call(this);
  };
  const { pool, errors } = createTestPool(t, browser);
  assert.equal(await withPage(pool, async (page) => page.id), 0);
  assert.deepEqual(errors, [failure]);
  assert.equal(browser.contexts.length, 1);
});

test('初次预热失败且上下文不能清理时不进入业务并淘汰，后续请求能恢复', async (t) => {
  const failure = new Error('创建页面失败');
  const cleanupFailure = new Error('预热上下文清理失败');
  const damaged = browserStub({
    beforePage: () => { throw failure; },
    beforeContextClose: () => { throw cleanupFailure; },
  });
  const healthy = browserStub();
  let launches = 0;
  const { pool, errors } = createTestPool(t, damaged, { launchBrowser: async () => ++launches === 1 ? damaged : healthy });
  await assert.rejects(withPage(pool, async () => assert.fail('污染上下文不能执行业务')), (error) => error === failure);
  assert.equal(failure.cleanupError, cleanupFailure);
  assert.equal(damaged.closed, true);
  assert.equal(pool.borrowed, 0);
  assert.equal(await withPage(pool, async () => '新浏览器恢复'), '新浏览器恢复');
  assert.equal(launches, 2);
  assert.equal(errors.includes(failure), true);
});

test('业务期间后台预热清理失败不得中断当前业务，业务收尾后再关闭浏览器', async (t) => {
  const preparation = deferred();
  const running = deferred();
  const started = deferred();
  const failure = new Error('后台建页失败');
  const browser = browserStub({
    beforePage: async (context) => { if (context.id === 1) await preparation.promise; },
    beforeContextClose: (context) => { if (context.id === 1) throw new Error('后台上下文清理失败'); },
  });
  const { pool } = createTestPool(t, browser);
  const task = withPage(pool, async (page) => { page.emit('load'); started.resolve(); await running.promise; return '业务完成'; });
  await started.promise;
  preparation.reject(failure);
  await delay(0);
  assert.equal(browser.closed, false);
  assert.equal(browser.contexts[0].closed, false);
  running.resolve();
  await assert.rejects(task, (error) => error === failure);
  assert.equal(browser.contexts[0].closed, true);
  assert.equal(browser.closed, true);
  assert.equal(pool.borrowed, 0);
});

test('空闲期间后台预热清理失败立即关闭浏览器且不在后台循环补建', async (t) => {
  const preparation = deferred();
  const browser = browserStub({
    beforePage: async (context) => { if (context.id === 1) await preparation.promise; },
    beforeContextClose: (context) => { if (context.id === 1) throw new Error('空闲预热资源清理失败'); },
  });
  let launches = 0;
  const { pool, errors } = createTestPool(t, browser, { launchBrowser: async () => { launches += 1; return browser; } });
  await withPage(pool, async () => '已经返回');
  preparation.reject(new Error('空闲补充失败'));
  await delay(0);
  assert.equal(browser.closed, true);
  assert.equal(launches, 1);
  assert.equal(errors.length, 1);
});

test('关闭时上下文仍在创建则等待迟到上下文并关闭，不再创建页面', async (t) => {
  const creation = deferred();
  const started = deferred();
  let latePages = 0;
  const browser = browserStub({
    beforeContext: async (context) => { if (context.id === 1) { started.resolve(); await creation.promise; } },
    beforePage: (context) => { if (context.id === 1) latePages += 1; },
  });
  const { pool } = createTestPool(t, browser);
  await withPage(pool, async () => '业务');
  await started.promise;
  await pool.drain();
  const clearing = pool.clear();
  await delay(0);
  creation.resolve();
  await clearing;
  assert.equal(browser.closed, true);
  assert.equal(browser.contexts[1].closed, true);
  assert.equal(latePages, 0);
});

test('排空后已有队列仍可完成，但取走预热页面后不再补充', async (t) => {
  const browser = browserStub();
  const { pool } = createTestPool(t, browser);
  const acquired = await pool.acquire();
  const queued = withPage(pool, async (page) => page.id);
  await delay(0);
  const draining = pool.drain();
  await pool.release(acquired);
  assert.equal(await queued, 0);
  await draining;
  assert.equal(browser.contexts.length, 1);
  assert.equal(browser.contexts[0].closed, true);
});

test('预热初始化永久挂起时有界终止本浏览器子进程，迟到上下文仍被观察和清理', async (t) => {
  const creation = deferred();
  const started = deferred();
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  const browser = browserStub({ beforeContext: async () => { started.resolve(); await creation.promise; } });
  browser.process = () => child;
  child.kill = (signal) => {
    assert.equal(signal, 'SIGKILL');
    browser.closed = true;
    child.signalCode = signal;
    queueMicrotask(() => child.emit('exit', null, signal));
    return true;
  };
  const { pool, errors } = createTestPool(t, browser, { acquireTimeoutMillis: TEST_CLEANUP_TIMEOUT_MS });
  const task = withPage(pool, async () => assert.fail('初始化未完成不能执行'));
  await started.promise;
  await assert.rejects(task, (error) => error.statusCode === 503);
  await delay(TEST_CLEANUP_TIMEOUT_MS * 3);
  assert.equal(child.signalCode, 'SIGKILL');
  assert.equal(errors.some((error) => error.message === '预热页面初始化超时'), true);
  creation.resolve();
  await delay(0);
  assert.equal(browser.contexts[0].closed, true);
  assert.equal(pool.borrowed, 0);
});

test('没有子进程句柄时初始化悬挂仍尝试关闭浏览器且清理迟到页面', async (t) => {
  const preparation = deferred();
  let browserCloses = 0;
  const browser = browserStub({
    beforePage: async (context) => { if (context.id === 1) await preparation.promise; },
    beforeBrowserClose: () => { browserCloses += 1; },
  });
  const { pool, errors } = createTestPool(t, browser);
  await withPage(pool, async () => '业务');
  await pool.drain();
  await pool.clear();
  assert.equal(browser.closed, true);
  await delay(TEST_TIMEOUT_MS);
  assert.equal(errors.length, 0, '主动关闭后不应残留预热计时器再报告初始化超时');
  preparation.resolve();
  await delay(0);
  assert.equal(browser.contexts.every((context) => context.closed), true);
  assert.equal(browserCloses, 1, '已经有界关闭后，迟到初始化不能再重复关闭浏览器');
});

test('预热抛出null且清理失败时仍保持失败关闭，不能把空值误当作安全状态', async (t) => {
  const browser = browserStub({
    beforePage: () => { throw null; },
    beforeContextClose: () => { throw new Error('清理失败'); },
  });
  const { pool } = createTestPool(t, browser);
  const result = await withPage(pool, async () => assert.fail('不能执行业务')).then(
    () => ({ success: true }),
    (error) => ({ success: false, error }),
  );
  assert.deepEqual(result, { success: false, error: null });
  assert.equal(browser.closed, true);
  assert.equal(pool.borrowed, 0);
});

test('取走预热页面后等待业务load再补充，多次load和业务结束不会重复创建', async (t) => {
  const running = deferred();
  const started = deferred();
  let activePage;
  const browser = browserStub();
  const { pool } = createTestPool(t, browser);
  const task = withPage(pool, async (page) => { activePage = page; started.resolve(); await running.promise; });
  await started.promise;
  await delay(0);
  const contextsBeforeLoad = browser.contexts.length;
  activePage.emit('load');
  activePage.emit('load');
  await delay(0);
  const contextsAfterLoad = browser.contexts.length;
  running.resolve();
  await task;
  assert.equal(contextsBeforeLoad, 1, '页面导航前不应启动会与业务争用资源的下一份初始化');
  assert.equal(contextsAfterLoad, 2);
  assert.equal(browser.contexts.length, 2);
  assert.equal(activePage.listenerCount('load'), 0);
});

test('业务没有导航时在上下文关闭后补充，load监听器随业务结束移除', async (t) => {
  const browser = browserStub();
  const { pool } = createTestPool(t, browser);
  const page = await withPage(pool, async (value) => value);
  assert.equal(browser.maximumOpenContexts, 1);
  assert.equal(browser.contexts.length, 2);
  assert.equal(page.listenerCount('load'), 0);
  page.emit('load');
  await delay(0);
  assert.equal(browser.contexts.length, 2);
});
