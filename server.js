const fastify = require('fastify')({ logger: false });
const CDP = require('chrome-remote-interface');
const { spawn } = require('child_process');

// ==========================================
// 1. 并发控制器 (防止高并发导致容器 OOM 崩溃)
// ==========================================
class ConcurrencyLimiter {
  constructor(limit) {
    this.limit = limit;
    this.activeCount = 0;
    this.queue = [];
  }

  async enqueue(task) {
    if (this.activeCount >= this.limit) {
      await new Promise(resolve => this.queue.push(resolve));
    }
    this.activeCount++;
    try {
      return await task();
    } finally {
      this.activeCount--;
      if (this.queue.length > 0) {
        const nextTaskResolver = this.queue.shift();
        nextTaskResolver();
      }
    }
  }
}

// 设定最大并发数为 5（可根据服务器实际内存调整）
const limiter = new ConcurrencyLimiter(5);

// ==========================================
// 2. 启动全局 Google Chrome 守护进程 (实体模式)
// ==========================================
const chromeFlags = [
  // ⛔️ 注意：这里绝对不能加 '--headless'，我们要让它在 Xvfb 虚拟显示器里实体运行
  
  '--no-sandbox', // Docker 容器内 root 运行必须加此参数
  '--disable-dev-shm-usage',
  '--remote-debugging-port=9222',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-default-apps',
  '--mute-audio', // 保持静音
  '--disable-sync',
  '--blink-settings=imagesEnabled=false', // 性能核心：禁加载图片
  
  // --- 深度反爬规避参数 ---
  '--disable-blink-features=AutomationControlled', 
  '--disable-infobars',                            
  '--window-size=1920,1080',  // 真实映射到 Xvfb 的虚拟屏幕上
  '--hide-scrollbars',
  '--disable-features=IsolateOrigins,site-per-process'
];

// ⚠️ 路径变更为 Debian 下官方 Google Chrome 的路径
const chromeProcess = spawn('/usr/bin/google-chrome', chromeFlags);

chromeProcess.stderr.on('data', (data) => {
  const msg = data.toString();
  if (msg.includes('listening on')) {
    console.log(`\n========================================`);
    console.log(`🚀 [System] 实体 Chrome 已就绪 ${msg.trim()}`);
    console.log(`========================================\n`);
  }
});

