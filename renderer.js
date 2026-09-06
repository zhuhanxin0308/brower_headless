const { withPage } = require('./browser-pool');

const DEFAULT_MAX_PENDING_FILE_RESPONSES = 256;

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason;
  }
}

// 取消只结束当前等待，浏览器生命周期管理负责关闭页面及终止底层读取。
function waitWithSignal(task, signal) {
  if (!signal) {
    return task;
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(task).then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
    if (signal.aborted) {
      onAbort();
    }
  });
}

function createPayloadTooLargeError(maxBytes) {
  const error = new Error(`目标文件超过大小限制，最大允许 ${maxBytes} 字节`);
  error.statusCode = 413;
  return error;
}

function normalizeMaxBytes(maxBytes) {
  const parsedValue = Number(maxBytes);
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : null;
}

function parseContentLength(headers) {
  const rawValue = headers['content-length'];
  if (rawValue == null || rawValue === '') {
    return null;
  }

  const parsedValue = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsedValue) && parsedValue >= 0 ? parsedValue : null;
}

function exceedsMaxBytes(size, maxBytes) {
  return maxBytes != null && size != null && size > maxBytes;
}

async function injectCookies(page, url, cookies) {
  if (!cookies) {
    return;
  }

  let cookieList = [];
  const domain = new URL(url).hostname;

  if (typeof cookies === 'string') {
    cookieList = cookies.split(';').map((pair) => {
      const [name, ...rest] = pair.trim().split('=');
      return { name: name.trim(), value: rest.join('=').trim(), domain };
    }).filter((cookie) => cookie.name);
  } else if (Array.isArray(cookies)) {
    cookieList = cookies.map((cookie) => ({ domain, path: '/', ...cookie }));
  }

  if (cookieList.length > 0) {
    await page.setCookie(...cookieList);
  }
}

// 事件回调里的异步读取不会被 page.goto 自动等待，这里显式跟踪所有待完成任务。
function createAsyncTaskTracker() {
  const pendingTasks = new Set();

  return {
    track(task) {
      const wrappedTask = Promise.resolve(task)
        .finally(() => {
          pendingTasks.delete(wrappedTask);
        });

      pendingTasks.add(wrappedTask);
      return wrappedTask;
    },
    async waitForIdle(signal) {
      throwIfAborted(signal);
      while (pendingTasks.size > 0) {
        await waitWithSignal(Promise.allSettled([...pendingTasks]), signal);
      }
      throwIfAborted(signal);
    },
  };
}

function shouldBlockRequest(request, blockedResourceTypes, blockedUrlPatterns) {
  const resourceType = request.resourceType();
  const requestUrl = request.url();

  return blockedResourceTypes.has(resourceType)
    || blockedUrlPatterns.some((pattern) => requestUrl.includes(pattern));
}

async function applyRequestBlocking(page, {
  blockedResourceTypes = [],
  blockedUrlPatterns = [],
} = {}) {
  const resourceTypeSet = new Set(blockedResourceTypes.filter(Boolean));
  const urlPatterns = blockedUrlPatterns.filter(Boolean);

  if (resourceTypeSet.size === 0 && urlPatterns.length === 0) {
    return;
  }

  await page.setRequestInterception(true);
  page.on('request', async (request) => {
    try {
      if (shouldBlockRequest(request, resourceTypeSet, urlPatterns)) {
        await request.abort();
        return;
      }

      await request.continue();
    } catch {
      // 请求可能已经被 Chromium 取消，忽略单个资源的拦截失败以保证主流程继续。
    }
  });
}

async function renderPage(pool, {
  url,
  waitFor,
  timeout = 15000,
  headers = {},
  cookies,
  viewport = { width: 1440, height: 900, deviceScaleFactor: 1 },
  signal,
}) {
  return withPage(pool, async (page) => {
    throwIfAborted(signal);
    await page.setViewport(viewport);

    if (Object.keys(headers).length > 0) {
      await page.setExtraHTTPHeaders(headers);
    }

    await injectCookies(page, url, cookies);
    throwIfAborted(signal);

    await page.goto(url, {
      waitUntil: waitFor || 'networkidle2',
      timeout,
    });
    throwIfAborted(signal);

    const html = await page.content();
    const title = await page.title();
    const finalUrl = page.url();

    return { html, title, finalUrl };
  }, { signal });
}

