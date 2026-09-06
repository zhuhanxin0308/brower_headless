const { PuppeteerExtraPlugin } = require('puppeteer-extra-plugin');

const controllers = new WeakMap();

class InitializationPlugin extends PuppeteerExtraPlugin {
  constructor(puppeteer) {
    super();
    this.puppeteer = puppeteer;
    this.hooks = null;
    this.pages = new WeakMap();
    this.pending = new Set();
    this.stoppedBrowsers = new WeakSet();
    this.stoppedContexts = new WeakSet();
  }

  get name() { return 'application/page-initialization'; }

  install() {
    if (this.hooks) return;
    if (!Array.isArray(this.puppeteer.plugins)) {
      throw new TypeError('puppeteer-extra 必须提供公开 plugins 列表');
    }
    // beforeLaunch/beforeConnect 执行时依赖已解析，使用公开列表自动适配全部插件。
    this.hooks = this.puppeteer.plugins.filter((plugin) => plugin !== this && typeof plugin.onPageCreated === 'function')
      .map((plugin) => ({ plugin, original: plugin.onPageCreated }));
    for (const hook of this.hooks) {
      const wrapped = (page) => this.invoke(hook, page);
      hook.plugin.onPageCreated = wrapped;
      if (hook.plugin.onPageCreated !== wrapped) {
        throw new TypeError(`插件 ${hook.plugin.name} 的公开 onPageCreated 不可扩展`);
      }
    }
  }

  beforeLaunch(options) { this.install(); return options; }
  beforeConnect(options) { this.install(); return options; }
  onBrowser(browser) { controllers.set(browser, this); }

  record(page) {
    if (!this.pages.has(page)) {
      const browser = page.browser();
      const context = page.browserContext();
      controllers.set(browser, this);
      this.pages.set(page, { browser, context, hooks: new Map(), completion: null });
    }
    return this.pages.get(page);
  }

  invoke(hook, page) {
    const record = this.record(page);
    if (record.hooks.has(hook)) return record.hooks.get(hook);
    if (this.stoppedBrowsers.has(record.browser) || this.stoppedContexts.has(record.context)) {
      const skipped = Promise.resolve();
      record.hooks.set(hook, skipped);
      return skipped;
    }
    let resolve;
    let reject;
    const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
    // 先登记再调用，自动事件、应用主动调用和同步重入都只能启动同一份初始化。
    record.hooks.set(hook, promise);
    const entry = { browser: record.browser, context: record.context, promise };
    this.pending.add(entry);
    promise.then(() => this.pending.delete(entry), () => this.pending.delete(entry));
    try {
      Promise.resolve(hook.original.call(hook.plugin, page)).then(resolve, reject);
    } catch (error) {
      reject(error);
    }
    return promise;
  }

  onPageCreated(page) {
    const record = this.record(page);
    if (!record.completion) {
      // 一个插件失败不能提前关闭页面；先等待所有已经启动的钩子，再传播第一个失败。
      record.completion = Promise.allSettled(this.hooks.map((hook) => this.invoke(hook, page)))
        .then((results) => {
          const failure = results.find((result) => result.status === 'rejected');
          if (failure) throw failure.reason;
        });
      // 失败仍由应用等待者或插件事件处理器接收，后台完成任务不会产生未观察的拒绝。
      record.completion.catch(() => {});
    }
    return record.completion;
  }

  stopBrowser(browser) {
    this.stoppedBrowsers.add(browser);
    return Promise.allSettled([...this.pending].filter((entry) => entry.browser === browser).map((entry) => entry.promise));
  }

  stopContext(context) {
    this.stoppedContexts.add(context);
    return Promise.allSettled([...this.pending].filter((entry) => entry.context === context).map((entry) => entry.promise));
  }
}

function createInitializationPlugin(puppeteer) {
  return new InitializationPlugin(puppeteer);
}

function waitForPageInitialization(page) {
  return controllers.get(page.browser?.())?.onPageCreated(page) || Promise.resolve();
}

function stopContextInitialization(context, browser) {
  return controllers.get(browser)?.stopContext(context) || Promise.resolve();
}

function stopBrowserInitialization(browser) {
  return controllers.get(browser)?.stopBrowser(browser) || Promise.resolve();
}

module.exports = { createInitializationPlugin, waitForPageInitialization, stopContextInitialization, stopBrowserInitialization };
