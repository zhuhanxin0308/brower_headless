FROM node:lts-alpine3.22

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
# 注意：在 Alpine 中，Chromium 的默认执行路径通常是 /usr/bin/chromium-browser
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
