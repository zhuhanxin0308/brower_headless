const test = require('node:test');
const assert = require('node:assert/strict');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { createInitializationPlugin, waitForPageInitialization, stopContextInitialization, stopBrowserInitialization } = require('../browser-initialization');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

function fixture(hooks) {
  const browser = {};
  const context = {};
  const page = { browser: () => browser, browserContext: () => context };
  const extra = { plugins: hooks };
  const plugin = createInitializationPlugin(extra);
  extra.plugins.push(plugin);
  plugin.beforeLaunch({});
  plugin.onBrowser(browser);
  return { browser, context, page, plugin };
}

test('公开hook自动事件与主动初始化共享每页每插件的一次调用', async () => {
  const pending = deferred();
  let calls = 0;
  const hook = { name: '测试插件', onPageCreated: () => { calls += 1; return pending.promise; } };
  const { page, plugin } = fixture([hook]);
  const event = hook.onPageCreated(page);
  const first = waitForPageInitialization(page);
  const second = plugin.onPageCreated(page);
  assert.equal(calls, 1);
  pending.resolve();
  await Promise.all([event, first, second]);
  await hook.onPageCreated(page);
  assert.equal(calls, 1);
});

test('主动初始化先于自动事件时仍完整运行所有插件且不会重复', async () => {
  const calls = [];
  const hooks = ['前', '后'].map((name) => ({ name, onPageCreated: async () => { calls.push(name); } }));
  const { page } = fixture(hooks);
  await waitForPageInitialization(page);
  await Promise.all(hooks.map((hook) => hook.onPageCreated(page)));
  assert.deepEqual(calls, ['前', '后']);
});

test('一个插件失败仍须等待其余初始化收尾，再返回原始错误', async () => {
  const failure = new Error('预加载注册失败');
  const pending = deferred();
  const { page } = fixture([
    { name: '失败插件', onPageCreated: async () => { throw failure; } },
    { name: '迟到插件', onPageCreated: () => pending.promise },
  ]);
  let finished = false;
  const initialization = waitForPageInitialization(page).catch((error) => { finished = true; return error; });
  await nextTurn();
  assert.equal(finished, false);
  pending.resolve();
  assert.equal(await initialization, failure);
});

test('同步抛错和空值错误也能被观察，后续插件仍然执行', async () => {
  let invoked = false;
  const { page } = fixture([
    { name: '同步失败', onPageCreated() { throw null; } },
    { name: '后续插件', onPageCreated() { invoked = true; } },
  ]);
  const result = await waitForPageInitialization(page).then(() => ({ success: true }), (error) => ({ success: false, error }));
  assert.deepEqual(result, { success: false, error: null });
  assert.equal(invoked, true);
});

test('关闭上下文等待现有初始化并阻止该上下文迟到页面启动新插件，其他上下文不受影响', async () => {
  const pending = deferred();
  let calls = 0;
  const { browser, context, page } = fixture([{ name: '页面插件', onPageCreated() { calls += 1; return pending.promise; } }]);
  const initialization = waitForPageInitialization(page);
  let stopped = false;
  const stopping = stopContextInitialization(context, browser).then(() => { stopped = true; });
  await waitForPageInitialization({ browser: () => browser, browserContext: () => context });
  assert.equal(calls, 1);
  await nextTurn();
  assert.equal(stopped, false);
  pending.resolve();
  await Promise.all([initialization, stopping]);
  await waitForPageInitialization({ browser: () => browser, browserContext: () => ({}) });
  assert.equal(calls, 2);
});

test('关闭浏览器等待所有上下文初始化且不再产生迟到初始化命令', async () => {
  const pending = deferred();
  let calls = 0;
  const { browser, page } = fixture([{ name: '页面插件', onPageCreated() { calls += 1; return pending.promise; } }]);
  const initialization = waitForPageInitialization(page);
  let stopped = false;
  const stopping = stopBrowserInitialization(browser).then(() => { stopped = true; });
  await waitForPageInitialization({ browser: () => browser, browserContext: () => ({}) });
  assert.equal(calls, 1);
  await nextTurn();
  assert.equal(stopped, false);
  pending.reject(new Error('关闭期间注册失败'));
  await Promise.allSettled([initialization, stopping]);
  assert.equal(stopped, true);
});

test('无插件的测试浏览器兼容原页面生命周期，重复安装不会重复包装', async () => {
  await waitForPageInitialization({});
  await stopContextInitialization({}, {});
  await stopBrowserInitialization({});
  let calls = 0;
  const { page, plugin } = fixture([{ name: '页面插件', onPageCreated() { calls += 1; } }]);
  plugin.beforeConnect({});
  await waitForPageInitialization(page);
  assert.equal(calls, 1);
});

test('公开插件列表不兼容时在启动前明确失败', () => {
  const plugin = createInitializationPlugin({});
  assert.throws(() => plugin.beforeLaunch({}), /公开 plugins/);
});
