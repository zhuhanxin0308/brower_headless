const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const puppeteerCore = require('puppeteer-core');
const { addExtra } = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const OriginalUserAgentPlugin = require('puppeteer-extra-plugin-stealth/evasions/user-agent-override');
const { createBrowserPool, createStealthPuppeteer, withPage } = require('../browser-pool');
const { createInitializationPlugin } = require('../browser-initialization');

const executablePath = process.env.BROWSER_TEST_EXECUTABLE;
const TEST_TIMEOUT_MS = 60000;
const OPERATION_TIMEOUT_MS = 10000;
const LOCALE = 'zh-CN,zh;q=0.9,en;q=0.8';
const CHROME_SUFFIX = ' AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const USER_AGENTS = [
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64)${CHROME_SUFFIX}`,
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)${CHROME_SUFFIX}`,
  `Mozilla/5.0 (X11; Linux x86_64)${CHROME_SUFFIX}`,
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64)${CHROME_SUFFIX} Edg/131.0.0.0`,
];

function originalPuppeteer(userAgent) {
  const puppeteer = addExtra(puppeteerCore);
  const stealth = StealthPlugin();
  stealth.enabledEvasions.delete('user-agent-override');
  puppeteer.use(stealth);
  puppeteer.use(OriginalUserAgentPlugin({ userAgent, locale: LOCALE, maskLinux: true }));
  // 对照仍使用安装版 UA；只协调其余可等待脚本，避免关闭时截断脚本注册。
  puppeteer.use(createInitializationPlugin(puppeteer));
  return puppeteer;
}

test('真实 Chromium 预热页首次导航的 UA、语言和客户端提示与安装版插件一致', {
  skip: !executablePath,
  timeout: TEST_TIMEOUT_MS,
}, async (t) => {
  const origin = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><script>
      // 在首个页面脚本中取值，防止初始化落后于导航却被后续读取掩盖。
      window.firstIdentity = {
        headers: ${JSON.stringify({
          userAgent: request.headers['user-agent'],
          language: request.headers['accept-language'],
          brands: request.headers['sec-ch-ua'],
          mobile: request.headers['sec-ch-ua-mobile'],
          platform: request.headers['sec-ch-ua-platform'],
        })},
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        languages: [...navigator.languages],
        webdriver: navigator.webdriver,
      };
      window.firstHints = navigator.userAgentData.getHighEntropyValues([
        'architecture', 'model', 'platformVersion', 'uaFullVersion'
      ]);
    </script>`);
  });
  await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { origin.close(resolve); origin.closeAllConnections(); }));
  const url = `http://127.0.0.1:${origin.address().port}`;

  async function capture(userAgent, prewarmPages) {
    const puppeteer = prewarmPages ? createStealthPuppeteer(userAgent) : originalPuppeteer(userAgent);
    const pool = createBrowserPool({ minBrowsers: 0, maxBrowsers: 1, prewarmPages,
      launchBrowser: () => puppeteer.launch({ executablePath, headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      }),
    });
    const snapshots = [];
    try {
      // 第二次访问必须使用新上下文；同时覆盖初始预热与消耗后补充的页面。
      for (let attempt = 0; attempt < 2; attempt++) {
        snapshots.push(await withPage(pool, async (page) => {
          await page.goto(url, { waitUntil: 'load' });
          return page.evaluate(async () => ({ ...window.firstIdentity, hints: await window.firstHints }));
        }, { signal: AbortSignal.timeout(OPERATION_TIMEOUT_MS) }));
      }
    } finally {
      await pool.drain();
      await pool.clear();
    }
    return snapshots;
  }

  for (const userAgent of USER_AGENTS) {
    await t.test(userAgent, async () => {
      const expected = await capture(userAgent, false);
      assert.deepEqual(expected[1], expected[0]);
      const actual = await capture(userAgent, true);
      assert.deepEqual(actual, expected);
      for (const identity of actual) {
        assert.equal(identity.headers.userAgent, identity.userAgent);
        assert.equal(identity.hints.uaFullVersion, '131.0.0.0');
        assert.equal(identity.webdriver, false);
        assert.ok(identity.headers.language.startsWith('zh-CN'));
      }
    });
  }
});
