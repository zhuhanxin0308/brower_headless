const test = require('node:test');
const assert = require('node:assert/strict');

function loadRendererWithPage(page) {
  const browserPoolPath = require.resolve('../browser-pool');
  const rendererPath = require.resolve('../renderer');
  const previousBrowserPoolModule = require.cache[browserPoolPath];
  const previousRendererModule = require.cache[rendererPath];

  delete require.cache[rendererPath];
  require.cache[browserPoolPath] = {
    id: browserPoolPath,
    filename: browserPoolPath,
    loaded: true,
    exports: {
      withPage: async (_pool, handler) => handler(page),
    },
  };

  const renderer = require('../renderer');

  return {
    renderer,
    restore() {
      delete require.cache[rendererPath];
      if (previousRendererModule) {
        require.cache[rendererPath] = previousRendererModule;
      }

      if (previousBrowserPoolModule) {
        require.cache[browserPoolPath] = previousBrowserPoolModule;
      } else {
        delete require.cache[browserPoolPath];
      }
    },
  };
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createResponse({ url, contentType, body, status = 200, delay = 20 }) {
  return {
    url() {
      return url;
    },
    headers() {
      return { 'content-type': contentType };
    },
    status() {
      return status;
    },
    async json() {
      await wait(delay);
      return body;
    },
    async text() {
      await wait(delay);
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
    async buffer() {
      await wait(delay);
      return Buffer.from(body);
    },
  };
}

// ====== injectCookies ======

test('injectCookies 解析字符串格式的 cookie', async () => {
  const setCookieArgs = [];
  const page = {
    async setCookie(...cookies) {
      setCookieArgs.push(...cookies);
    },
  };

  const { renderer, restore } = loadRendererWithPage(page);
  try {
    await renderer.injectCookies(page, 'https://example.com/path', 'session=abc; token=xyz');
    assert.equal(setCookieArgs.length, 2);
    assert.equal(setCookieArgs[0].name, 'session');
    assert.equal(setCookieArgs[0].value, 'abc');
    assert.equal(setCookieArgs[0].domain, 'example.com');
    assert.equal(setCookieArgs[1].name, 'token');
    assert.equal(setCookieArgs[1].value, 'xyz');
  } finally {
    restore();
  }
});

test('injectCookies 解析包含等号的 cookie 值', async () => {
  const setCookieArgs = [];
  const page = {
    async setCookie(...cookies) {
      setCookieArgs.push(...cookies);
    },
  };

  const { renderer, restore } = loadRendererWithPage(page);
  try {
    await renderer.injectCookies(page, 'https://example.com', 'data=key=val=ue');
    assert.equal(setCookieArgs.length, 1);
    assert.equal(setCookieArgs[0].name, 'data');
    assert.equal(setCookieArgs[0].value, 'key=val=ue');
  } finally {
    restore();
  }
});

test('injectCookies 解析数组格式的 cookie', async () => {
  const setCookieArgs = [];
  const page = {
    async setCookie(...cookies) {
      setCookieArgs.push(...cookies);
    },
  };

  const { renderer, restore } = loadRendererWithPage(page);
  try {
    await renderer.injectCookies(page, 'https://example.com', [
      { name: 'session', value: 'abc', httpOnly: true },
    ]);
    assert.equal(setCookieArgs.length, 1);
    assert.equal(setCookieArgs[0].name, 'session');
    assert.equal(setCookieArgs[0].value, 'abc');
    assert.equal(setCookieArgs[0].domain, 'example.com');
    assert.equal(setCookieArgs[0].path, '/');
    assert.equal(setCookieArgs[0].httpOnly, true);
  } finally {
    restore();
  }
});

test('injectCookies 对 null/undefined cookies 不调用 setCookie', async () => {
  let setCookieCalled = false;
  const page = {
    async setCookie() {
      setCookieCalled = true;
    },
  };

  const { renderer, restore } = loadRendererWithPage(page);
  try {
    await renderer.injectCookies(page, 'https://example.com', null);
    assert.equal(setCookieCalled, false);
    await renderer.injectCookies(page, 'https://example.com', undefined);
    assert.equal(setCookieCalled, false);
  } finally {
    restore();
  }
});

test('injectCookies 对空字符串 cookies 不调用 setCookie', async () => {
  let setCookieCalled = false;
  const page = {
    async setCookie() {
      setCookieCalled = true;
    },
  };

  const { renderer, restore } = loadRendererWithPage(page);
  try {
    await renderer.injectCookies(page, 'https://example.com', '');
    assert.equal(setCookieCalled, false);
  } finally {
    restore();
  }
});

// ====== renderPage ======

test('renderPage 会设置视口并返回 html/title/finalUrl', async () => {
  let viewportArg = null;
  let gotoArgs = null;
  const page = {
    async setViewport(vp) { viewportArg = vp; },
    async setExtraHTTPHeaders() {},
    async goto(url, opts) { gotoArgs = { url, opts }; },
    async content() { return '<html>test</html>'; },
    async title() { return 'Test Page'; },
    url() { return 'https://example.com/final'; },
  };

  const { renderer, restore } = loadRendererWithPage(page);
  try {
    const result = await renderer.renderPage(null, {
      url: 'https://example.com',
      timeout: 5000,
    });

    assert.deepEqual(viewportArg, { width: 1440, height: 900, deviceScaleFactor: 1 });
    assert.equal(gotoArgs.url, 'https://example.com');
    assert.equal(gotoArgs.opts.waitUntil, 'networkidle2');
    assert.equal(gotoArgs.opts.timeout, 5000);
    assert.equal(result.html, '<html>test</html>');
    assert.equal(result.title, 'Test Page');
    assert.equal(result.finalUrl, 'https://example.com/final');
  } finally {
    restore();
  }
});

test('renderPage 会透传自定义 viewport', async () => {
  let viewportArg = null;
  const page = {
    async setViewport(vp) { viewportArg = vp; },
    async setExtraHTTPHeaders() {},
    async goto() {},
    async content() { return ''; },
    async title() { return ''; },
    url() { return ''; },
  };

  const { renderer, restore } = loadRendererWithPage(page);
  try {
    await renderer.renderPage(null, {
      url: 'https://example.com',
      viewport: { width: 375, height: 667, deviceScaleFactor: 2 },
    });

    assert.deepEqual(viewportArg, { width: 375, height: 667, deviceScaleFactor: 2 });
  } finally {
    restore();
  }
});

test('renderPage 会透传自定义 headers', async () => {
  let headersArg = null;
  const page = {
    async setViewport() {},
    async setExtraHTTPHeaders(h) { headersArg = h; },
    async goto() {},
    async content() { return ''; },
    async title() { return ''; },
    url() { return ''; },
  };

  const { renderer, restore } = loadRendererWithPage(page);
  try {
    await renderer.renderPage(null, {
      url: 'https://example.com',
      headers: { 'X-Custom': 'test' },
    });

    assert.deepEqual(headersArg, { 'X-Custom': 'test' });
  } finally {
    restore();
  }
});

// ====== screenshotPage ======

test('screenshotPage 会使用指定的格式和质量参数', async () => {
  let screenshotOpts = null;
  const page = {
    async setViewport() {},
    async setExtraHTTPHeaders() {},
    async goto() {},
    async screenshot(opts) {
      screenshotOpts = opts;
      return Buffer.from('img');
    },
  };

  const { renderer, restore } = loadRendererWithPage(page);
  try {
    const result = await renderer.screenshotPage(null, {
      url: 'https://example.com',
      format: 'jpeg',
      quality: 80,
      fullPage: false,
    });

    assert.equal(screenshotOpts.type, 'jpeg');
    assert.equal(screenshotOpts.quality, 80);
    assert.equal(screenshotOpts.fullPage, false);
    assert.equal(result.contentType, 'image/jpeg');
  } finally {
    restore();
  }
});

test('screenshotPage 在有 clip 参数时会忽略 fullPage', async () => {
  let screenshotOpts = null;
  const page = {
    async setViewport() {},
    async setExtraHTTPHeaders() {},
    async goto() {},
    async screenshot(opts) {
      screenshotOpts = opts;
      return Buffer.from('img');
    },
  };

  const { renderer, restore } = loadRendererWithPage(page);
  try {
    await renderer.screenshotPage(null, {
      url: 'https://example.com',
      fullPage: true,
      clip: { x: 0, y: 0, width: 100, height: 100 },
    });

    assert.equal(screenshotOpts.fullPage, false);
    assert.deepEqual(screenshotOpts.clip, { x: 0, y: 0, width: 100, height: 100 });
  } finally {
    restore();
  }
});

test('screenshotPage 对 png 格式不设置 quality', async () => {
  let screenshotOpts = null;
  const page = {
    async setViewport() {},
    async setExtraHTTPHeaders() {},
    async goto() {},
    async screenshot(opts) {
      screenshotOpts = opts;
      return Buffer.from('img');
    },
  };

  const { renderer, restore } = loadRendererWithPage(page);
  try {
    await renderer.screenshotPage(null, {
      url: 'https://example.com',
      format: 'png',
      quality: 80,
    });

    assert.equal(screenshotOpts.quality, undefined);
  } finally {
    restore();
  }
});

// ====== interceptRequests ======

test('interceptRequests 会等待异步响应体读取完成后再返回', async () => {
  const listeners = new Map();
  const page = {
    async setRequestInterception() {},
    on(event, handler) {
      listeners.set(event, handler);
    },
    async goto() {
      const handler = listeners.get('response');
      handler(createResponse({
        url: 'https://example.com/api/feed',
        contentType: 'application/json',
        body: { ok: true },
      }));
    },
    url() {
      return 'https://example.com/final';
    },
  };

  const { renderer, restore } = loadRendererWithPage(page);

  try {
    const result = await renderer.interceptRequests(null, {
      url: 'https://example.com',
      listenUrls: ['/api/feed'],
      timeout: 1000,
    });

    assert.equal(result.captured.length, 1);
    assert.deepEqual(result.captured[0].body, { ok: true });
  } finally {
    restore();
  }
});

test('interceptRequests 会按 fileTypes 筛选资源文件', async () => {
  const listeners = new Map();
  const page = {
    async setRequestInterception() {},
    on(event, handler) {
      listeners.set(event, handler);
    },
    async goto() {
      const handler = listeners.get('response');
      handler(createResponse({
        url: 'https://cdn.example.com/image.png',
        contentType: 'image/png',
        body: 'img-data',
      }));
      handler(createResponse({
        url: 'https://cdn.example.com/style.css',
        contentType: 'text/css',
        body: 'css-data',
      }));
    },
    url() { return 'https://example.com'; },
  };

  const { renderer, restore } = loadRendererWithPage(page);
  try {
    const result = await renderer.interceptRequests(null, {
      url: 'https://example.com',
      fileTypes: ['image'],
      timeout: 1000,
    });

    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].contentType, 'image/png');
  } finally {
    restore();
  }
});

