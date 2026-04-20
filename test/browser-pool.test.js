const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { withPage } = require('../browser-pool');

test('BrowserContext 隔离模式下不应启用 single-process 参数', () => {
  const sourceCode = fs.readFileSync(path.join(__dirname, '..', 'browser-pool.js'), 'utf8');
  assert.equal(sourceCode.includes("'--single-process'"), false);
});

test('withPage 会为每次请求创建独立浏览器上下文并在结束后关闭', async () => {
  let releaseArg = null;
  let contextClosed = false;

  const page = {
    async setExtraHTTPHeaders() {},
  };

  const context = {
    async newPage() {
      return page;
    },
    async close() {
      contextClosed = true;
    },
  };

  const browser = {
    async createBrowserContext() {
      return context;
    },
  };

  const pool = {
    async acquire() {
      return browser;
    },
    release(value) {
      releaseArg = value;
    },
  };

  const result = await withPage(pool, async (actualPage) => {
    assert.equal(actualPage, page);
    return 'ok';
  });

  assert.equal(result, 'ok');
  assert.equal(contextClosed, true);
  assert.equal(releaseArg, browser);
});

test('withPage 即使业务逻辑抛错也会释放上下文和浏览器', async () => {
  let releaseCalled = false;
  let contextClosed = false;

  const context = {
    async newPage() {
      return {};
    },
    async close() {
      contextClosed = true;
    },
  };

  const pool = {
    async acquire() {
      return {
        async createBrowserContext() {
          return context;
        },
      };
    },
    release() {
      releaseCalled = true;
    },
  };

  await assert.rejects(
    () => withPage(pool, async () => {
      throw new Error('boom');
    }),
    /boom/,
  );

  assert.equal(contextClosed, true);
  assert.equal(releaseCalled, true);
});
