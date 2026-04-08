# 使用 Debian 12 (Bookworm) 的轻量版
FROM node:20-bookworm-slim

# 1. 安装核心依赖：Xvfb 虚拟显示器、字体、以及 Chrome 需要的底层库
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    xvfb \
    dbus-x11 \
    fonts-liberation \
    fonts-noto-cjk \
    libu2f-udev \
    libvulkan1 \
    --no-install-recommends

# 2. 下载并安装官方原版 Google Chrome (Stable)
RUN wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# 3. 设置工作目录
WORKDIR /app

# 4. 安装 Node 依赖 (利用 Docker 缓存)
COPY package.json ./
RUN npm install --production

# 5. 拷贝核心代码和启动脚本
COPY server.js ./
COPY entrypoint.sh ./

# 6. 赋予启动脚本执行权限
RUN chmod +x entrypoint.sh

# 暴露 API 端口
EXPOSE 3000

# 7. 必须使用 entrypoint 脚本作为入口，以在后台拉起 Xvfb 虚拟显示器
ENTRYPOINT ["./entrypoint.sh"]
