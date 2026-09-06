const crypto = require('node:crypto');
const Fastify = require('fastify');
const { createBrowserPool } = require('./browser-pool');
const { renderDashboardHtml } = require('./dashboard');
const rendererApiDefault = require('./renderer');
const { createOperationScope, MAX_TOTAL_TIMEOUT_MS } = require('./operation-scope');
const { createStatsStore } = require('./stats-store');
const { assertAllowedUrl } = require('./url-security');

const DEFAULT_BODY_LIMIT = 1048576;
const DEFAULT_MAX_FETCH_FILE_BYTES = 50 * 1024 * 1024;
const DASHBOARD_PUBLIC_PATHS = new Set(['/', '/favicon.ico']);
const WAIT_FOR_SCHEMA = { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle0', 'networkidle2'] };
const TOTAL_TIMEOUT_SCHEMA = { type: 'integer', minimum: 1, maximum: MAX_TOTAL_TIMEOUT_MS };
const BLOCKABLE_RESOURCE_TYPES = [
  'document',
  'stylesheet',
  'image',
  'media',
  'font',
  'script',
  'texttrack',
  'xhr',
  'fetch',
  'eventsource',
  'websocket',
  'manifest',
  'other',
];

// 统一解析布尔环境变量，避免在各处手写大小写判断。
function parseBoolean(value, defaultValue = false) {
  if (value == null || value === '') {
    return defaultValue;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function parseInteger(value, defaultValue) {
  const parsedValue = Number.parseInt(value, 10);
  return Number.isNaN(parsedValue) ? defaultValue : parsedValue;
}

function parsePositiveInteger(value, defaultValue) {
  const parsedValue = Number.parseInt(value, 10);
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : defaultValue;
}

function resolveFetchFileMaxBytes(requestMaxBytes, serverMaxBytes) {
  if (requestMaxBytes == null) {
    return serverMaxBytes;
  }

  // 调用方只能收紧限制，不能绕过服务端的全局保护阈值。
  return Math.min(parsePositiveInteger(requestMaxBytes, serverMaxBytes), serverMaxBytes);
}

function validateCapacity(name, value, minimum) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${name} 必须是不小于 ${minimum} 的安全整数`);
  }
}

function normalizeRequestPath(rawUrl = '/') {
  return String(rawUrl).split('?')[0] || '/';
}

function isDashboardPublicRequest(method, path) {
  return method === 'GET' && DASHBOARD_PUBLIC_PATHS.has(path);
}

// 使用常量时间比较 API Key，防止 timing attack 侧信道泄漏密钥内容。
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }

  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);

  if (bufA.length !== bufB.length) {
    return false;
  }

  return crypto.timingSafeEqual(bufA, bufB);
}

// 检查浏览器池是否可用且排队深度未超限，快速拒绝过载请求避免请求无限堆积。
function ensurePoolCapacity(pool, maxPending, maxBrowsers = pool?.max) {
  if (!pool) {
    const error = new Error('浏览器池尚未初始化');
    error.statusCode = 503;
    throw error;
  }

  // 零排队仍允许按需创建浏览器，不能把冷池误判为已经耗尽并发容量。
  const canCreateImmediately = pool.pending === 0 && pool.size < maxBrowsers;
  if (pool.pending >= maxPending && pool.available === 0 && !canCreateImmediately) {
    const error = new Error('服务繁忙，请稍后重试');
    error.statusCode = 503;
    throw error;
  }
}

const cookieSchema = {
  // 一次识别两种合法类型，避免联合分支的强制转换破坏字符串或单元素对象数组。
  type: ['string', 'array'],
  items: {
    type: 'object',
    required: ['name', 'value'],
    properties: {
      name: { type: 'string' },
      value: { type: 'string' },
      domain: { type: 'string' },
      path: { type: 'string' },
      httpOnly: { type: 'boolean' },
      secure: { type: 'boolean' },
      sameSite: { type: 'string', enum: ['Strict', 'Lax', 'None'] },
    },
  },
};

function buildApp(options = {}) {
  const apiKey = options.apiKey ?? process.env.API_KEY ?? '';
  const allowPrivateNetwork = options.allowPrivateNetwork ?? parseBoolean(process.env.ALLOW_PRIVATE_NETWORK, false);
  const minBrowsers = options.minBrowsers ?? parseInteger(process.env.MIN_BROWSERS, 2);
  const maxBrowsers = options.maxBrowsers ?? parseInteger(process.env.MAX_BROWSERS, 10);
  const prewarmPages = options.prewarmPages ?? parseBoolean(process.env.PREWARM_PAGES, true);
  const maxFetchFileBytes = options.maxFetchFileBytes
    ?? parsePositiveInteger(process.env.MAX_FETCH_FILE_BYTES, DEFAULT_MAX_FETCH_FILE_BYTES);
  // 最大排队深度：允许最多 maxBrowsers 个请求在池中等待，超过后快速拒绝。
  const maxPendingAcquires = options.maxPendingAcquires
    ?? parseInteger(process.env.MAX_PENDING_ACQUIRES, maxBrowsers);
  const maxPendingFileResponses = options.maxPendingFileResponses
    ?? parsePositiveInteger(process.env.MAX_PENDING_FILE_RESPONSES,
      rendererApiDefault.DEFAULT_MAX_PENDING_FILE_RESPONSES);
  validateCapacity('MIN_BROWSERS', minBrowsers, 0);
  validateCapacity('MAX_BROWSERS', maxBrowsers, 1);
  validateCapacity('MAX_PENDING_ACQUIRES', maxPendingAcquires, 0);
  validateCapacity('MAX_PENDING_FILE_RESPONSES', maxPendingFileResponses, 1);
  if (typeof prewarmPages !== 'boolean') {
    throw new TypeError('PREWARM_PAGES 必须是布尔值');
  }
  const browserPoolFactory = options.browserPoolFactory ?? (() => createBrowserPool({
    minBrowsers,
    maxBrowsers,
    maxPendingAcquires,
    prewarmPages,
  }));
  const rendererApi = options.rendererApi ?? rendererApiDefault;
  const statsStore = options.statsStore ?? createStatsStore();
  const urlLookup = options.urlLookup;

  const app = Fastify({
    logger: options.logger ?? true,
    bodyLimit: DEFAULT_BODY_LIMIT,
    ajv: { customOptions: { allowUnionTypes: true } },
  });

  let pool = null;
  let activeOperations = 0;
  let pendingUrlChecks = 0;

  function recordRequestMetrics(req, statusCode) {
    if (req.metricsStartedAt == null || req.metricsRecorded) return;
    req.metricsRecorded = true;
    statsStore.recordRequest({
      method: req.method,
      path: req.metricsPath,
      statusCode,
      durationMs: Date.now() - req.metricsStartedAt,
      requestedAt: req.requestStartedAt,
      errorMessage: req.requestErrorMessage,
    });
  }

  async function runOperation(req, reply, urls, handler) {
    ensurePoolCapacity(pool, maxPendingAcquires, maxBrowsers);
    // 在第一个异步步骤之前占用准入容量，防止并发 DNS 查询越过池排队预检。
    if (activeOperations >= maxBrowsers + maxPendingAcquires) {
      const error = new Error('服务繁忙，请稍后重试');
      error.statusCode = 503;
      throw error;
    }
    activeOperations += 1;
    const scope = createOperationScope({
      totalTimeout: req.body.totalTimeout, request: req.raw, response: reply.raw,
    });
    req.operationSignal = scope.signal;
    try {
      for (const url of urls) {
        scope.signal.throwIfAborted();
        await scope.waitFor(validateTargetUrl(url));
      }
      scope.signal.throwIfAborted();
      // 浏览器层负责等待实际资源清理，不能在这里仅用 Promise.race 提前放回容量。
      const result = await handler(scope.signal);
      scope.signal.throwIfAborted();
      return result;
    } catch (error) {
      if (scope.signal.aborted) error = scope.signal.reason;
      if (error.statusCode === 499) {
        req.requestErrorMessage = error.message;
        recordRequestMetrics(req, error.statusCode);
      }
      throw error;
    } finally {
      scope.dispose();
      activeOperations -= 1;
    }
  }

  async function validateTargetUrl(url) {
    // DNS 底层不能取消，迟到查询必须继续占用校验额度，避免连续超时堆积真实工作。
    if (pendingUrlChecks >= maxBrowsers + maxPendingAcquires) {
      const error = new Error('目标地址校验繁忙，请稍后重试');
      error.statusCode = 503;
      throw error;
    }
    pendingUrlChecks += 1;
    try {
      await assertAllowedUrl(url, { allowPrivateNetwork, lookup: urlLookup });
    } finally {
      pendingUrlChecks -= 1;
    }
  }

  app.addHook('preHandler', async (req, reply) => {
    const requestPath = normalizeRequestPath(req.raw.url);

    if (isDashboardPublicRequest(req.method, requestPath)) {
      return;
    }

    if (!apiKey) {
      return;
    }

    if (!safeEqual(req.headers['x-api-key'], apiKey)) {
      req.requestErrorMessage = 'Unauthorized';
      return reply.code(401).send({ ok: false, error: 'Unauthorized' });
    }
  });

  app.addHook('onReady', async () => {
    pool = browserPoolFactory();
    pool.on?.('factoryCreateError', (error) => app.log.error(error, '浏览器创建失败'));
    pool.on?.('factoryDestroyError', (error) => app.log.error(error, '浏览器清理失败'));
    app.log.info('浏览器池初始化完成');
  });

  app.addHook('onClose', async () => {
    if (!pool) {
      return;
    }

    let drainError;
    try {
      await pool.drain();
    } catch (error) {
      drainError = error;
    }
    // 隔离借用导致排空失败时，仍清理其他空闲实例，并保留最先发生的关闭错误。
    try {
      await pool.clear();
    } catch (error) {
      if (!drainError) throw error;
      drainError.cleanupError = error;
    }
    if (drainError) throw drainError;
  });

  app.addHook('onRequest', async (req, reply) => {
    req.metricsPath = normalizeRequestPath(req.raw.url);
    req.metricsStartedAt = statsStore.markRequestStart(req.method, req.metricsPath);
    // 记录请求到达时间（而非响应完成时间），与字段名 requestedAt 语义一致。
    req.requestStartedAt = req.metricsStartedAt
      ? new Date(req.metricsStartedAt).toISOString()
      : null;
    req.requestErrorMessage = '';
    req.onMetricsClose = () => {
      if (!reply.raw.writableEnded) {
        const reason = req.operationSignal?.reason;
        req.requestErrorMessage = reason?.message || '客户端已断开连接';
        recordRequestMetrics(req, reason?.statusCode || 499);
      }
    };
    reply.raw.once('close', req.onMetricsClose);
  });

  // 安全响应头：防止 MIME 嗅探和点击劫持。
  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
  });

  app.addHook('onResponse', async (req, reply) => {
    reply.raw.removeListener('close', req.onMetricsClose);
    recordRequestMetrics(req, reply.statusCode);
  });

  app.get('/', async (_req, reply) => {
    const poolInfo = pool
      ? { size: pool.size, available: pool.available, borrowed: pool.borrowed, minBrowsers, maxBrowsers }
      : null;
    const snapshot = statsStore.buildSnapshot({ poolInfo });

    reply.type('text/html; charset=utf-8');
    reply.header('Cache-Control', 'no-store');
    return reply.send(renderDashboardHtml(snapshot));
  });

  app.get('/favicon.ico', async (_req, reply) => {
    reply.code(204);
    reply.header('Cache-Control', 'public, max-age=86400');
    return reply.send();
  });

  app.post('/render', {
    schema: {
      body: {
        type: 'object',
        required: ['url'],
        properties: {
          url: { type: 'string' },
          waitFor: WAIT_FOR_SCHEMA,
          timeout: { type: 'number', default: 15000 },
          totalTimeout: TOTAL_TIMEOUT_SCHEMA,
          headers: { type: 'object', additionalProperties: { type: 'string' } },
          cookies: cookieSchema,
          viewport: {
            type: 'object',
            properties: {
              width: { type: 'number', default: 1440 },
              height: { type: 'number', default: 900 },
              deviceScaleFactor: { type: 'number', default: 1 },
            },
          },
        },
      },
    },
  }, async (req, reply) => {
    const { url, waitFor, timeout, headers, cookies, viewport } = req.body;

    try {
      const result = await runOperation(req, reply, [url], (signal) =>
        rendererApi.renderPage(pool, { url, waitFor, timeout, headers, cookies, viewport, signal }));
      return { ok: true, ...result };
    } catch (error) {
      req.requestErrorMessage = error.message;
      return reply.code(error.statusCode || 500).send({ ok: false, error: error.message });
    }
  });

  app.post('/screenshot', {
    schema: {
      body: {
        type: 'object',
        required: ['url'],
        properties: {
          url: { type: 'string' },
          waitFor: WAIT_FOR_SCHEMA,
          timeout: { type: 'number', default: 20000 },
          headers: { type: 'object', additionalProperties: { type: 'string' } },
          cookies: cookieSchema,
          format: { type: 'string', enum: ['png', 'jpeg', 'webp'], default: 'png' },
          totalTimeout: TOTAL_TIMEOUT_SCHEMA,
          fullPage: { type: 'boolean', default: true },
          quality: { type: 'number', minimum: 0, maximum: 100 },
          clip: {
            type: 'object',
            properties: {
              x: { type: 'number' },
              y: { type: 'number' },
              width: { type: 'number' },
              height: { type: 'number' },
            },
            required: ['x', 'y', 'width', 'height'],
          },
          viewport: {
            type: 'object',
            properties: {
              width: { type: 'number', default: 1440 },
              height: { type: 'number', default: 900 },
              deviceScaleFactor: { type: 'number', default: 1 },
            },
          },
          blockedResourceTypes: {
            type: 'array',
            items: { type: 'string', enum: BLOCKABLE_RESOURCE_TYPES },
            default: [],
          },
          blockedUrlPatterns: {
            type: 'array',
            items: { type: 'string' },
            default: [],
          },
        },
      },
    },
  }, async (req, reply) => {
    const {
      url,
      waitFor,
      timeout,
      headers,
      cookies,
      format,
      fullPage,
      quality,
      clip,
      viewport,
      blockedResourceTypes,
      blockedUrlPatterns,
    } = req.body;

    try {
      const { buffer, contentType } = await runOperation(req, reply, [url], (signal) => rendererApi.screenshotPage(pool, {
        url,
        waitFor,
        timeout,
        headers,
        cookies,
        format,
        fullPage,
        quality,
        clip,
        viewport,
        blockedResourceTypes,
        blockedUrlPatterns,
        signal,
      }));

      reply.header('Content-Type', contentType);
      reply.header('Content-Disposition', `inline; filename="screenshot.${format || 'png'}"`);
      return reply.send(buffer);
    } catch (error) {
      req.requestErrorMessage = error.message;
      return reply.code(error.statusCode || 500).send({ ok: false, error: error.message });
    }
  });

  app.post('/intercept', {
    schema: {
      body: {
        type: 'object',
        required: ['url'],
        properties: {
          url: { type: 'string' },
          waitFor: WAIT_FOR_SCHEMA,
          listenUrls: { type: 'array', items: { type: 'string' }, default: [] },
          totalTimeout: TOTAL_TIMEOUT_SCHEMA,
          fileTypes: {
            type: 'array',
            items: { type: 'string', enum: ['image', 'video', 'audio', 'pdf', 'json', 'css', 'js', 'font'] },
            default: [],
          },
          timeout: { type: 'number', default: 20000 },
          headers: { type: 'object', additionalProperties: { type: 'string' } },
          cookies: cookieSchema,
        },
      },
    },
  }, async (req, reply) => {
    const { url, waitFor, listenUrls, fileTypes, timeout, headers, cookies } = req.body;

    try {
      const result = await runOperation(req, reply, [url], (signal) => rendererApi.interceptRequests(pool, {
        url,
        waitFor,
        listenUrls,
        fileTypes,
        timeout,
        headers,
        cookies,
        signal,
      }));
      return { ok: true, ...result };
    } catch (error) {
      req.requestErrorMessage = error.message;
      return reply.code(error.statusCode || 500).send({ ok: false, error: error.message });
    }
  });

  app.post('/fetch-file', {
    schema: {
      body: {
        type: 'object',
        required: ['url', 'fileUrl'],
        properties: {
          url: { type: 'string' },
          // 传入 '_any_' 表示抓取页面中的任意网络资源。
          fileUrl: { type: 'string' },
          totalTimeout: TOTAL_TIMEOUT_SCHEMA,
          waitFor: WAIT_FOR_SCHEMA,
          timeout: { type: 'number', default: 20000 },
          cookies: cookieSchema,
          maxBytes: { type: 'number', minimum: 1 },
        },
      },
    },
  }, async (req, reply) => {
    const { url, fileUrl, waitFor, timeout, cookies, maxBytes } = req.body;

    try {
      // 通配符不是 URL，实际页面地址仍必须通过安全校验。
      const targetUrls = fileUrl === '_any_' ? [url] : [url, fileUrl];
      const { buffer, contentType } = await runOperation(req, reply, targetUrls, (signal) => rendererApi.fetchFile(pool, {
        url,
        fileUrl,
        waitFor,
        timeout,
        cookies,
        maxBytes: resolveFetchFileMaxBytes(maxBytes, maxFetchFileBytes),
        maxPendingResponses: maxPendingFileResponses,
        signal,
      }));

      if (!buffer) {
        req.requestErrorMessage = '未找到目标文件';
        return reply.code(404).send({ ok: false, error: '未找到目标文件' });
      }

      reply.header('Content-Type', contentType);
      reply.header('Content-Disposition', 'attachment');
      return reply.send(buffer);
    } catch (error) {
      req.requestErrorMessage = error.message;
      return reply.code(error.statusCode || 500).send({ ok: false, error: error.message });
    }
  });

  app.get('/health', async () => {
    const poolInfo = pool
      ? { size: pool.size, available: pool.available, borrowed: pool.borrowed }
      : null;

    return { ok: true, pool: poolInfo };
  });

  return app;
}

module.exports = {
  buildApp,
  ensurePoolCapacity,
  parseBoolean,
  parseInteger,
  parsePositiveInteger,
  resolveFetchFileMaxBytes,
  safeEqual,
};
