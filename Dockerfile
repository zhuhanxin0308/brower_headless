FROM m.daocloud.io/docker.io/node:lts-alpine3.22

# 1. 替换包管理器为 apk，并安装 Alpine 下的 Chromium 及其渲染依赖
# --no-cache 可以避免产生缓存文件，减小镜像体积
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    font-noto-cjk

# 2. 设置 Puppeteer 环境变量
# 注意：当前镜像中的 Chromium 可执行文件路径使用 /usr/bin/chromium，需与应用配置保持一致
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund \
 && npm cache clean --force
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
