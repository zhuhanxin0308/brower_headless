# 使用 Node 20 Alpine 作为基础镜像
FROM node:20-alpine

# 安装 Chromium 及字体依赖，并清理缓存以极致压缩体积
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont

# 设置环境变量指向正确的二进制文件路径
ENV CHROME_BIN=/usr/bin/chromium-browser \
    CHROME_PATH=/usr/lib/chromium/

# 设置工作目录
WORKDIR /app

# 利用 Docker 层缓存加速构建
COPY package.json ./
RUN npm install --production

# 复制核心代码
COPY server.js ./

# 暴露接口端口
EXPOSE 3000

# 启动服务
CMD ["npm", "start"]