async function screenshotPage(pool, {
  url,
  waitFor,
  timeout = 20000,
  headers = {},
  cookies,
  format = 'png',
  fullPage = true,
  quality,
  clip,
  viewport = { width: 1440, height: 900, deviceScaleFactor: 1 },
  blockedResourceTypes = [],
  blockedUrlPatterns = [],
  signal,
}) {
  return withPage(pool, async (page) => {
    throwIfAborted(signal);
    await page.setViewport(viewport);
    await applyRequestBlocking(page, { blockedResourceTypes, blockedUrlPatterns });

    if (Object.keys(headers).length > 0) {
      await page.setExtraHTTPHeaders(headers);
    }

    await injectCookies(page, url, cookies);
    throwIfAborted(signal);

    await page.goto(url, {
      waitUntil: waitFor || 'networkidle2',
      timeout,
    });
    throwIfAborted(signal);

    const shotOptions = { type: format, fullPage };

    if ((format === 'jpeg' || format === 'webp') && quality != null) {
      shotOptions.quality = quality;
    }

    if (clip) {
      shotOptions.clip = clip;
      shotOptions.fullPage = false;
    }

    const buffer = await page.screenshot(shotOptions);
    const mimeMap = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };

    return { buffer, contentType: mimeMap[format] || 'image/png' };
  }, { signal });
}

async function interceptRequests(pool, {
  url, waitFor, listenUrls = [], fileTypes = [], timeout = 20000, headers = {}, cookies, signal,
}) {
  return withPage(pool, async (page) => {
    throwIfAborted(signal);
    const captured = [];
    const files = [];
    const tracker = createAsyncTaskTracker();
    let stopped = false;

    const fileMimeMap = {
      image: ['image/'],
      video: ['video/'],
      audio: ['audio/'],
      pdf: ['application/pdf'],
      json: ['application/json'],
      css: ['text/css'],
      js: ['application/javascript', 'text/javascript'],
      font: ['font/', 'application/font'],
    };

    const watchMimes = fileTypes.flatMap((type) => fileMimeMap[type] || []);

    const onResponse = (response) => {
      if (stopped || signal?.aborted) {
        return;
      }

      const responseUrl = response.url();
      let matchCount = 0;
      for (const pattern of listenUrls) {
        if (responseUrl.includes(pattern)) {
          matchCount++;
        }
      }
      if (matchCount === 0 && watchMimes.length === 0) {
        return;
      }

      const contentType = response.headers()['content-type'] || '';
      const matchesFile = watchMimes.some((mime) => contentType.startsWith(mime));
      if (matchCount === 0 && !matchesFile) {
        return;
      }
      const status = response.status();

      // 元数据收集无需异步任务，未命中的响应也不进入正文读取队列。
      if (matchesFile) {
        files.push({ url: responseUrl, contentType, status });
      }
      if (matchCount === 0) {
        return;
      }

      tracker.track((async () => {
        let body = null;
        try {
          body = contentType.includes('application/json')
            ? await response.json()
            : await response.text();
        } catch {
          // 保留原有读取失败返回空正文的契约，取消由外层等待保留原始原因。
        }
        if (stopped || signal?.aborted) {
          return;
        }

        // 正文只读取一次，仍按原契约为每个匹配模式保留一条响应记录。
        for (let index = 0; index < matchCount; index++) {
          captured.push({ url: responseUrl, status, contentType, body });
        }
      })());
    };

    page.on('response', onResponse);
    try {
      if (Object.keys(headers).length > 0) {
        await page.setExtraHTTPHeaders(headers);
      }
      await injectCookies(page, url, cookies);
      throwIfAborted(signal);
      await page.goto(url, { waitUntil: waitFor || 'networkidle2', timeout });
      await tracker.waitForIdle(signal);
      return { finalUrl: page.url(), captured, files };
    } finally {
      stopped = true;
      page.off?.('response', onResponse);
    }
  }, { signal });
}

