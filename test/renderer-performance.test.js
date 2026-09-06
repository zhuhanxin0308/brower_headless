const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createHook } = require('node:async_hooks');

function loadRenderer(page, onWithPage = () => {}) {
  const poolPath = require.resolve('../browser-pool');
  const rendererPath = require.resolve('../renderer');
  const previousPool = require.cache[poolPath];
  const previousRenderer = require.cache[rendererPath];
  delete require.cache[rendererPath];
  require.cache[poolPath] = {
    id: poolPath,
    filename: poolPath,
    loaded: true,
    exports: {
      withPage: async (_pool, callback, options) => {
        onWithPage(options);
        return callback(page);
      },
    },
  };
  return {
    renderer: require(rendererPath),
    restore() {
      if (previousPool) require.cache[poolPath] = previousPool;
      else delete require.cache[poolPath];
      if (previousRenderer) require.cache[rendererPath] = previousRenderer;
      else delete require.cache[rendererPath];
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createPage(onNavigate = () => {}) {
  const page = new EventEmitter();
  page.setViewport = async () => {};
  page.setExtraHTTPHeaders = async () => {};
  page.goto = async (_url, options) => onNavigate(page, options);
  page.content = async () => '<html></html>';
  page.title = async () => '测试页面';
  page.url = () => 'https://example.com';
  page.screenshot = async () => Buffer.from('image');
  page.interceptionCount = 0;
  page.setRequestInterception = async () => { page.interceptionCount++; };
  return page;
}

function fileResponse(name, readBuffer, headers = {}) {
  return {
    url: () => `https://example.com/${name}`,
    headers: () => ({ 'content-type': 'application/octet-stream', ...headers }),
    status: () => 200,
    buffer: readBuffer,
  };
}

test('四种浏览器操作都把取消信号交给浏览器生命周期管理', async () => {
  const controller = new AbortController();
  const received = [];
  const { renderer, restore } = loadRenderer(createPage(), options => received.push(options));
  try {
    const options = { url: 'https://example.com', fileUrl: '_any_', signal: controller.signal };
    await renderer.renderPage(null, options);
    await renderer.screenshotPage(null, options);
    await renderer.interceptRequests(null, options);
    await renderer.fetchFile(null, options);
    assert.equal(received.length, 4);
    for (const options of received) assert.equal(options.signal, controller.signal);
  } finally {
    restore();
  }
});

test('响应监听与文件获取不启用请求拦截', async () => {
  const page = createPage();
  const { renderer, restore } = loadRenderer(page);
  try {
    await renderer.interceptRequests(null, { url: 'https://example.com' });
    await renderer.fetchFile(null, { url: 'https://example.com', fileUrl: '_any_' });
    assert.equal(page.interceptionCount, 0);
  } finally {
    restore();
  }
});

test('重叠监听模式只解析一次正文并保留每个模式对应的记录', async () => {
  let jsonReads = 0;
  const page = createPage(page => page.emit('response', {
    url: () => 'https://example.com/api/feed',
    headers: () => ({ 'content-type': 'application/json' }),
    status: () => 200,
    json: async () => { jsonReads++; return { id: 1 }; },
  }));
  const { renderer, restore } = loadRenderer(page);
  try {
    const result = await renderer.interceptRequests(null, {
      url: 'https://example.com', listenUrls: ['/api/', '/api/feed', '/api/feed'],
    });
    assert.equal(jsonReads, 1);
    assert.equal(result.captured.length, 3);
    for (const captured of result.captured) assert.deepEqual(captured.body, { id: 1 });
    assert.equal(page.listenerCount('response'), 0);
  } finally {
    restore();
  }
});

test('重叠文本监听与读取失败仍保留原有响应记录数量', async () => {
  let textReads = 0;
  const page = createPage(page => page.emit('response', {
    url: () => 'https://example.com/data',
    headers: () => ({ 'content-type': 'text/plain' }),
    status: () => 502,
    text: async () => { textReads++; throw new Error('读取失败'); },
  }));
  const { renderer, restore } = loadRenderer(page);
  try {
    const result = await renderer.interceptRequests(null, {
      url: 'https://example.com', listenUrls: ['/data', '/data'],
    });
    assert.equal(textReads, 1);
    assert.equal(result.captured.length, 2);
    assert.ok(result.captured.every(item => item.body === null && item.status === 502));
  } finally {
    restore();
  }
});

test('完全不匹配的响应与仅收集文件元数据的响应不分配异步读取任务', async () => {
  async function measure(responseCount, fileTypes) {
    const page = createPage(page => {
      for (let index = 0; index < responseCount; index++) {
        page.emit('response', fileResponse(`image-${index}`, () => assert.fail('不应读取正文'), {
          'content-type': 'image/png',
        }));
      }
    });
    const { renderer, restore } = loadRenderer(page);
    let promiseCount = 0;
    const hook = createHook({ init(_id, type) { if (type === 'PROMISE') promiseCount++; } });
    try {
      hook.enable();
      const result = await renderer.interceptRequests(null, {
        url: 'https://example.com', listenUrls: ['/api/'], fileTypes,
      });
      hook.disable();
      return { promiseCount, fileCount: result.files.length };
    } finally {
      hook.disable();
      restore();
    }
  }
  // 先让测试调度器完成首次异步切换，避免把启动阶段的 Promise 计入基线。
  await measure(0, []);
  const empty = await measure(0, []);
  const unmatched = await measure(100, []);
  const metadata = await measure(100, ['image']);
  assert.equal(unmatched.promiseCount, empty.promiseCount);
  assert.equal(metadata.promiseCount, empty.promiseCount);
  assert.equal(metadata.fileCount, 100);
});

test('任意文件按到达顺序读取且首个成功后不读取或覆盖后续候选', async () => {
  const firstRead = deferred();
  const navigationStarted = deferred();
  const reads = [];
  const page = createPage(page => {
    page.emit('response', fileResponse('first', () => { reads.push('first'); return firstRead.promise; }));
    page.emit('response', fileResponse('second', async () => { reads.push('second'); return Buffer.from('second'); }));
    navigationStarted.resolve();
  });
  const { renderer, restore } = loadRenderer(page);
  try {
    const request = renderer.fetchFile(null, { url: 'https://example.com', fileUrl: '_any_' });
    await navigationStarted.promise;
    assert.deepEqual(reads, ['first']);
    firstRead.resolve(Buffer.from('first'));
    const result = await request;
    assert.equal(result.buffer.toString(), 'first');
    assert.deepEqual(reads, ['first']);
    assert.equal(page.listenerCount('response'), 0);
  } finally {
    firstRead.resolve(Buffer.from('first'));
    restore();
  }
});

test('前序文件读取失败后才尝试后续候选且不会被更晚失败覆盖', async () => {
  const firstRead = deferred();
  const navigationStarted = deferred();
  const reads = [];
  const page = createPage(page => {
    page.emit('response', fileResponse('first', () => { reads.push('first'); return firstRead.promise; }));
    page.emit('response', fileResponse('second', async () => { reads.push('second'); return Buffer.from('second'); }));
    page.emit('response', fileResponse('third', async () => { reads.push('third'); throw new Error('第三个失败'); }));
    navigationStarted.resolve();
  });
  const { renderer, restore } = loadRenderer(page);
  try {
    const request = renderer.fetchFile(null, { url: 'https://example.com', fileUrl: '_any_' });
    await navigationStarted.promise;
    firstRead.reject(new Error('首个读取失败'));
    const result = await request;
    assert.equal(result.buffer.toString(), 'second');
    assert.deepEqual(reads, ['first', 'second']);
  } finally {
    firstRead.resolve(Buffer.from('unused'));
    restore();
  }
});

test('候选全部读取失败时返回空结果并支持后续到达的候选', async () => {
  const reads = [];
  const page = createPage(async page => {
    page.emit('response', fileResponse('first', () => { reads.push('first'); throw new Error('同步读取失败'); }));
    page.emit('response', fileResponse('second', async () => { reads.push('second'); throw new Error('异步读取失败'); }));
    await new Promise(resolve => setImmediate(resolve));
    page.emit('response', fileResponse('third', async () => { reads.push('third'); throw new Error('后续读取失败'); }));
  });
  const { renderer, restore } = loadRenderer(page);
  try {
    const result = await renderer.fetchFile(null, { url: 'https://example.com', fileUrl: '_any_' });
    assert.equal(result.buffer, null);
    assert.deepEqual(reads, ['first', 'second', 'third']);
  } finally {
    restore();
  }
});

test('首个成功的空文件也会终止后续候选读取', async () => {
  const page = createPage(page => {
    page.emit('response', fileResponse('empty', async () => Buffer.alloc(0)));
    page.emit('response', fileResponse('later', () => assert.fail('空文件成功后不能再读取')));
  });
  const { renderer, restore } = loadRenderer(page);
  try {
    const result = await renderer.fetchFile(null, { url: 'https://example.com', fileUrl: '_any_' });
    assert.equal(result.buffer.length, 0);
  } finally {
    restore();
  }
});

test('候选文件超限必须返回413且不能跳过后继续读取', async () => {
  for (const declaredLength of [undefined, '20']) {
    let laterReads = 0;
    const page = createPage(page => {
      page.emit('response', fileResponse('large', async () => Buffer.alloc(20), {
        'content-length': declaredLength,
      }));
      page.emit('response', fileResponse('small', async () => { laterReads++; return Buffer.from('ok'); }));
    });
    const { renderer, restore } = loadRenderer(page);
    try {
      await assert.rejects(renderer.fetchFile(null, {
        url: 'https://example.com', fileUrl: '_any_', maxBytes: 10,
      }), error => error.statusCode === 413);
      assert.equal(laterReads, 0);
    } finally {
      restore();
    }
  }
});

test('候选队列容量只计算待处理项且溢出后返回503并停止收集', async () => {
  const firstRead = deferred();
  let laterReads = 0;
  const page = createPage(page => {
    page.emit('response', fileResponse('first', () => firstRead.promise));
    page.emit('response', fileResponse('waiting', async () => { laterReads++; return Buffer.from('waiting'); }));
    page.emit('response', fileResponse('overflow', async () => { laterReads++; return Buffer.from('overflow'); }));
  });
  const { renderer, restore } = loadRenderer(page);
  try {
    await assert.rejects(renderer.fetchFile(null, {
      url: 'https://example.com', fileUrl: '_any_', maxPendingResponses: 1,
    }), error => error.statusCode === 503 && /候选/.test(error.message));
    firstRead.resolve(Buffer.from('first'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(laterReads, 0);
    assert.equal(page.listenerCount('response'), 0);
  } finally {
    firstRead.resolve(Buffer.from('first'));
    restore();
  }
});

test('当前读取不占候选队列容量且默认容量对外导出', async () => {
  const firstRead = deferred();
  const page = createPage(page => {
    page.emit('response', fileResponse('first', () => firstRead.promise));
    page.emit('response', fileResponse('waiting', async () => Buffer.from('waiting')));
    firstRead.reject(new Error('首个失败'));
  });
  const { renderer, restore } = loadRenderer(page);
  try {
    assert.equal(renderer.DEFAULT_MAX_PENDING_FILE_RESPONSES, 256);
    const result = await renderer.fetchFile(null, {
      url: 'https://example.com', fileUrl: '_any_', maxPendingResponses: 1,
    });
    assert.equal(result.buffer.toString(), 'waiting');
  } finally {
    firstRead.resolve(Buffer.from('unused'));
    restore();
  }
});

test('取消文件读取时保留原始取消原因且不再启动排队的候选', async () => {
  const controller = new AbortController();
  const firstRead = deferred();
  const navigationStarted = deferred();
  const reason = new Error('整体截止时间已到');
  reason.statusCode = 504;
  let laterReads = 0;
  const page = createPage(page => {
    page.emit('response', fileResponse('first', () => firstRead.promise));
    page.emit('response', fileResponse('later', async () => { laterReads++; return Buffer.from('later'); }));
    navigationStarted.resolve();
  });
  const { renderer, restore } = loadRenderer(page);
  try {
    const request = renderer.fetchFile(null, {
      url: 'https://example.com', fileUrl: '_any_', signal: controller.signal,
    });
    await navigationStarted.promise;
    // 导航已经结束，确保取消发生在正文读取等待阶段。
    await new Promise(resolve => setImmediate(resolve));
    controller.abort(reason);
    await assert.rejects(request, error => error === reason);
    firstRead.reject(new Error('关闭页面引发读取失败'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(laterReads, 0);
    assert.equal(page.listenerCount('response'), 0);
  } finally {
    firstRead.resolve(Buffer.from('unused'));
    restore();
  }
});

test('取消响应正文等待时不转换原始原因也不继续发布迟到结果', async () => {
  const controller = new AbortController();
  const body = deferred();
  const navigationStarted = deferred();
  const reason = new Error('请求已取消');
  let reads = 0;
  const page = createPage(page => {
    page.emit('response', {
      url: () => 'https://example.com/api', headers: () => ({ 'content-type': 'application/json' }),
      status: () => 200, json: () => { reads++; return body.promise; },
    });
    navigationStarted.resolve();
  });
  const { renderer, restore } = loadRenderer(page);
  try {
    const request = renderer.interceptRequests(null, {
      url: 'https://example.com', listenUrls: ['/api', '/api'], signal: controller.signal,
    });
    await navigationStarted.promise;
    await new Promise(resolve => setImmediate(resolve));
    controller.abort(reason);
    await assert.rejects(request, error => error === reason);
    body.resolve({ late: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, 1);
    assert.equal(page.listenerCount('response'), 0);
  } finally {
    body.resolve({ late: true });
    restore();
  }
});

test('已取消的操作不启动页面工作且保留原始原因', async () => {
  const controller = new AbortController();
  const reason = new Error('启动前已经取消');
  controller.abort(reason);
  const page = createPage(() => assert.fail('已取消时不能导航'));
  const { renderer, restore } = loadRenderer(page);
  try {
    const options = { url: 'https://example.com', fileUrl: '_any_', signal: controller.signal };
    for (const operation of ['renderPage', 'screenshotPage', 'interceptRequests', 'fetchFile']) {
      await assert.rejects(renderer[operation](null, options), error => error === reason);
    }
    assert.equal(page.listenerCount('response'), 0);
  } finally {
    restore();
  }
});

test('文件候选容量必须是正整数且配置错误不创建页面', async () => {
  const { renderer, restore } = loadRenderer(createPage(), () => assert.fail('配置非法时不能创建页面'));
  try {
    for (const maxPendingResponses of [0, -1, 1.5, 'invalid']) {
      await assert.rejects(renderer.fetchFile(null, {
        url: 'https://example.com', fileUrl: '_any_', maxPendingResponses,
      }), RangeError);
    }
  } finally {
    restore();
  }
});

test('导航失败会保留原异常并解除响应监听', async () => {
  const reason = new Error('原始导航失败');
  const page = createPage(() => { throw reason; });
  const { renderer, restore } = loadRenderer(page);
  try {
    for (const operation of ['interceptRequests', 'fetchFile']) {
      await assert.rejects(renderer[operation](null, {
        url: 'https://example.com', fileUrl: '_any_',
      }), error => error === reason);
      assert.equal(page.listenerCount('response'), 0);
    }
  } finally {
    restore();
  }
});
