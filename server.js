const fastify = require('fastify')({ logger: true });
const CDP = require('chrome-remote-interface');
const { spawn } = require('child_process');

// ==========================================
// 1. 并发控制器 (防止高并发 OOM)
// ==========================================
class ConcurrencyLimiter {
  constructor(limit) {
    this.limit = limit; // 最大并发标签页数量
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

// 设定为 5 个并发 (对于 1GB 内存的容器比较安全，可根据实际资源调整)
const limiter = new ConcurrencyLimiter(5);

// ==========================================
// 2. 启动全局 Chromium 守护进程
// ==========================================
const chromeFlags = [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--remote-debugging-port=9222',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-default-apps',
  '--mute-audio',
  '--no-first-run',
  '--safebrowsing-disable-auto-update',
  '--disable-sync',
  '--blink-settings=imagesEnabled=false' // 核心优化：禁加载图片
];

// 注意：这里使用的是 Alpine 系统下的默认路径
const chromeProcess = spawn('/usr/bin/chromium-browser', chromeFlags);

chromeProcess.stderr.on('data', (data) => {
  const msg = data.toString();
  if (msg.includes('listening on')) {
    console.log(`[Chromium Ready] ${msg.trim()}`);
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

  try {
    // 将 CDP 任务放入并发队列中执行
    const data = await limiter.enqueue(async () => {
      let client;
      let targetTab;

      try {
        // 创建独立的新标签页
        targetTab = await CDP.New();
        client = await CDP({ target: targetTab });

        const { Network, Page } = client;
        const results = {};
        const pendingTargets = new Set(targets);
        const matchedRequests = new Map(); 

        await Network.enable();
        await Page.enable();

        // 核心抓取逻辑，带有 15 秒超时机制
        const waitForInterception = new Promise((resolve) => {
          const timeout = setTimeout(() => resolve(results), 15000);

          // 拦截响应头
          Network.responseReceived((params) => {
            const resUrl = params.response.url;
            for (const target of pendingTargets) {
              if (resUrl.includes(target)) {
                matchedRequests.set(params.requestId, { target, status: params.response.status });
                break;
              }
            }
          });

          // 等待响应体加载完成
          Network.loadingFinished(async (params) => {
            if (matchedRequests.has(params.requestId)) {
              const { target, status } = matchedRequests.get(params.requestId);
              try {
                const responseData = await Network.getResponseBody({ requestId: params.requestId });
                const bodyStr = responseData.base64Encoded 
                  ? Buffer.from(responseData.body, 'base64').toString('utf8') 
                  : responseData.body;

                // 尝试解析为 JSON，解析失败则保留原字符串
                let parsedBody = bodyStr;
                try { parsedBody = JSON.parse(bodyStr); } catch (e) {}

                results[target] = { status, body: parsedBody };
                pendingTargets.delete(target);
                
                // 全部收集完毕，提前结束
                if (pendingTargets.size === 0) {
                  clearTimeout(timeout);
                  resolve(results);
                }
              } catch (e) {
                console.error(`获取 [${target}] body 失败:`, e.message);
              }
            }
          });
        });

        // 触发页面访问
        await Page.navigate({ url });
        
        // 挂起等待结果
        const finalResults = await waitForInterception;
        return finalResults;

      } finally {
        // 确保无论成功失败，都能释放资源关闭标签页
        if (client) await client.close();
        if (targetTab) await CDP.Close({ id: targetTab.id });
      }
    });

    return reply.send({ success: true, data });

  } catch (err) {
    fastify.log.error(err);
    return reply.status(500).send({ error: '内部运行错误', details: err.message });
  }
});

// ==========================================
// 4. 启动 HTTP 服务与优雅退出
// ==========================================
fastify.listen({ port: 3000, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  console.log(`Server listening at ${address}`);
});

process.on('SIGINT', () => {
  console.log('Shutting down...');
  if (chromeProcess) chromeProcess.kill();
  process.exit(0);
});
