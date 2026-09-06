const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { TargetCloseError } = require('puppeteer-core');
const originalUserAgentPlugin = require('puppeteer-extra-plugin-stealth/evasions/user-agent-override');
const { createUserAgentPlugin } = require('../browser-user-agent');

const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const LINUX_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.92 Safari/537.36';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro Build/AP1A.240505.004) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.6668.81 Mobile Safari/537.36';
const FALLBACK_VERSION = 'Chrome/152.0.7977.76';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

function pageFixture({ userAgent = WINDOWS_UA, version = FALLBACK_VERSION, send, attach } = {}) {
  const page = new EventEmitter();
  const calls = { userAgent: 0, version: 0, attach: 0, detach: 0, commands: [] };
  const pending = new Set();
  const session = {
    closed: false,
    async send(method, params) {
      calls.commands.push({ method, params });
      if (this.closed) throw page.closeError;
      if (!send) return {};
      const closing = deferred();
      pending.add(closing);
      try {
        return await Promise.race([Promise.resolve().then(() => send(method, params)), closing.promise]);
      } finally {
        pending.delete(closing);
      }
    },
    async detach() { calls.detach += 1; this.closed = true; },
  };
  Object.assign(page, {
    closed: false,
    closeError: new TargetCloseError('页面关闭导致协议命令取消'),
    browser() {
      return {
        async userAgent() { calls.userAgent += 1; return typeof userAgent === 'function' ? userAgent() : userAgent; },
        async version() { calls.version += 1; return typeof version === 'function' ? version() : version; },
      };
    },
    isClosed() { return this.closed; },
    async createCDPSession() {
      calls.attach += 1;
      if (this.closed) throw this.closeError;
      if (attach) await attach();
      return session;
    },
    async close() {
      this.closed = true;
      session.closed = true;
      for (const command of pending) command.reject(this.closeError);
      this.emit('close');
    },
  });
  // 生产替代必须完全依赖公共会话接口，不能读取真实页面的私有客户端。
  Object.defineProperty(page, '_client', { get() { assert.fail('不能访问页面私有客户端'); } });
  return { page, session, calls };
}

async function configuredPlugin(factory, options, mode) {
  const plugin = factory(options);
  if (mode === 'connect') await plugin.beforeConnect();
  else if (mode !== 'unconfigured') await plugin.beforeLaunch({ headless: mode });
  return plugin;
}

async function originalCommand(options, mode, browserOptions) {
  const fixture = pageFixture(browserOptions);
  const commands = [];
  // 仅兼容性对照夹具为原插件提供它要求的形状，生产实现不会使用这种代理。
  const page = { browser: () => fixture.page.browser(), _client: () => ({
    send(method, params) { commands.push({ method, params }); return Promise.resolve({}); },
  }) };
  const plugin = await configuredPlugin(originalUserAgentPlugin, options, mode);
  await plugin.onPageCreated(page);
  assert.equal(commands.length, 1);
  return { command: commands[0], calls: fixture.calls };
}

test('保留原插件公开名称、配置、依赖和用户语言偏好', async () => {
  for (const options of [undefined, { locale: 'zh-CN,zh;q=0.9', maskLinux: false }, { locale: '', userAgent: WINDOWS_UA }, { locale: null }]) {
    const expected = originalUserAgentPlugin(options);
    const actual = createUserAgentPlugin(options);
    assert.equal(actual.name, expected.name);
    assert.deepEqual(actual.defaults, expected.defaults);
    assert.deepEqual(actual.opts, expected.opts);
    assert.deepEqual(actual.dependencies, expected.dependencies);
    assert.deepEqual(actual.data, expected.data);
  }
});

