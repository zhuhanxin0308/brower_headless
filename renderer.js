const { withPage } = require('./browser-pool');

/**
 * 注入 Cookie
 * 支持两种格式：
 *   字符串: "name=value; name2=value2"（domain 自动从 url 提取）
 *   数组:   [{ name, value, domain?, path?, httpOnly?, secure? }]
 */
async function injectCookies(page, url, cookies) {
  if (!cookies) return;

  let list = [];
  const domain = new URL(url).hostname;

  if (typeof cookies === 'string') {
    list = cookies.split(';').map((pair) => {
      const [name, ...rest] = pair.trim().split('=');
      return { name: name.trim(), value: rest.join('=').trim(), domain };
    }).filter((c) => c.name);
  } else if (Array.isArray(cookies)) {
    list = cookies.map((c) => ({ domain, path: '/', ...c }));
  }

  if (list.length > 0) {
    await page.setCookie(...list);
  }
}

/**
 * 渲染页面，返回完整 HTML
 */
async function renderPage(pool, { url, waitFor, timeout = 15000, headers = {}, cookies }) {
  return withPage(pool, async (page) => {
    if (Object.keys(headers).length > 0) {
      await page.setExtraHTTPHeaders(headers);
    }

    await injectCookies(page, url, cookies);

    await page.goto(url, {
      waitUntil: waitFor || 'networkidle2',
      timeout,
    });

    const html = await page.content();
    const title = await page.title();
    const finalUrl = page.url();

    return { html, title, finalUrl };
  });
}

/**
 * 截图
 * @param {object} opts
 * @param {'png'|'jpeg'|'webp'} opts.format    图片格式，默认 png
 * @param {boolean} opts.fullPage              是否截全页，默认 true
 * @param {number}  opts.quality               jpeg/webp 画质 0-100
 * @param {{x,y,width,height}} opts.clip       截取指定区域（开启后 fullPage 失效）
 * @param {{width,height,deviceScaleFactor}} opts.viewport  视口，默认 1440x900
 */
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
}) {
  return withPage(pool, async (page) => {
    await page.setViewport(viewport);

    if (Object.keys(headers).length > 0) {
      await page.setExtraHTTPHeaders(headers);
    }

    await injectCookies(page, url, cookies);

    await page.goto(url, {
      waitUntil: waitFor || 'networkidle2',
      timeout,
    });

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
  });
}

/**
 * 监听指定接口的响应，返回匹配的响应数据
 */
async function interceptRequests(pool, {
  url, listenUrls = [], fileTypes = [], timeout = 20000, headers = {}, cookies,
}) {
  return withPage(pool, async (page) => {
    const captured = [];
    const files = [];

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

    const watchMimes = fileTypes.flatMap((t) => fileMimeMap[t] || []);

    await page.setRequestInterception(true);
    page.on('request', (req) => req.continue());

    page.on('response', async (response) => {
      const resUrl = response.url();
      const contentType = response.headers()['content-type'] || '';
      const status = response.status();

      for (const pattern of listenUrls) {
        if (resUrl.includes(pattern)) {
          try {
            let body;
            if (contentType.includes('application/json')) {
              body = await response.json().catch(() => null);
            } else {
              body = await response.text().catch(() => null);
            }
            captured.push({ url: resUrl, status, contentType, body });
          } catch {
            captured.push({ url: resUrl, status, contentType, body: null });
          }
        }
      }

      if (watchMimes.length > 0) {
        const matched = watchMimes.some((mime) => contentType.startsWith(mime));
        if (matched) files.push({ url: resUrl, contentType, status });
      }
    });

    if (Object.keys(headers).length > 0) {
      await page.setExtraHTTPHeaders(headers);
    }

    await injectCookies(page, url, cookies);
    await page.goto(url, { waitUntil: 'networkidle2', timeout });

    return { finalUrl: page.url(), captured, files };
  });
}

/**
 * 下载单个文件，返回 Buffer
 */
async function fetchFile(pool, { url, fileUrl, timeout = 20000, cookies }) {
  return withPage(pool, async (page) => {
    let fileBuffer = null;
    let contentType = '';

    await page.setRequestInterception(true);
    page.on('request', (req) => req.continue());

    page.on('response', async (response) => {
      if (response.url() === fileUrl || fileUrl === '_any_') {
        try {
          fileBuffer = await response.buffer();
          contentType = response.headers()['content-type'] || 'application/octet-stream';
        } catch {}
      }
    });

    await injectCookies(page, url, cookies);
    await page.goto(url, { waitUntil: 'networkidle2', timeout });

    return { buffer: fileBuffer, contentType };
  });
}

module.exports = { renderPage, screenshotPage, interceptRequests, fetchFile };