async function fetchFile(pool, {
  url, fileUrl, waitFor, timeout = 20000, cookies, maxBytes, signal,
  maxPendingResponses = DEFAULT_MAX_PENDING_FILE_RESPONSES,
}) {
  const pendingLimit = Number(maxPendingResponses);
  if (!Number.isInteger(pendingLimit) || pendingLimit <= 0) {
    throw new RangeError('候选文件队列容量必须为正整数');
  }

  return withPage(pool, async (page) => {
    throwIfAborted(signal);
    let fileBuffer = null;
    let contentType = '';
    let fileError = null;
    let stopped = false;
    let reading = false;
    const candidates = [];
    const normalizedMaxBytes = normalizeMaxBytes(maxBytes);
    const tracker = createAsyncTaskTracker();
    let rejectFileFailure;
    const fileFailure = new Promise((_resolve, reject) => {
      rejectFileFailure = reject;
    });
    // 导航开始前也可能收到响应，提前处理拒绝以避免事件阶段出现未处理异常。
    fileFailure.catch(() => {});

    const failFile = (error) => {
      if (!fileError) {
        fileError = error;
        candidates.length = 0;
        rejectFileFailure(error);
      }
    };

    async function readCandidates() {
      while (candidates.length > 0 && !stopped && !fileBuffer && !fileError && !signal?.aborted) {
        const response = candidates.shift();
        try {
          const headers = response.headers();
          const contentLength = parseContentLength(headers);
          if (exceedsMaxBytes(contentLength, normalizedMaxBytes)) {
            failFile(createPayloadTooLargeError(normalizedMaxBytes));
            return;
          }

          const buffer = await response.buffer();
          if (stopped || fileError || signal?.aborted) {
            return;
          }
          if (exceedsMaxBytes(buffer.length, normalizedMaxBytes)) {
            failFile(createPayloadTooLargeError(normalizedMaxBytes));
            return;
          }

          fileBuffer = buffer;
          contentType = headers['content-type'] || 'application/octet-stream';
          candidates.length = 0;
        } catch {
          // 普通正文读取失败才尝试下一个候选，容量超限及取消均不能跳过。
        }
      }
    }

    function startReading() {
      if (reading || stopped || fileBuffer || fileError || signal?.aborted || candidates.length === 0) {
        return;
      }
      reading = true;
      tracker.track((async () => {
        try {
          await readCandidates();
        } finally {
          reading = false;
          // 同步读取失败与任务结束之间到达的新候选仍需继续按顺序处理。
          startReading();
        }
      })());
    }

    const onResponse = (response) => {
      if (stopped || fileBuffer || fileError || signal?.aborted) {
        return;
      }
      if (fileUrl !== '_any_' && response.url() !== fileUrl) {
        return;
      }
      if (candidates.length >= pendingLimit) {
        const error = new Error(`候选文件队列已满，最大允许 ${pendingLimit} 个待处理响应`);
        error.statusCode = 503;
        failFile(error);
        return;
      }
      candidates.push(response);
      startReading();
    };
    const onAbort = () => { candidates.length = 0; };

    signal?.addEventListener('abort', onAbort, { once: true });
    page.on('response', onResponse);
    try {
      await injectCookies(page, url, cookies);
      throwIfAborted(signal);
      await Promise.race([
        page.goto(url, { waitUntil: waitFor || 'networkidle2', timeout }),
        fileFailure,
      ]);
      if (fileError) {
        throw fileError;
      }
      await Promise.race([tracker.waitForIdle(signal), fileFailure]);
      throwIfAborted(signal);
      if (fileError) {
        throw fileError;
      }
      return { buffer: fileBuffer, contentType };
    } finally {
      stopped = true;
      candidates.length = 0;
      signal?.removeEventListener('abort', onAbort);
      page.off?.('response', onResponse);
    }
  }, { signal });
}

module.exports = {
  DEFAULT_MAX_PENDING_FILE_RESPONSES,
  applyRequestBlocking,
  createAsyncTaskTracker,
  createPayloadTooLargeError,
  fetchFile,
  injectCookies,
  interceptRequests,
  renderPage,
  screenshotPage,
};
