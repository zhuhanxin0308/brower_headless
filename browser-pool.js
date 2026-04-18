const puppeteer = require('puppeteer-core');
const { createPool } = require('generic-pool');

// 反爬 User-Agent 池
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
  // 反检测：关闭自动化标识
  '--disable-blink-features=AutomationControlled',
  '--disable-infobars',
  '--hide-scrollbars',
  '--mute-audio',
  // 性能优化
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
];

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// 注入反检测脚本
async function stealth(page) {
  await page.evaluateOnNewDocument(() => {
    // 隐藏 webdriver 标志
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

    // 伪造 plugins
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
    });

    // 伪造 languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['zh-CN', 'zh', 'en'],
    });

    // 修复 chrome 对象
    window.chrome = { runtime: {} };

    // 伪造 permissions
    const originalQuery = window.navigator.permissions?.query;
    if (originalQuery) {
      window.navigator.permissions.query = (params) =>
        params.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(params);
    }
  });
}

// 创建浏览器实例池
function createBrowserPool(options = {}) {
  const {
    minBrowsers = 2,
    maxBrowsers = 10,
    executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
  } = options;

  const factory = {
    create: async () => {
      const browser = await puppeteer.launch({
        executablePath,
        headless: 'new',
        args: CHROME_ARGS,
        ignoreHTTPSErrors: true,
      });
      browser._ua = randomUA();
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

// 从池中借出一个 Page，用完自动还回
async function withPage(pool, fn) {
  const browser = await pool.acquire();
  const page = await browser.newPage();

  try {
    // 设置随机 UA
    await page.setUserAgent(browser._ua);

    // 注入反检测
    await stealth(page);

    // 关闭不必要的资源加载（可按需开启）
    // await page.setRequestInterception(true);

    const result = await fn(page);
    return result;
  } finally {
    await page.close().catch(() => {});
    pool.release(browser);
  }
}

module.exports = { createBrowserPool, withPage, randomUA };
