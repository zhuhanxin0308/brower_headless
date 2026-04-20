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
