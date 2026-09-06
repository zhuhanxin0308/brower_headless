const { PuppeteerExtraPlugin } = require('puppeteer-extra-plugin');

// 算法兼容来源：puppeteer-extra-plugin-stealth 2.11.2 的 user-agent-override。
// 此处由应用持有完整配置及协议 Promise；升级兼容来源前须运行逐字段对照测试。
// 以下保留兼容算法来源的 MIT 许可原文，其余实现注释使用中文。
/*
Copyright (c) 2019 berstend <github@berstend.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

const DEFAULT_LOCALE = 'en-US,en';
const MASKED_LINUX_PLATFORM = '(Windows NT 10.0; Win64; x64)';
const USER_AGENT_COMMAND = 'Network.setUserAgentOverride';
const GREASE_BRAND_VERSION = '99';
const BRAND_ESCAPE_CHARACTERS = [' ', ' ', ';'];
const BRAND_ORDERS = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];

function createBrands(version) {
  // 主版本保留字符串形式；排列及假品牌中的空格、分号必须与兼容来源一致。
  const majorVersion = version.split('.')[0];
  const order = BRAND_ORDERS[majorVersion % BRAND_ORDERS.length];
  const fakeBrand = `${BRAND_ESCAPE_CHARACTERS[order[0]]}Not${BRAND_ESCAPE_CHARACTERS[order[1]]}A${BRAND_ESCAPE_CHARACTERS[order[2]]}Brand`;
  const brands = [];
  brands[order[0]] = { brand: fakeBrand, version: GREASE_BRAND_VERSION };
  brands[order[1]] = { brand: 'Chromium', version: majorVersion };
  brands[order[2]] = { brand: 'Google Chrome', version: majorVersion };
  return brands;
}

function platformName(userAgent, extended = false) {
  if (userAgent.includes('Mac OS X')) return extended ? 'Mac OS X' : 'MacIntel';
  if (userAgent.includes('Android')) return 'Android';
  if (userAgent.includes('Linux')) return 'Linux';
  return extended ? 'Windows' : 'Win32';
}

function platformVersion(userAgent) {
  if (userAgent.includes('Mac OS X ')) return userAgent.match(/Mac OS X ([^)]+)/)[1];
  if (userAgent.includes('Android ')) return userAgent.match(/Android ([^;]+)/)[1];
  if (userAgent.includes('Windows ')) return userAgent.match(/Windows .*?([\d|.]+);?/)[1];
  return '';
}

async function createOverride(page, options, isHeadless) {
  // 自定义 UA 不移除 Headless 标记；仅浏览器提供的默认 UA 做这一项替换。
  let userAgent = options.userAgent
    || (await page.browser().userAgent()).replace('HeadlessChrome/', 'Chrome/');
  if (options.maskLinux && userAgent.includes('Linux') && !userAgent.includes('Android')) {
    userAgent = userAgent.replace(/\(([^)]+)\)/, MASKED_LINUX_PLATFORM);
  }

  const version = userAgent.includes('Chrome/')
    ? userAgent.match(/Chrome\/([\d|.]+)/)[1]
    : (await page.browser().version()).match(/\/([\d|.]+)/)[1];
  const mobile = userAgent.includes('Android');
  const override = {
    userAgent,
    platform: platformName(userAgent),
    userAgentMetadata: {
      brands: createBrands(version),
      fullVersion: version,
      platform: platformName(userAgent, true),
      platformVersion: platformVersion(userAgent),
      architecture: mobile ? '' : 'x86',
      model: mobile ? userAgent.match(/Android.*?;\s([^)]+)/)[1] : '',
      mobile,
    },
  };
  // 语言模式在查询结束后立即读取；没有查询时也不能额外延迟到另一个微任务。
  if (isHeadless()) override.acceptLanguage = options.locale || DEFAULT_LOCALE;
  return override;
}

class UserAgentPlugin extends PuppeteerExtraPlugin {
  constructor(options = {}) {
    super(options);
    this.headless = false;
  }

  get name() {
    return 'stealth/evasions/user-agent-override';
  }

  get dependencies() {
    return new Set(['user-preferences']);
  }

  get defaults() {
    return { userAgent: null, locale: DEFAULT_LOCALE, maskLinux: true };
  }

  async beforeLaunch(options) {
    this.headless = options.headless;
  }

  async beforeConnect() {
    this.headless = true;
  }

  get data() {
    return [{ name: 'userPreferences', value: {
      intl: { accept_languages: this.opts.locale || DEFAULT_LOCALE },
    } }];
  }

  async onPageCreated(page) {
    const override = await createOverride(page, this.opts, () => this.headless);
    const session = await page.createCDPSession();
    // 会话随页面目标存活，页面或上下文关闭时由 Puppeteer 释放，不能提前分离而撤销覆盖。
    // 等待协议确认并保留原始拒绝，让统一初始化屏障能观察配置失败与关闭取消。
    await session.send(USER_AGENT_COMMAND, override);
  }
}

function createUserAgentPlugin(options) {
  return new UserAgentPlugin(options);
}

module.exports = { createUserAgentPlugin };
