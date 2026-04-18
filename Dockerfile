FROM node:24-slim

# 安装 Chromium 及依赖
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-noto-cjk \
    ca-certificates \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
