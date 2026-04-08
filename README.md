# Minimal Headless CDP API

这是一个基于 Alpine Linux 构建的极致轻量、高性能的 Headless 浏览器 API 容器。它放弃了笨重的 Puppeteer/Playwright，直接使用底层 CDP (Chrome DevTools Protocol) 协议与全局 Chromium 守护进程通信，专为高并发的网络请求拦截和抓包设计。

## ✨ 核心特性

* **极致轻量**：基于 `node:20-alpine` 构建，仅安装 Chromium 及其最基础依赖，无多余 UI 组件。
* **极限性能**：底层全局维护单个 Chromium 进程，请求到来时仅通过新建/关闭无痕标签页 (Tab) 处理，免去频繁启动浏览器的开销。并在内核层禁用了图片加载、GPU 和音频。
* **防 OOM 崩溃**：内置基于信号量的并发请求队列机制。超出内存阈值的并发请求会自动排队，彻底告别容器内存溢出崩溃。
* **精准拦截**：提供简单的 HTTP 接口，指定目标 URL 和需要监听的 XHR/Fetch 接口列表，即可提取并返回首个匹配的响应体 (Response Body)。

## 🚀 快速开始

### 1. 拉取镜像
镜像已经通过 GitHub Actions 自动构建并推送到 Docker Hub。

```bash
docker pull zhuhanxin/brower_headless:latest
```

### 2. 运行容器
> **⚠️ 核心注意：** 必须携带 `--init` 参数运行！这能防止 Node.js 成为 PID 1，确保 Chromium 产生的子进程在退出时能被系统正确回收，防止僵尸进程耗尽资源。

```bash
docker run -d \
  -p 3000:3000 \
  --init \
  --name minimal-cdp-api \
  zhuhanxin/brower_headless:latest
```

## 📖 API 接口文档

### 抓取请求 `POST /fetch`

启动无头浏览器访问指定网页，并等待拦截目标接口列表的响应内容。默认超时时间为 15 秒。

**Request Body (application/json):**

| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `url` | String | 需要浏览器访问的初始网页地址。 |
| `targets` | Array[String] | 需要监听拦截的接口 URL 片段（支持模糊匹配，如路径名）。 |

**请求示例 (cURL):**

```bash
curl -X POST http://localhost:3000/fetch \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com/login",
    "targets": [
      "/api/v1/auth/session",
      "config.json"
    ]
  }'
```

**响应示例:**

```json
{
  "success": true,
  "data": {
    "/api/v1/auth/session": {
      "status": 200,
      "body": {
        "userId": 12345,
        "token": "eyJh..."
      }
    },
    "config.json": {
      "status": 200,
      "body": {
        "version": "1.0.0",
        "theme": "dark"
      }
    }
  }
}
```

## 🛠️ 本地开发与配置修改

如果你需要修改并发限制或调试代码，可以克隆本仓库并在本地构建。

1. **调整并发上限**：打开 `server.js`，找到 `new ConcurrencyLimiter(5)`，根据你的服务器内存大小修改 `5` 这个数值（通常 1GB 内存建议保持 5 左右）。
2. **本地构建镜像**：
   ```bash
   docker build -t my-custom-cdp-api .
   ```