test('平台、语言、默认UA和浏览器版本回退逐字段兼容原插件', async (t) => {
  const cases = [
    { name: 'Windows桌面无头', options: { userAgent: WINDOWS_UA, locale: 'zh-CN,zh;q=0.9' }, mode: true },
    { name: 'Mac保留下划线版本', options: { userAgent: MAC_UA }, mode: true },
    { name: 'Linux默认伪装Windows', options: { userAgent: LINUX_UA }, mode: true },
    { name: 'Linux明确不伪装', options: { userAgent: LINUX_UA, maskLinux: false }, mode: true },
    { name: 'Android不做Linux伪装且保留完整型号', options: { userAgent: ANDROID_UA }, mode: true },
    { name: 'Android平板不依赖Mobile标记', options: { userAgent: ANDROID_UA.replace(' Mobile ', ' ') }, mode: true },
    { name: '有头不附加语言协议字段', options: { userAgent: WINDOWS_UA }, mode: false },
    { name: '未配置保持有头初始行为', options: { userAgent: WINDOWS_UA }, mode: 'unconfigured' },
    { name: '未传headless保持原行为', options: { userAgent: WINDOWS_UA }, mode: undefined },
    { name: 'connect按无头处理', options: { userAgent: WINDOWS_UA, locale: '' }, mode: 'connect' },
    { name: 'new无头模式保留语言', options: { userAgent: WINDOWS_UA }, mode: 'new' },
    { name: '默认UA去掉Headless且遮盖Linux', options: {}, mode: true,
      browserOptions: { userAgent: LINUX_UA.replace('Chrome/', 'HeadlessChrome/') } },
    { name: '空字符串UA回退浏览器默认值', options: { userAgent: '' }, mode: true },
    { name: '自定义Headless字符串不擅自改写', options: { userAgent: WINDOWS_UA.replace('Chrome/', 'HeadlessChrome/') }, mode: true },
    { name: '非Chrome UA从浏览器读取版本', options: { userAgent: 'Mozilla/4.0 (compatible; MSIE 6.0; Windows NT 5.1; SV1)' }, mode: true },
    { name: '未知系统保留Windows平台与空版本', options: { userAgent: 'CustomAgent Chrome/131.0.0.0' }, mode: true },
    { name: 'Windows缺少系统版本时保留原正则跨段读取行为', options: { userAgent: 'Mozilla/5.0 (Windows broken) Chrome/131.0.0.0' }, mode: true },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const expected = await originalCommand(scenario.options, scenario.mode, scenario.browserOptions);
      const fixture = pageFixture(scenario.browserOptions);
      const plugin = await configuredPlugin(createUserAgentPlugin, scenario.options, scenario.mode);
      await plugin.onPageCreated(fixture.page);
      assert.deepEqual(fixture.calls.commands, [expected.command]);
      assert.equal(fixture.calls.userAgent, expected.calls.userAgent);
      assert.equal(fixture.calls.version, expected.calls.version);
      assert.equal(fixture.calls.attach, 1);
      assert.equal(fixture.calls.detach, 0);
      await fixture.page.close();
    });
  }
});

test('完整保留Chrome主版本对应的六种品牌排列和GREASE字符串', async () => {
  for (const version of ['126', '127', '128', '129', '130', '131']) {
    const options = { userAgent: WINDOWS_UA.replace('131.0.0.0', `${version}.2.3.4`) };
    const expected = await originalCommand(options, true);
    const fixture = pageFixture();
    const plugin = await configuredPlugin(createUserAgentPlugin, options, true);
    await plugin.onPageCreated(fixture.page);
    assert.deepEqual(fixture.calls.commands, [expected.command]);
    await fixture.page.close();
  }
});

test('异步UA查询期间切换连接模式时，语言配置读取最新生命周期状态', async () => {
  const userAgent = deferred();
  const fixture = pageFixture({ userAgent: () => userAgent.promise });
  const plugin = await configuredPlugin(createUserAgentPlugin, {}, false);
  const original = await configuredPlugin(originalUserAgentPlugin, {}, false);
  const expected = [];
  const originalPage = {
    browser: () => fixture.page.browser(),
    _client: () => ({ send(method, params) { expected.push({ method, params }); return Promise.resolve({}); } }),
  };
  const setting = plugin.onPageCreated(fixture.page);
  const originalSetting = original.onPageCreated(originalPage);
  await plugin.beforeConnect();
  await original.beforeConnect();
  userAgent.resolve(WINDOWS_UA);
  await Promise.all([setting, originalSetting]);
  assert.deepEqual(fixture.calls.commands, expected);
  assert.equal(fixture.calls.commands[0].params.acceptLanguage, 'en-US,en');
  await fixture.page.close();
});

test('自定义Chrome UA不需异步查询时保持调用当时的语言模式', async () => {
  const fixture = pageFixture();
  const options = { userAgent: WINDOWS_UA };
  const plugin = await configuredPlugin(createUserAgentPlugin, options, false);
  const expected = [];
  const original = await configuredPlugin(originalUserAgentPlugin, options, false);
  const originalPage = {
    _client: () => ({ send(method, params) { expected.push({ method, params }); return Promise.resolve({}); } }),
  };
  const setting = plugin.onPageCreated(fixture.page);
  const originalSetting = original.onPageCreated(originalPage);
  await plugin.beforeConnect();
  await original.beforeConnect();
  await Promise.all([setting, originalSetting]);
  assert.deepEqual(fixture.calls.commands, expected);
  assert.equal(Object.hasOwn(fixture.calls.commands[0].params, 'acceptLanguage'), false);
  await fixture.page.close();
});

