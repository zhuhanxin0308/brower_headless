const puppeteerCore = require('puppeteer-core');
const { addExtra } = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const UserAgentOverridePlugin = require('puppeteer-extra-plugin-stealth/evasions/user-agent-override');
const { createPool } = require('generic-pool');

// 维持一组常见桌面端 UA，结合 stealth 插件降低被简单规则识别的概率。
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0',
];

const CHROME_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--disable-gpu',
  '--no-first-run',
  '--no-zygote',
  '--single-process',
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
  puppeteer.use(UserAgentOverridePlugin({
    userAgent,
    locale: 'zh-CN,zh;q=0.9,en;q=0.8',
    maskLinux: true,
  }));

  return puppeteer;
}

function createBrowserPool(options = {}) {
  const {
    minBrowsers = 2,
    maxBrowsers = 10,
    executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
  } = options;

  const factory = {
    create: async () => {
      const userAgent = randomUA();
      const puppeteer = createStealthPuppeteer(userAgent);
      const browser = await puppeteer.launch({
        executablePath,
        headless: 'new',
        args: CHROME_ARGS,
        ignoreHTTPSErrors: true,
      });

      return browser;
    },
    destroy: async (browser) => {
      await browser.close().catch(() => {});
    },
    validate: async (browser) => {
      try {
        return browser.isConnected();
      } catch {
        return false;
      }
    },
  };

  return createPool(factory, {
    min: minBrowsers,
    max: maxBrowsers,
    testOnBorrow: true,
    acquireTimeoutMillis: 30000,
    idleTimeoutMillis: 60000,
    evictionRunIntervalMillis: 30000,
  });
}

// 每次请求都使用独立 BrowserContext，彻底隔离 cookie、缓存和 localStorage。
async function withPage(pool, fn) {
  const browser = await pool.acquire();
  const context = await browser.createBrowserContext();
  const page = await context.newPage();

  try {
    return await fn(page, context);
  } finally {
    await context.close().catch(() => {});
    pool.release(browser);
  }
}

module.exports = {
  createBrowserPool,
  createStealthPuppeteer,
  randomUA,
  withPage,
};
