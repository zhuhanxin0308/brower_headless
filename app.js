const crypto = require('node:crypto');
const Fastify = require('fastify');
const { createBrowserPool } = require('./browser-pool');
const { renderDashboardHtml } = require('./dashboard');
const rendererApiDefault = require('./renderer');
const { createStatsStore } = require('./stats-store');
const { assertAllowedUrl } = require('./url-security');

const DEFAULT_BODY_LIMIT = 1048576;
const DASHBOARD_PUBLIC_PATHS = new Set(['/', '/favicon.ico']);

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
function ensurePoolCapacity(pool, maxPending) {
  if (!pool) {
    const error = new Error('浏览器池尚未初始化');
    error.statusCode = 503;
    throw error;
  }

  if (pool.pending > maxPending) {
    const error = new Error('服务繁忙，请稍后重试');
    error.statusCode = 503;
    throw error;
  }
}

const cookieSchema = {
  oneOf: [
    { type: 'string' },
    {
      type: 'array',
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
    },
  ],
};

function buildApp(options = {}) {
  const apiKey = options.apiKey ?? process.env.API_KEY ?? '';
  const allowPrivateNetwork = options.allowPrivateNetwork ?? parseBoolean(process.env.ALLOW_PRIVATE_NETWORK, false);
  const minBrowsers = parseInteger(process.env.MIN_BROWSERS, 2);
  const maxBrowsers = parseInteger(process.env.MAX_BROWSERS, 10);
  // 最大排队深度：允许最多 maxBrowsers 个请求在池中等待，超过后快速拒绝。
  const maxPendingAcquires = options.maxPendingAcquires ?? maxBrowsers;
  const browserPoolFactory = options.browserPoolFactory ?? (() => createBrowserPool({
    minBrowsers,
    maxBrowsers,
  }));
  const rendererApi = options.rendererApi ?? rendererApiDefault;
  const statsStore = options.statsStore ?? createStatsStore();
  const urlLookup = options.urlLookup;

  const app = Fastify({
    logger: options.logger ?? true,
    bodyLimit: DEFAULT_BODY_LIMIT,
  });

  let pool = null;

  async function validateTargetUrl(url) {
    await assertAllowedUrl(url, {
      allowPrivateNetwork,
      lookup: urlLookup,
    });
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
    app.log.info('浏览器池初始化完成');
  });

  app.addHook('onClose', async () => {
    if (!pool) {
      return;
    }

    await pool.drain();
    await pool.clear();
  });

  app.addHook('onRequest', async (req) => {
    req.metricsPath = normalizeRequestPath(req.raw.url);
    req.metricsStartedAt = statsStore.markRequestStart(req.method, req.metricsPath);
    // 记录请求到达时间（而非响应完成时间），与字段名 requestedAt 语义一致。
    req.requestStartedAt = req.metricsStartedAt
      ? new Date(req.metricsStartedAt).toISOString()
      : null;
    req.requestErrorMessage = '';
  });

  // 安全响应头：防止 MIME 嗅探和点击劫持。
  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
  });

  app.addHook('onResponse', async (req, reply) => {
    if (req.metricsStartedAt == null) {
      return;
    }

    statsStore.recordRequest({
      method: req.method,
      path: req.metricsPath,
      statusCode: reply.statusCode,
      durationMs: Date.now() - req.metricsStartedAt,
      requestedAt: req.requestStartedAt,
      errorMessage: req.requestErrorMessage,
    });
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
          waitFor: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle0', 'networkidle2'] },
          timeout: { type: 'number', default: 15000 },
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
      ensurePoolCapacity(pool, maxPendingAcquires);
      await validateTargetUrl(url);
      const result = await rendererApi.renderPage(pool, { url, waitFor, timeout, headers, cookies, viewport });
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
          waitFor: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle0', 'networkidle2'] },
          timeout: { type: 'number', default: 20000 },
          headers: { type: 'object', additionalProperties: { type: 'string' } },
          cookies: cookieSchema,
          format: { type: 'string', enum: ['png', 'jpeg', 'webp'], default: 'png' },
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
        },
      },
    },
  }, async (req, reply) => {
    const { url, waitFor, timeout, headers, cookies, format, fullPage, quality, clip, viewport } = req.body;

    try {
      ensurePoolCapacity(pool, maxPendingAcquires);
      await validateTargetUrl(url);
      const { buffer, contentType } = await rendererApi.screenshotPage(pool, {
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
      });

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
          listenUrls: { type: 'array', items: { type: 'string' }, default: [] },
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
    const { url, listenUrls, fileTypes, timeout, headers, cookies } = req.body;

    try {
      ensurePoolCapacity(pool, maxPendingAcquires);
      await validateTargetUrl(url);
      const result = await rendererApi.interceptRequests(pool, { url, listenUrls, fileTypes, timeout, headers, cookies });
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
          timeout: { type: 'number', default: 20000 },
          cookies: cookieSchema,
        },
      },
    },
  }, async (req, reply) => {
    const { url, fileUrl, timeout, cookies } = req.body;

    try {
      ensurePoolCapacity(pool, maxPendingAcquires);
      await validateTargetUrl(url);
      // fileUrl 为 '_any_' 时表示抓取页面中的任意网络资源，跳过 URL 安全校验。
      if (fileUrl !== '_any_') {
        await validateTargetUrl(fileUrl);
      }

      const { buffer, contentType } = await rendererApi.fetchFile(pool, { url, fileUrl, timeout, cookies });

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
  safeEqual,
};
