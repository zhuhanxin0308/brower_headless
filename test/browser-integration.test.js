const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');
const { createBrowserPool } = require('../browser-pool');
const { buildApp } = require('../app');

const executablePath = process.env.BROWSER_TEST_EXECUTABLE;
const TEST_TIMEOUT_MS = 30000;
const OPERATION_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 10;

async function waitUntil(predicate) {
  const deadline = performance.now() + OPERATION_TIMEOUT_MS;
  while (!predicate() && performance.now() < deadline) await delay(POLL_INTERVAL_MS);
  assert.equal(predicate(), true, '浏览器资源未在限定时间内到达预期状态');
}

test('真实 Chromium 验证渲染、隔离、截图、捕获和超时后资源恢复', {
  skip: !executablePath,
  timeout: TEST_TIMEOUT_MS,
}, async (t) => {
  const file = Buffer.alloc(64 * 1024, 'f');
  let hangingConnections = 0;
  const origin = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/api/data') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ value: 42 }));
    } else if (pathname === '/file.bin') {
      response.setHeader('Content-Type', 'application/octet-stream');
      response.end(file);
    } else if (pathname === '/slow.bin') {
      hangingConnections += 1;
      response.setHeader('Content-Type', 'application/octet-stream');
      response.write('pending');
      response.once('close', () => { hangingConnections -= 1; });
    } else {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      const target = pathname === '/slow' ? '/slow.bin' : '/file.bin';
      response.end(`<!doctype html><title>浏览器验证</title><body><h1>渲染完成</h1>
        <div id="state"></div><script>
        // 每次页面访问都显示当前上下文中的会话和本地计数。
        const count = Number(localStorage.getItem('count') || 0) + 1;
        localStorage.setItem('count', count);
        document.getElementById('state').textContent = document.cookie + '|count=' + count;
        fetch('/api/data').then(response => response.json()).then(data => {
          document.body.setAttribute('data-ready', String(data.value));
        });
        fetch('${target}').then(response => response.arrayBuffer());
        </script></body>`);
    }
  });
  await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    origin.close(resolve);
    origin.closeAllConnections();
  }));
  const baseUrl = `http://127.0.0.1:${origin.address().port}`;
  const pool = createBrowserPool({ executablePath, minBrowsers: 1, maxBrowsers: 1, maxPendingAcquires: 2 });
  const app = buildApp({ logger: false, apiKey: '', allowPrivateNetwork: true,
    minBrowsers: 1, maxBrowsers: 1, maxPendingAcquires: 2, browserPoolFactory: () => pool });
  t.after(() => app.close());
  const browser = await pool.acquire();
  await pool.release(browser);
  const initialContexts = browser.browserContexts().length;

  async function invoke(path, payload) {
    return app.inject({ method: 'POST', url: path,
      payload: { url: `${baseUrl}/page`, totalTimeout: OPERATION_TIMEOUT_MS, ...payload } });
  }

  await t.test('动态 HTML 执行完成且独立上下文不共享 Cookie 和本地存储', async () => {
    const first = await invoke('/render', { cookies: 'session=first' });
    assert.equal(first.statusCode, 200, first.body);
    assert.match(first.json().html, /data-ready="42"/);
    assert.match(first.json().html, /session=first\|count=1/);
    const second = await invoke('/render', {});
    assert.equal(second.statusCode, 200, second.body);
    assert.match(second.json().html, />\|count=1</);
    assert.doesNotMatch(second.json().html, /session=first/);
  });

  await t.test('三种截图格式均生成有效图片', async () => {
    for (const format of ['png', 'jpeg', 'webp']) {
      const result = await invoke('/screenshot', {
        format, waitFor: 'load', viewport: { width: 320, height: 240 },
      });
      assert.equal(result.statusCode, 200, result.body.slice(0, 100));
      assert.equal(result.headers['content-type'], `image/${format}`);
      assert.ok(result.rawPayload.length > 100);
      if (format === 'png') assert.equal(result.rawPayload.subarray(1, 4).toString(), 'PNG');
      if (format === 'jpeg') assert.equal(result.rawPayload.readUInt16BE(0), 0xffd8);
      if (format === 'webp') assert.equal(result.rawPayload.subarray(8, 12).toString(), 'WEBP');
    }
  });

  await t.test('取消全量请求拦截后仍能采集 JSON 响应和文件正文', async () => {
    const intercepted = await invoke('/intercept', { listenUrls: ['/api/data', '/api/'], fileTypes: ['json'] });
    assert.equal(intercepted.statusCode, 200, intercepted.body);
    assert.equal(intercepted.json().captured.length, 2);
    assert.deepEqual(intercepted.json().captured.map((item) => item.body), [{ value: 42 }, { value: 42 }]);
    const downloaded = await invoke('/fetch-file', { fileUrl: `${baseUrl}/file.bin` });
    assert.equal(downloaded.statusCode, 200);
    assert.deepEqual(downloaded.rawPayload, file);
  });

  await t.test('总时限关闭未结束的文件响应且后续请求恢复', async () => {
    const timedOut = await invoke('/fetch-file', {
      url: `${baseUrl}/slow`, fileUrl: `${baseUrl}/slow.bin`, totalTimeout: 1500,
    });
    assert.equal(timedOut.statusCode, 504, timedOut.body);
    assert.equal(pool.borrowed, 0);
    assert.equal(browser.browserContexts().length, initialContexts);
    // 上下文关闭的协议回复和服务端 TCP close 通知不保证在同一个事件循环到达。
    await waitUntil(() => hangingConnections === 0);
    const recovered = await invoke('/render', { waitFor: 'load' });
    assert.equal(recovered.statusCode, 200, recovered.body);
    assert.equal(pool.borrowed, 0);
    assert.equal(browser.browserContexts().length, initialContexts);
  });

  await t.test('真实请求排队取消及时腾出队列，客户端断连后释放浏览器', async () => {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();
    const address = `http://127.0.0.1:${app.server.address().port}/fetch-file`;
    const running = fetch(address, { method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: `${baseUrl}/slow`, fileUrl: `${baseUrl}/slow.bin`,
        totalTimeout: TEST_TIMEOUT_MS }),
    }).catch((error) => error);
    try {
      await waitUntil(() => hangingConnections === 1 && pool.borrowed === 1);
      assert.equal(hangingConnections, 1);
      const waiting = await invoke('/render', { totalTimeout: 50 });
      assert.equal(waiting.statusCode, 504, waiting.body);
      assert.equal(pool.pending, 0);
      assert.equal(pool.borrowed, 1);
    } finally {
      controller.abort();
      await running;
    }
    await waitUntil(() => pool.borrowed === 0);
    assert.equal(pool.borrowed, 0);
    assert.equal(browser.browserContexts().length, initialContexts);
    const recovered = await invoke('/render', { waitFor: 'load' });
    assert.equal(recovered.statusCode, 200, recovered.body);
  });
});