test('页面初始化必须等UA协议确认，会话在正常页面存活期间不能被分离', async () => {
  const command = deferred();
  const started = deferred();
  const fixture = pageFixture({ send: () => { started.resolve(); return command.promise; } });
  const plugin = createUserAgentPlugin({ userAgent: WINDOWS_UA });
  let settled = false;
  const setting = plugin.onPageCreated(fixture.page).then(() => { settled = true; });
  await started.promise;
  assert.equal(settled, false);
  assert.equal(fixture.calls.detach, 0);
  command.resolve({});
  await setting;
  assert.equal(fixture.session.closed, false);
  assert.equal(fixture.calls.detach, 0);
  await fixture.page.close();
  assert.equal(fixture.session.closed, true);
});

test('UA协议拒绝必须返回同一配置异常，不能吞错或用收尾错误替代', async () => {
  const failure = new Error('用户代理配置被浏览器拒绝');
  const fixture = pageFixture({ send: () => { throw failure; } });
  fixture.session.detach = async () => { throw new Error('不应该进入提前分离'); };
  const plugin = createUserAgentPlugin({ userAgent: WINDOWS_UA });
  await assert.rejects(plugin.onPageCreated(fixture.page), error => error === failure);
  assert.equal(fixture.session.closed, false);
  await fixture.page.close();
  assert.equal(fixture.session.closed, true);
});

test('请求取消关闭context对应页面时，尚未确认的UA命令拒绝会被调用者观察', async () => {
  const command = deferred();
  const started = deferred();
  const fixture = pageFixture({ send: () => { started.resolve(); return command.promise; } });
  const plugin = createUserAgentPlugin({ userAgent: WINDOWS_UA });
  const setting = plugin.onPageCreated(fixture.page);
  const rejected = assert.rejects(setting, error => error === fixture.page.closeError);
  await started.promise;
  await fixture.page.close();
  await rejected;
  command.resolve({});
  assert.equal(fixture.calls.detach, 0);
});

test('创建公共会话失败时保留错误并且不发送UA命令', async () => {
  const failure = new Error('公共会话创建失败');
  const fixture = pageFixture({ attach: () => { throw failure; } });
  const plugin = createUserAgentPlugin({ userAgent: WINDOWS_UA });
  await assert.rejects(plugin.onPageCreated(fixture.page), error => error === failure);
  assert.deepEqual(fixture.calls.commands, []);
});

test('页面在公共会话创建期间关闭时，迟到会话的原始关闭异常仍被观察', async () => {
  const attaching = deferred();
  const started = deferred();
  const fixture = pageFixture({ attach: () => { started.resolve(); return attaching.promise; } });
  const plugin = createUserAgentPlugin({ userAgent: WINDOWS_UA });
  const setting = plugin.onPageCreated(fixture.page);
  const rejected = assert.rejects(setting, error => error === fixture.page.closeError);
  await started.promise;
  await fixture.page.close();
  attaching.resolve();
  await rejected;
  assert.equal(fixture.session.closed, true);
});

test('浏览器UA或版本读取失败时在分配会话前保留首个错误', async () => {
  const failure = new Error('浏览器配置读取失败');
  for (const scenario of [
    { options: {}, browserOptions: { userAgent: () => { throw failure; } } },
    { options: { userAgent: 'CustomAgent' }, browserOptions: { version: () => { throw failure; } } },
  ]) {
    const fixture = pageFixture(scenario.browserOptions);
    const plugin = createUserAgentPlugin(scenario.options);
    await assert.rejects(plugin.onPageCreated(fixture.page), error => error === failure);
    assert.equal(fixture.calls.attach, 0);
  }
});

test('不合法的自定义UA保持原插件配置错误类型且不分配会话', async () => {
  for (const userAgent of ['Chrome/invalid', 'Mozilla/5.0 Android Chrome/131.0.0.0']) {
    const options = { userAgent };
    const expected = await originalCommand(options, true).catch(error => error);
    assert.ok(expected instanceof TypeError);
    const fixture = pageFixture();
    const plugin = await configuredPlugin(createUserAgentPlugin, options, true);
    await assert.rejects(plugin.onPageCreated(fixture.page), error => error.constructor === expected.constructor);
    assert.equal(fixture.calls.attach, 0);
  }
});