// ====== fetchFile ======

test('fetchFile 会等待文件缓冲区读取完成后再返回', async () => {
  const listeners = new Map();
  const page = {
    async setRequestInterception() {},
    on(event, handler) {
      listeners.set(event, handler);
    },
    async goto() {
      const handler = listeners.get('response');
      handler(createResponse({
        url: 'https://cdn.example.com/file.bin',
        contentType: 'application/octet-stream',
        body: 'payload',
      }));
    },
  };

  const { renderer, restore } = loadRendererWithPage(page);

  try {
    const result = await renderer.fetchFile(null, {
      url: 'https://example.com',
      fileUrl: 'https://cdn.example.com/file.bin',
      timeout: 1000,
    });

    assert.equal(result.buffer.toString(), 'payload');
    assert.equal(result.contentType, 'application/octet-stream');
  } finally {
    restore();
  }
});

test('fetchFile 使用 _any_ 会匹配任意响应', async () => {
  const listeners = new Map();
  const page = {
    async setRequestInterception() {},
    on(event, handler) {
      listeners.set(event, handler);
    },
    async goto() {
      const handler = listeners.get('response');
      handler(createResponse({
        url: 'https://cdn.example.com/any-resource.dat',
        contentType: 'application/octet-stream',
        body: 'any-data',
      }));
    },
  };

  const { renderer, restore } = loadRendererWithPage(page);
  try {
    const result = await renderer.fetchFile(null, {
      url: 'https://example.com',
      fileUrl: '_any_',
      timeout: 1000,
    });

    assert.equal(result.buffer.toString(), 'any-data');
  } finally {
    restore();
  }
});

