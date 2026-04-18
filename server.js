require('dotenv').config();
const Fastify = require('fastify');
const { createBrowserPool } = require('./browser-pool');
const { renderPage, screenshotPage, interceptRequests, fetchFile } = require('./renderer');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || '';

const app = Fastify({
  logger: true,
  bodyLimit: 1048576,
});

// ── Cookie schema 复用定义 ──────────────────────────
const cookieSchema = {
  oneOf: [
    // 字符串格式: "session=abc; token=xyz"
    { type: 'string' },
    // 数组格式: [{ name, value, domain?, path?, httpOnly?, secure? }]
    {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'value'],
        properties: {
          name:     { type: 'string' },
          value:    { type: 'string' },
          domain:   { type: 'string' },
          path:     { type: 'string' },
          httpOnly: { type: 'boolean' },
          secure:   { type: 'boolean' },
          sameSite: { type: 'string', enum: ['Strict', 'Lax', 'None'] },
        },
      },
    },
  ],
};

// ── 鉴权 ───────────────────────────────────────────
app.addHook('preHandler', async (req, reply) => {
  if (!API_KEY) return;
  if (req.headers['x-api-key'] !== API_KEY) {
    reply.code(401).send({ error: 'Unauthorized' });
  }
});

// ── 浏览器池 ────────────────────────────────────────
let pool;
app.addHook('onReady', async () => {
  pool = createBrowserPool({
    minBrowsers: parseInt(process.env.MIN_BROWSERS || '2'),
    maxBrowsers: parseInt(process.env.MAX_BROWSERS || '10'),
  });
  app.log.info('浏览器池初始化完成');
});

app.addHook('onClose', async () => {
  if (pool) await pool.drain().then(() => pool.clear());
});

// ─────────────────────────────────────────────────────
// POST /render  —  渲染页面，返回 HTML
// ─────────────────────────────────────────────────────
app.post('/render', {
  schema: {
    body: {
      type: 'object',
      required: ['url'],
      properties: {
        url:     { type: 'string' },
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
    const result = await renderPage(pool, { url, waitFor, timeout, headers, cookies });
    return { ok: true, ...result };
  } catch (err) {
    reply.code(500).send({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────
// POST /screenshot  —  截图，返回图片二进制流
// ─────────────────────────────────────────────────────
app.post('/screenshot', {
  schema: {
    body: {
      type: 'object',
      required: ['url'],
      properties: {
        url:      { type: 'string' },
        waitFor:  { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle0', 'networkidle2'] },
        timeout:  { type: 'number', default: 20000 },
        headers:  { type: 'object', additionalProperties: { type: 'string' } },
        cookies:  cookieSchema,
        format:   { type: 'string', enum: ['png', 'jpeg', 'webp'], default: 'png' },
        fullPage: { type: 'boolean', default: true },
        quality:  { type: 'number', minimum: 0, maximum: 100 },
        clip: {
          type: 'object',
          properties: {
            x:      { type: 'number' },
            y:      { type: 'number' },
            width:  { type: 'number' },
            height: { type: 'number' },
          },
          required: ['x', 'y', 'width', 'height'],
        },
        viewport: {
          type: 'object',
          properties: {
            width:             { type: 'number', default: 1440 },
            height:            { type: 'number', default: 900 },
            deviceScaleFactor: { type: 'number', default: 1 },
          },
        },
      },
    },
  },
}, async (req, reply) => {
  const { url, waitFor, timeout, headers, cookies, format, fullPage, quality, clip, viewport } = req.body;
  try {
    const { buffer, contentType } = await screenshotPage(pool, {
      url, waitFor, timeout, headers, cookies, format, fullPage, quality, clip, viewport,
    });
    reply.header('Content-Type', contentType);
    reply.header('Content-Disposition', `inline; filename="screenshot.${format || 'png'}"`);
    return reply.send(buffer);
  } catch (err) {
    reply.code(500).send({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────
// POST /intercept  —  监听接口响应 & 文件
// ─────────────────────────────────────────────────────
app.post('/intercept', {
  schema: {
    body: {
      type: 'object',
      required: ['url'],
      properties: {
        url:        { type: 'string' },
        listenUrls: { type: 'array', items: { type: 'string' }, default: [] },
        fileTypes:  {
          type: 'array',
          items: { type: 'string', enum: ['image', 'video', 'audio', 'pdf', 'json', 'css', 'js', 'font'] },
          default: [],
        },
        timeout:  { type: 'number', default: 20000 },
        headers:  { type: 'object', additionalProperties: { type: 'string' } },
        cookies:  cookieSchema,
      },
    },
  },
}, async (req, reply) => {
  const { url, listenUrls, fileTypes, timeout, headers, cookies } = req.body;
  try {
    const result = await interceptRequests(pool, { url, listenUrls, fileTypes, timeout, headers, cookies });
    return { ok: true, ...result };
  } catch (err) {
    reply.code(500).send({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────
// POST /fetch-file  —  下载文件流
// ─────────────────────────────────────────────────────
app.post('/fetch-file', {
  schema: {
    body: {
      type: 'object',
      required: ['url', 'fileUrl'],
      properties: {
        url:     { type: 'string' },
        fileUrl: { type: 'string' },
        timeout: { type: 'number', default: 20000 },
        cookies: cookieSchema,
      },
    },
  },
}, async (req, reply) => {
  const { url, fileUrl, timeout, cookies } = req.body;
  try {
    const { buffer, contentType } = await fetchFile(pool, { url, fileUrl, timeout, cookies });
    if (!buffer) {
      return reply.code(404).send({ ok: false, error: '未找到目标文件' });
    }
    reply.header('Content-Type', contentType);
    reply.header('Content-Disposition', 'attachment');
    return reply.send(buffer);
  } catch (err) {
    reply.code(500).send({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────
// GET /health
// ─────────────────────────────────────────────────────
app.get('/health', async () => {
  const poolInfo = pool
    ? { size: pool.size, available: pool.available, borrowed: pool.borrowed }
    : null;
  return { ok: true, pool: poolInfo };
});

app.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) { app.log.error(err); process.exit(1); }
  app.log.info(`🚀 Browser Service 启动在 http://0.0.0.0:${PORT}`);
});
