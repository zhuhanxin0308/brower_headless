const puppeteerCore = require('puppeteer-core');
const { addExtra } = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { createUserAgentPlugin } = require('./browser-user-agent');
const { createInitializationPlugin } = require('./browser-initialization');
const { createPool } = require('generic-pool');
const { bounded, closeBrowser, DEFAULT_CLEANUP_TIMEOUT_MS, withPage } = require('./browser-page');
const { createAdmissionPool } = require('./browser-pool-admission');
const { initializePrewarm, pausePrewarm, takePreparedPage, finishPreparedPage, unsafePrewarmError } = require('./browser-prewarm');

const DEFAULT_MIN_BROWSERS = 2;
const DEFAULT_MAX_BROWSERS = 10;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 30000;
const DEFAULT_SOFT_IDLE_TIMEOUT_MS = 60000;
const DEFAULT_EVICTION_INTERVAL_MS = 30000;
const DISABLED_HARD_IDLE_TIMEOUT_MS = Number.POSITIVE_INFINITY;
const MAX_TIMER_DELAY_MS = (2 ** 31) - 1;

function assertIntegerOption(name, value, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} 必须是 ${minimum} 到 ${maximum} 范围内的整数`);
  }
}

// 维持一组常见桌面端 UA，结合 stealth 插件降低被简单规则识别的概率。
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
];

const CHROME_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--disable-gpu',
  '--no-first-run',
  '--no-zygote',
  // 不能启用 single-process，否则独立 BrowserContext 在 Linux/Chromium 容器内会直接失败。
  '--disable-blink-features=AutomationControlled',
  '--disable-infobars',
  '--hide-scrollbars',
  '--mute-audio',
  '--disable-extensions',
  '--disable-plugins',
  '--disable-default-apps',
  '--disable-sync',
  '--disable-translate',
  '--disable-background-networking',
  '--disable-client-side-phishing-detection',
  '--safebrowsing-disable-auto-update',
  '--metrics-recording-only',
  '--disable-hang-monitor',
  '--disable-prompt-on-repost',
  '--disable-domain-reliability',
  '--disable-component-update',
  '--disable-breakpad',
  '--lang=zh-CN,zh;q=0.9,en;q=0.8',
];

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// 每次创建浏览器实例时都绑定 stealth 插件和定制 UA，避免手写脚本和插件行为相互覆盖。
function createStealthPuppeteer(userAgent) {
  const puppeteer = addExtra(puppeteerCore);
  const stealthPlugin = StealthPlugin();

  // 交给定制 UA 插件统一处理 UA、平台和语言，避免再调用 page.setUserAgent 破坏 stealth 配置。
  stealthPlugin.enabledEvasions.delete('user-agent-override');

  puppeteer.use(stealthPlugin);
  puppeteer.use(createUserAgentPlugin({
    userAgent,
    locale: 'zh-CN,zh;q=0.9,en;q=0.8',
    maskLinux: true,
  }));
  puppeteer.use(createInitializationPlugin(puppeteer));

  return puppeteer;
}

function createBrowserPool(options = {}) {
  const {
    minBrowsers = DEFAULT_MIN_BROWSERS,
    maxBrowsers = DEFAULT_MAX_BROWSERS,
    maxPendingAcquires = maxBrowsers,
    acquireTimeoutMillis = DEFAULT_ACQUIRE_TIMEOUT_MS,
    softIdleTimeoutMillis = DEFAULT_SOFT_IDLE_TIMEOUT_MS,
    evictionRunIntervalMillis = DEFAULT_EVICTION_INTERVAL_MS,
    cleanupTimeoutMillis = DEFAULT_CLEANUP_TIMEOUT_MS,
    prewarmPages = true,
    executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    launchBrowser = async () => {
      const puppeteer = createStealthPuppeteer(randomUA());
      return puppeteer.launch({
        executablePath,
        headless: true,
        args: CHROME_ARGS,
        ignoreHTTPSErrors: true,
      });
    },
  } = options;

  assertIntegerOption('maxBrowsers', maxBrowsers, 1);
  assertIntegerOption('minBrowsers', minBrowsers, 0, maxBrowsers);
  assertIntegerOption('maxPendingAcquires', maxPendingAcquires, 0);
  if (typeof prewarmPages !== 'boolean') throw new TypeError('prewarmPages 必须是布尔值');
  for (const [name, value] of Object.entries({ acquireTimeoutMillis, softIdleTimeoutMillis, evictionRunIntervalMillis, cleanupTimeoutMillis })) {
    assertIntegerOption(name, value, 1, MAX_TIMER_DELAY_MS);
  }

  const browsers = new Set();
  let stopping = false;
  let pool;
  const factory = {
    create: async () => {
      const browser = await launchBrowser();
      browsers.add(browser);
      if (prewarmPages && !stopping) {
        await initializePrewarm(browser, {
          bounded,
          cleanupTimeoutMillis,
          preparationTimeoutMillis: acquireTimeoutMillis,
          reportError: (error) => pool.emit('factoryCreateError', error),
          closeBrowser: (value) => closeBrowser(value, { cleanupTimeoutMillis }),
        });
      }
      return browser;
    },
    destroy: async (browser) => {
      try {
        await closeBrowser(browser, { cleanupTimeoutMillis });
      } finally {
        browsers.delete(browser);
      }
    },
    validate: async (browser) => {
      try {
        // 不确定的预热失败交给当前借用报错并淘汰，避免工厂验证反复补建失败实例。
        if (unsafePrewarmError(browser)) return true;
        return browser.isConnected();
      } catch {
        return false;
      }
    },
  };

  pool = createPool(factory, {
    min: minBrowsers,
    max: maxBrowsers,
    // 底层至少容纳所有启动中的浏览器；业务等待上限由外部可取消队列统一执行。
    maxWaitingClients: Math.max(maxPendingAcquires, maxBrowsers),
    testOnBorrow: true,
    acquireTimeoutMillis,
    // 软回收只缩减多余空闲实例，禁用硬回收以保留最小预热容量。
    softIdleTimeoutMillis,
    idleTimeoutMillis: DISABLED_HARD_IDLE_TIMEOUT_MS,
    evictionRunIntervalMillis,
  });
  const adapter = createAdmissionPool(pool, {
    maxBrowsers,
    maxPendingAcquires,
    acquireTimeoutMillis,
    cleanupTimeoutMillis,
    closeAbandonedBrowser: (browser) => closeBrowser(browser, { cleanupTimeoutMillis }),
  });
  if (prewarmPages) {
    adapter.takePreparedPage = takePreparedPage;
    adapter.finishPreparedPage = finishPreparedPage;
    const stopReplenishing = () => {
      stopping = true;
      for (const browser of browsers) pausePrewarm(browser);
    };
    for (const method of ['drain', 'clear']) {
      const original = adapter[method];
      adapter[method] = () => { stopReplenishing(); return original(); };
    }
  }
  return adapter;
}

module.exports = {
  createBrowserPool,
  createStealthPuppeteer,
  randomUA,
  withPage,
};