test('fetchFile 在未匹配到目标文件时返回 null buffer', async () => {
  const listeners = new Map();
  const page = {
    async setRequestInterception() {},
    on(event, handler) {
      listeners.set(event, handler);
    },
    async goto() {
      const handler = listeners.get('response');
      handler(createResponse({
        url: 'https://cdn.example.com/other.bin',
        contentType: 'application/octet-stream',
        body: 'data',
      }));
    },
  };

  const { renderer, restore } = loadRendererWithPage(page);
  try {
    const result = await renderer.fetchFile(null, {
      url: 'https://example.com',
      fileUrl: 'https://cdn.example.com/target.bin',
      timeout: 1000,
    });

    assert.equal(result.buffer, null);
  } finally {
    restore();
  }
});

// ====== createAsyncTaskTracker ======

test('createAsyncTaskTracker 会正确跟踪异步任务', async () => {
  const { renderer, restore } = loadRendererWithPage({});
  try {
    const tracker = renderer.createAsyncTaskTracker();
    let resolved = false;

    tracker.track(new Promise((resolve) => {
      setTimeout(() => {
        resolved = true;
        resolve();
      }, 50);
    }));

    assert.equal(resolved, false);
    await tracker.waitForIdle();
    assert.equal(resolved, true);
  } finally {
    restore();
  }
});
