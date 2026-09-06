const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { createBrowserPool, withPage } = require('../browser-pool');
const { createInitializationPlugin } = require('../browser-initialization');

function deferred() {
  let resolve;
  const promise = new Promise((onResolve) => { resolve = onResolve; });
  return { promise, resolve };
}

function fixture(t, onPageCreated, options = {}) {
  const browser = Object.assign(new EventEmitter(), {
    closed: false,
    contexts: [],
    isConnected() { return !this.closed; },
    async close() { this.closed = true; },
    async createBrowserContext() {
      const context = { closed: false, async close() { this.closed = true; } };
      const page = Object.assign(new EventEmitter(), {
        id: this.contexts.length,
        browser: () => browser,
        browserContext: () => context,
      });
      context.newPage = async () => page;
      this.contexts.push(context);
      return context;
    },
  });
  const extra = { plugins: [{ name: '测试预加载', onPageCreated }] };
  const initialization = createInitializationPlugin(extra);
  extra.plugins.push(initialization);
  initialization.beforeLaunch({});
  initialization.onBrowser(browser);
  const pool = createBrowserPool({ minBrowsers: 0, maxBrowsers: 1, launchBrowser: async () => browser, ...options });
  t.after(async () => { await pool.drain(); await pool.clear(); });
  return { browser, pool };
}

test('预热newPage已返回时仍等待插件实际命令完成，才允许业务拿到页面', async (t) => {
  const command = deferred();
  const started = deferred();
  const { browser, pool } = fixture(t, async (page) => { if (page.id === 0) { started.resolve(); await command.promise; } });
  let businessRan = false;
  const task = withPage(pool, async () => { businessRan = true; return '完成'; });
  await started.promise;
  await nextTurn();
  const deliveredEarly = businessRan;
  command.resolve();
  assert.equal(await task, '完成');
  assert.equal(deliveredEarly, false);
  assert.equal(browser.contexts[0].closed, true);
});

test('load后补充的页面已返回但插件命令未完成时，clear不会提前关闭其上下文', async (t) => {
  const command = deferred();
  const started = deferred();
  const { browser, pool } = fixture(t, async (page) => { if (page.id === 1) { started.resolve(); await command.promise; } });
  await withPage(pool, async (page) => page.emit('load'));
  await started.promise;
  await pool.drain();
  const clearing = pool.clear();
  await nextTurn();
  const closedEarly = browser.contexts[1].closed || browser.closed;
  command.resolve();
  await clearing;
  assert.equal(closedEarly, false);
  assert.equal(browser.contexts[1].closed, true);
  assert.equal(browser.closed, true);
});

test('旧的按需创建模式同样等待插件完成，并在初始化期间取消时保留原因和资源隔离', async (t) => {
  const command = deferred();
  const started = deferred();
  const { browser, pool } = fixture(t, async () => { started.resolve(); await command.promise; }, { prewarmPages: false });
  const controller = new AbortController();
  const reason = Object.assign(new Error('初始化期间客户端断开'), { statusCode: 499 });
  const task = withPage(pool, async () => assert.fail('取消后不能执行业务'), { signal: controller.signal });
  await started.promise;
  controller.abort(reason);
  await nextTurn();
  const closedEarly = browser.contexts[0].closed;
  command.resolve();
  await assert.rejects(task, (error) => error === reason);
  assert.equal(closedEarly, false);
  assert.equal(browser.contexts[0].closed, true);
  assert.equal(browser.closed, true);
  assert.equal(pool.borrowed, 0);
});
