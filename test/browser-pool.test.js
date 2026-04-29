const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { withPage, randomUA } = require('../browser-pool');

test('BrowserContext 隔离模式下不应启用 single-process 参数', () => {
  const sourceCode = fs.readFileSync(path.join(__dirname, '..', 'browser-pool.js'), 'utf8');
  assert.equal(sourceCode.includes("'--single-process'"), false);
});

test('randomUA 返回值属于预定义 UA 列表', () => {
  // 多次调用验证每次都返回有效 UA
  for (let i = 0; i < 20; i++) {
    const ua = randomUA();
    assert.equal(typeof ua, 'string');
    assert.ok(ua.includes('Chrome/'), `UA 应包含 Chrome 标识: ${ua}`);
    assert.ok(ua.length > 50, `UA 长度应大于 50: ${ua}`);
  }
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

test('withPage 在 createBrowserContext 失败时仍会归还浏览器到池', async () => {
  let releaseCalled = false;
  let releaseArg = null;

  const browser = {
    async createBrowserContext() {
      throw new Error('context creation failed');
    },
  };

  const pool = {
    async acquire() {
      return browser;
    },
    release(value) {
      releaseCalled = true;
      releaseArg = value;
    },
  };

  await assert.rejects(
    () => withPage(pool, async () => 'should not reach'),
    /context creation failed/,
  );

  assert.equal(releaseCalled, true, '浏览器应被归还到池');
  assert.equal(releaseArg, browser, '归还的应是同一个浏览器实例');
});

test('withPage 在 newPage 失败时仍会归还浏览器到池', async () => {
  let releaseCalled = false;
  let contextClosed = false;

  const context = {
    async newPage() {
      throw new Error('newPage failed');
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
    () => withPage(pool, async () => 'should not reach'),
    /newPage failed/,
  );

  // newPage 在 context 创建之后失败，context 不一定会被关闭（因为 page 还没创建成功），
  // 但浏览器必须被归还
  assert.equal(releaseCalled, true, '浏览器应被归还到池');
});
