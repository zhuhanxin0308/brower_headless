const { withPage } = require('./browser-pool');

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
    async waitForIdle() {
      while (pendingTasks.size > 0) {
        await Promise.allSettled([...pendingTasks]);
      }
    },
  };
}

async function renderPage(pool, {
  url,
  waitFor,
  timeout = 15000,
  headers = {},
  cookies,
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

    const html = await page.content();
    const title = await page.title();
    const finalUrl = page.url();

    return { html, title, finalUrl };
  });
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

async function interceptRequests(pool, {
  url, listenUrls = [], fileTypes = [], timeout = 20000, headers = {}, cookies,
}) {
  return withPage(pool, async (page) => {
    const captured = [];
    const files = [];
    const tracker = createAsyncTaskTracker();

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

    await page.setRequestInterception(true);
    page.on('request', (request) => request.continue());

    page.on('response', (response) => {
      tracker.track((async () => {
        const responseUrl = response.url();
        const contentType = response.headers()['content-type'] || '';
        const status = response.status();

        for (const pattern of listenUrls) {
          if (responseUrl.includes(pattern)) {
            try {
              let body;
              if (contentType.includes('application/json')) {
                body = await response.json().catch(() => null);
              } else {
                body = await response.text().catch(() => null);
              }

              captured.push({ url: responseUrl, status, contentType, body });
            } catch {
              captured.push({ url: responseUrl, status, contentType, body: null });
            }
          }
        }

        if (watchMimes.length > 0) {
          const matched = watchMimes.some((mime) => contentType.startsWith(mime));
          if (matched) {
            files.push({ url: responseUrl, contentType, status });
          }
        }
      })());
    });

    if (Object.keys(headers).length > 0) {
      await page.setExtraHTTPHeaders(headers);
    }

    await injectCookies(page, url, cookies);
    await page.goto(url, { waitUntil: 'networkidle2', timeout });
    await tracker.waitForIdle();

    return { finalUrl: page.url(), captured, files };
  });
}

async function fetchFile(pool, { url, fileUrl, timeout = 20000, cookies }) {
  return withPage(pool, async (page) => {
    let fileBuffer = null;
    let contentType = '';
    const tracker = createAsyncTaskTracker();

    await page.setRequestInterception(true);
    page.on('request', (request) => request.continue());

    page.on('response', (response) => {
      tracker.track((async () => {
        const matched = response.url() === fileUrl || fileUrl === '_any_';

        if (!matched || fileBuffer) {
          return;
        }

        try {
          fileBuffer = await response.buffer();
          contentType = response.headers()['content-type'] || 'application/octet-stream';
        } catch {
          fileBuffer = null;
          contentType = '';
        }
      })());
    });

    await injectCookies(page, url, cookies);
    await page.goto(url, { waitUntil: 'networkidle2', timeout });
    await tracker.waitForIdle();

    return { buffer: fileBuffer, contentType };
  });
}

module.exports = {
  createAsyncTaskTracker,
  fetchFile,
  injectCookies,
  interceptRequests,
  renderPage,
  screenshotPage,
};
