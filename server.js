require('dotenv').config();

const { buildApp } = require('./app');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

async function startServer() {
  const app = buildApp();

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
