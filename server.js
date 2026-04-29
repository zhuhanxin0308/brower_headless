require('dotenv').config();

const { buildApp } = require('./app');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

async function startServer() {
  const app = buildApp();

  // 优雅关闭：收到终止信号后先停止接收新请求，等待进行中请求完成，再清理浏览器池。
  function handleShutdown(signal) {
    app.log.info(`收到 ${signal} 信号，开始优雅关闭...`);
    app.close().then(() => {
      app.log.info('服务已安全关闭');
      process.exit(0);
    }).catch((error) => {
      app.log.error(error, '关闭过程中发生错误');
      process.exit(1);
    });
  }

  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
  process.on('SIGINT', () => handleShutdown('SIGINT'));

  try {
    await app.listen({ port: PORT, host: HOST });
    app.log.info(`🚀 Browser Service 启动在 http://${HOST}:${PORT}`);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

if (require.main === module) {
  startServer();
}

module.exports = {
  startServer,
};