// ==========================================
// 3. 定义 API 接口
// ==========================================
fastify.post('/fetch', async (request, reply) => {
  const { url, targets } = request.body;
  if (!url || !Array.isArray(targets) || targets.length === 0) {
    return reply.status(400).send({ error: '请提供有效的 url 和 targets 数组' });
  }

  console.log(`\n[📥 收到新任务] 目标网址: ${url}`);
  console.log(`[🎯 监听接口数] ${targets.length} 个`);

  try {
    const data = await limiter.enqueue(async () => {
      let client, targetTab;

      try {
        targetTab = await CDP.New();
        client = await CDP({ target: targetTab });

        const { Network, Page, Runtime } = client;
        const results = {};
        const pendingTargets = new Set(targets);
        const matchedRequests = new Map(); 

        await Network.enable();
        await Page.enable();
        await Runtime.enable();

        // ==========================================
        // 🔥 [增强 1]：网络层 HTTP Header 级伪装 (Client Hints)
        // ==========================================
        await Network.setUserAgentOverride({
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8',
          platform: 'Win32',
          userAgentMetadata: {
            brands: [
              { brand: 'Not_A Brand', version: '8' },
              { brand: 'Chromium', version: '120' },
              { brand: 'Google Chrome', version: '120' }
            ],
            fullVersionList: [],
            fullVersion: "120.0.0.0",
            platform: 'Windows',
            platformVersion: '10.0',
            architecture: 'x86',
            model: '',
            mobile: false,
            bitness: '64',
            wow64: false
          }
        });

        // ==========================================
        // 🔥 [增强 2]：执行期强力 Stealth 脚本注入
        // ==========================================
        const stealthScript = `
          if (navigator.webdriver !== undefined) {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
          }
          window.chrome = {
            runtime: {},
            app: { InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, isInstalled: false },
            csi: function() {},
            loadTimes: function() {}
          };
          const originalQuery = window.navigator.permissions.query;
          window.navigator.permissions.query = parameters => (
            parameters.name === 'notifications' ?
              Promise.resolve({ state: Notification.permission }) :
              originalQuery(parameters)
          );
          const makePluginArray = () => {
            const arr = [
              { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
              { name: 'Chrome PDF Viewer', filename: 'mhjimiaplmpugondncjocbgkfjojndgj', description: '' },
              { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
            ];
            arr.__proto__ = PluginArray.prototype;
            return arr;
          };
          Object.defineProperty(navigator, 'plugins', { get: makePluginArray });
          const getParameter = WebGLRenderingContext.prototype.getParameter;
          WebGLRenderingContext.prototype.getParameter = function(parameter) {
            if (parameter === 37445) return 'Intel Inc.';
            if (parameter === 37446) return 'Intel Iris OpenGL Engine';
            return getParameter.apply(this, [parameter]);
          };
          Object.defineProperty(window.screen, 'colorDepth', { get: () => 24 });
          Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
          Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
        `;

        await Page.addScriptToEvaluateOnNewDocument({ source: stealthScript });

        // ==========================================
        // 🚀 [核心]：网络拦截与数据提取
        // ==========================================
        const waitForInterception = new Promise((resolve) => {
          const timeout = setTimeout(() => {
            console.log(`[⏱️ 超时] 15秒已到，返回已抓取的数据...`);
            resolve(results);
          }, 15000); 

          Network.responseReceived((params) => {
            const resType = params.type; 
            const resUrl = params.response.url;
            const status = params.response.status;

            if (resType !== 'XHR' && resType !== 'Fetch') return;
            if (status === 204 || (status >= 300 && status < 400)) return;

            for (const target of pendingTargets) {
              if (resUrl.includes(target)) {
                console.log(`\n[🔍 发现目标请求] 匹配规则: ${target}`);
                console.log(`   👉 真实 URL: ${resUrl.split('?')[0]}...`);
                console.log(`   👉 状态码: ${status} | 类型: ${resType}`);
                
                matchedRequests.set(params.requestId, { target, status });
                break;
              }
            }
          });

          Network.loadingFinished(async (params) => {
            if (matchedRequests.has(params.requestId)) {
              const { target, status } = matchedRequests.get(params.requestId);
              try {
                const responseData = await Network.getResponseBody({ requestId: params.requestId });
                const bodyStr = responseData.base64Encoded 
                  ? Buffer.from(responseData.body, 'base64').toString('utf8') 
                  : responseData.body;

                if (!bodyStr || bodyStr.trim() === "") {
                    console.log(`[⚠️ 警告] 拦截到 [${target}] 但响应体为空，忽略并继续监听...`);
                    matchedRequests.delete(params.requestId); 
                    return;
                }

                let parsedBody = bodyStr;
                try { parsedBody = JSON.parse(bodyStr); } catch (e) {}

                results[target] = { status, body: parsedBody };
                pendingTargets.delete(target);
                
                console.log(`[✅ 抓取成功] 规则 [${target}] 已获取完整数据。剩余等待接口数: ${pendingTargets.size}`);

                if (pendingTargets.size === 0) {
                  clearTimeout(timeout);
                  resolve(results);
                }
              } catch (e) {
                console.error(`[❌ 提取错误] 获取 [${target}] body 失败:`, e.message);
              }
            }
          });
        });

        await Page.navigate({ url });
        const finalResults = await waitForInterception;
        return finalResults;

      } finally {
        if (client) await client.close();
        if (targetTab) await CDP.Close({ id: targetTab.id });
        console.log(`[🧹 清理] 标签页已关闭，释放内存。`);
      }
    });

    return reply.send({ success: true, data });

  } catch (err) {
    console.error('[💥 致命错误]', err);
    return reply.status(500).send({ error: '内部运行错误', details: err.message });
  }
});

fastify.listen({ port: 3000, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`[🌐 API Service] Listening at ${address}`);
});

process.on('SIGINT', () => {
  console.log('\n[🛑 关机] 正在关闭服务和浏览器进程...');
  if (chromeProcess) chromeProcess.kill();
  process.exit(0);
});
