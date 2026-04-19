const Fastify = require('fastify');
const { createBrowserPool } = require('./browser-pool');
const rendererApiDefault = require('./renderer');
const { assertAllowedUrl } = require('./url-security');

const DEFAULT_BODY_LIMIT = 1048576;

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
  const browserPoolFactory = options.browserPoolFactory ?? (() => createBrowserPool({
    minBrowsers: parseInteger(process.env.MIN_BROWSERS, 2),
    maxBrowsers: parseInteger(process.env.MAX_BROWSERS, 10),
  }));
  const rendererApi = options.rendererApi ?? rendererApiDefault;
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
    if (!apiKey) {
      return;
    }

    if (req.headers['x-api-key'] !== apiKey) {
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
        },
      },
    },
  }, async (req, reply) => {
    const { url, waitFor, timeout, headers, cookies } = req.body;

    try {
      await validateTargetUrl(url);
      const result = await rendererApi.renderPage(pool, { url, waitFor, timeout, headers, cookies });
      return { ok: true, ...result };
    } catch (error) {
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
      await validateTargetUrl(url);
      const result = await rendererApi.interceptRequests(pool, { url, listenUrls, fileTypes, timeout, headers, cookies });
      return { ok: true, ...result };
    } catch (error) {
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
          fileUrl: { type: 'string' },
          timeout: { type: 'number', default: 20000 },
          cookies: cookieSchema,
        },
      },
    },
  }, async (req, reply) => {
    const { url, fileUrl, timeout, cookies } = req.body;

    try {
      await validateTargetUrl(url);
      await validateTargetUrl(fileUrl);

      const { buffer, contentType } = await rendererApi.fetchFile(pool, { url, fileUrl, timeout, cookies });

      if (!buffer) {
        return reply.code(404).send({ ok: false, error: '未找到目标文件' });
      }

      reply.header('Content-Type', contentType);
      reply.header('Content-Disposition', 'attachment');
      return reply.send(buffer);
    } catch (error) {
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
  parseBoolean,
  parseInteger,
};
