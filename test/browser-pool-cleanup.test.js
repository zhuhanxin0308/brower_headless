const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { createPool } = require('generic-pool');
const { closeBrowser, withPage } = require('../browser-page');

const TEST_CLEANUP_TIMEOUT_MS = 20;

function deferred() {
  let resolve;
  const promise = new Promise((onResolve) => { resolve = onResolve; });
  return { promise, resolve };
}

function stubBrowser(overrides = {}) {
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

test('关闭失败但浏览器子进程已退出时不会向其他进程发送终止信号', async () => {
  const browser = stubBrowser({
    async close() { throw new Error('连接已断开'); },
    process() { return { exitCode: 0, kill() { assert.fail('已退出子进程不能再终止'); } }; },
  });
  await closeBrowser(browser);
});

test('无法终止子进程时返回明确失败并移除退出监听器', async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => false;
  const browser = stubBrowser({ async close() { throw new Error('关闭失败'); }, process() { return child; } });
  await assert.rejects(closeBrowser(browser), /无法终止浏览器子进程/);
  assert.equal(child.listenerCount('exit'), 0);
  assert.equal(child.listenerCount('error'), 0);
});

test('终止子进程抛错时保留系统错误且关闭任务不会重复终止', async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  const failure = new Error('没有终止子进程的权限');
  let attempts = 0;
  child.kill = () => { attempts += 1; throw failure; };
  const browser = stubBrowser({ async close() { throw new Error('关闭失败'); }, process() { return child; } });
  await assert.rejects(closeBrowser(browser), (error) => error === failure);
  await assert.rejects(closeBrowser(browser), (error) => error === failure);
  assert.equal(attempts, 1);
});

test('无本地子进程且浏览器已经断开时关闭失败可安全完成', async () => {
  const browser = stubBrowser({ closed: true, async close() { throw new Error('目标已关闭'); } });
  await closeBrowser(browser);
});

test('兼容没有取消接口的原始池，取消后的迟到借用最终归还', async () => {
  const browser = stubBrowser();
  const pool = createPool({ create: async () => browser, destroy: (resource) => resource.close() }, {
    min: 0, max: 1, acquireTimeoutMillis: 500, maxWaitingClients: 1,
  });
  const borrowed = await pool.acquire();
  const controller = new AbortController();
  const task = withPage(pool, async () => assert.fail('取消请求不能执行'), { signal: controller.signal });
  await delay(0);
  controller.abort(new Error('请求取消'));
  await assert.rejects(task, /请求取消/);
  await pool.release(borrowed);
  await delay(0);
  assert.equal(pool.borrowed, 0);
  await pool.drain();
  await pool.clear();
});

test('归还浏览器失败时销毁资源并保留原始归还错误', async () => {
  const browser = stubBrowser();
  const failure = new Error('浏览器归还登记失败');
  let destroyed = false;
  const pool = {
    async acquire() { return browser; },
    async release() { throw failure; },
    async destroy(value) { assert.equal(value, browser); destroyed = true; },
  };
  await assert.rejects(withPage(pool, async () => '结果'), (error) => error === failure);
  assert.equal(destroyed, true);
  assert.equal(browser.closed, true);
});

test('池销毁登记失败仍关闭实际浏览器并报告清理失败', async () => {
  const controller = new AbortController();
  const started = deferred();
  const browser = stubBrowser({
    createBrowserContext() { started.resolve(); return new Promise(() => {}); },
  });
  const failure = new Error('池销毁登记失败');
  const events = [];
  const pool = {
    async acquire() { return browser; },
    async destroy() { throw failure; },
    emit(name, error) { events.push({ name, error }); },
  };
  const reason = new Error('总时限已到');
  const task = withPage(pool, async () => {}, { signal: controller.signal });
  await started.promise;
  controller.abort(reason);
  await assert.rejects(task, (error) => error === reason);
  assert.equal(browser.closed, true);
  assert.deepEqual(events, [{ name: 'factoryDestroyError', error: failure }]);
});

test('取消后迟到上下文清理失败通过池事件报告', async () => {
  const creation = deferred();
  const started = deferred();
  const browser = stubBrowser({
    createBrowserContext() { started.resolve(); return creation.promise; },
  });
  const events = [];
  const pool = {
    async acquire() { return browser; },
    async destroy() {},
    emit(name, error) { events.push({ name, error }); },
  };
  const controller = new AbortController();
  const task = withPage(pool, () => {}, { signal: controller.signal });
  await started.promise;
  controller.abort(new Error('取消'));
  await assert.rejects(task, /取消/);
  const failure = new Error('迟到上下文无法关闭');
  creation.resolve({ async close() { throw failure; } });
  await delay(0);
  assert.deepEqual(events, [{ name: 'factoryDestroyError', error: failure }]);
});

test('业务结束后的清理阶段取消仍返回取消原因而非过期结果', async () => {
  const closing = deferred();
  const closeStarted = deferred();
  const browser = stubBrowser({
    async createBrowserContext() {
      return { async newPage() { return {}; }, close() { closeStarted.resolve(); return closing.promise; } };
    },
  });
  let released = false;
  const pool = { async acquire() { return browser; }, async release() { released = true; } };
  const controller = new AbortController();
  const task = withPage(pool, async () => '已经过期', { signal: controller.signal });
  await closeStarted.promise;
  const reason = Object.assign(new Error('总时限已到'), { statusCode: 504 });
  controller.abort(reason);
  closing.resolve();
  await assert.rejects(task, (error) => error === reason);
  assert.equal(released, true);
});

test('上下文关闭超时会淘汰浏览器且业务错误仍保留', async () => {
  const failure = new Error('页面执行失败');
  const browser = stubBrowser({
    async createBrowserContext() {
      return { async newPage() { return {}; }, close() { return new Promise(() => {}); } };
    },
  });
  const pool = { async acquire() { return browser; }, async destroy() {} };
  await assert.rejects(withPage(pool, async () => { throw failure; }, {
    cleanupTimeoutMillis: TEST_CLEANUP_TIMEOUT_MS,
  }), (error) => error === failure);
  assert.equal(browser.closed, true);
});
