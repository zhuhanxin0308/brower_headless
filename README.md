# Browser Service

高性能无头浏览器渲染服务，基于 `Fastify`、`puppeteer-core`、`generic-pool` 构建，支持动态页面渲染、截图、接口监听和文件抓取。

## 功能概览

- 渲染 JavaScript 驱动页面并返回完整 HTML
- 截图并返回图片二进制流
- 监听页面请求，抓取接口响应和静态资源信息
- 下载页面触发的目标文件
- 浏览器池复用，降低高并发下的启动开销
- 使用独立 `BrowserContext` 隔离每次请求的 Cookie、缓存和本地存储
- 集成 `puppeteer-extra-plugin-stealth` 降低基础自动化特征暴露

## 快速启动

### 方式一：Docker Compose

```bash
cp .env.example .env
# 修改 .env 中的 API_KEY
docker-compose up -d
```

### 方式二：本地运行

```bash
npm install
cp .env.example .env
# 修改 .env 中的 API_KEY 与 Chromium 路径
npm start
```

## 环境变量

| 变量名 | 默认值 | 说明 |
|------|------|------|
| `API_KEY` | 空 | 接口鉴权密钥。生产环境必须设置 |
| `PORT` | `3000` | 服务端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `MIN_BROWSERS` | `2` | 浏览器池最小实例数 |
| `MAX_BROWSERS` | `10` | 浏览器池最大实例数 |
| `PUPPETEER_EXECUTABLE_PATH` | `/usr/bin/chromium` | Chromium 可执行文件路径 |
| `ALLOW_PRIVATE_NETWORK` | `false` | 是否允许访问本地或内网地址。默认关闭以避免 SSRF 风险 |

## 安全说明

- 生产环境必须设置 `API_KEY`
- 默认只允许访问公网的 `http` / `https` 目标
- `ALLOW_PRIVATE_NETWORK=false` 时，会拒绝本地地址、回环地址和常见内网地址
- `/fetch-file` 会同时校验页面地址和文件地址

## API 约定

- 受保护接口需要携带请求头：`x-api-key: your-secret-key`
- 所有请求体均使用 `application/json`
- 成功响应统一包含 `ok: true`
- 失败响应统一包含 `ok: false` 和 `error`

---

## POST /render

渲染页面并返回完整 HTML。

### 请求示例

```bash
curl -X POST http://localhost:3000/render \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-secret-key" \
  -d '{
    "url": "https://www.douyin.com",
    "waitFor": "networkidle2",
    "timeout": 15000
  }'
```

### 参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `url` | `string` | 目标页面 URL，必填 |
| `waitFor` | `string` | 等待时机：`load` / `domcontentloaded` / `networkidle0` / `networkidle2` |
| `timeout` | `number` | 超时毫秒数，默认 `15000` |
| `headers` | `object` | 附加请求头 |
| `cookies` | `string \| object[]` | Cookie 字符串或 Cookie 对象数组 |

### 返回示例

```json
{
  "ok": true,
  "html": "<html>...</html>",
  "title": "页面标题",
  "finalUrl": "https://www.douyin.com/"
}
```

---

## POST /screenshot

对目标页面截图，返回图片二进制流。

### 请求示例

```bash
curl -X POST http://localhost:3000/screenshot \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-secret-key" \
  --output screenshot.png \
  -d '{
    "url": "https://example.com",
    "waitFor": "networkidle2",
    "format": "png",
    "fullPage": true,
    "viewport": {
      "width": 1440,
      "height": 900,
      "deviceScaleFactor": 1
    }
  }'
```

### 参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `url` | `string` | 目标页面 URL，必填 |
| `waitFor` | `string` | 等待时机：`load` / `domcontentloaded` / `networkidle0` / `networkidle2` |
| `timeout` | `number` | 超时毫秒数，默认 `20000` |
| `headers` | `object` | 附加请求头 |
| `cookies` | `string \| object[]` | Cookie 字符串或 Cookie 对象数组 |
| `format` | `string` | 图片格式：`png` / `jpeg` / `webp`，默认 `png` |
| `fullPage` | `boolean` | 是否截全页，默认 `true` |
| `quality` | `number` | `jpeg` / `webp` 质量，范围 `0-100` |
| `clip` | `object` | 指定截图区域，传入后会忽略 `fullPage` |
| `viewport` | `object` | 视口设置，支持 `width`、`height`、`deviceScaleFactor` |

### 返回说明

- 成功时直接返回图片二进制流
- `Content-Type` 会根据 `format` 自动设置
- `Content-Disposition` 为 `inline; filename="screenshot.xxx"`

---

## POST /intercept

打开页面时同时监听接口响应和目标资源类型。

### 请求示例

```bash
curl -X POST http://localhost:3000/intercept \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-secret-key" \
  -d '{
    "url": "https://example.com",
    "listenUrls": ["/api/feed", "/graphql"],
    "fileTypes": ["image", "video"],
    "timeout": 20000
  }'
```

### 参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `url` | `string` | 目标页面 URL，必填 |
| `listenUrls` | `string[]` | 需要监听的接口 URL 关键字 |
| `fileTypes` | `string[]` | 需要记录的资源类型：`image` / `video` / `audio` / `pdf` / `json` / `css` / `js` / `font` |
| `timeout` | `number` | 超时毫秒数，默认 `20000` |
| `headers` | `object` | 附加请求头 |
| `cookies` | `string \| object[]` | Cookie 字符串或 Cookie 对象数组 |

### 返回示例

```json
{
  "ok": true,
  "finalUrl": "https://example.com/",
  "captured": [
    {
      "url": "https://api.example.com/feed",
      "status": 200,
      "contentType": "application/json",
      "body": {
        "items": []
      }
    }
  ],
  "files": [
    {
      "url": "https://cdn.example.com/video.mp4",
      "contentType": "video/mp4",
      "status": 200
    }
  ]
}
```

---

## POST /fetch-file

下载页面加载过程中命中的单个文件，返回文件二进制流。

### 请求示例

```bash
curl -X POST http://localhost:3000/fetch-file \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-secret-key" \
  --output video.mp4 \
  -d '{
    "url": "https://example.com/page",
    "fileUrl": "https://cdn.example.com/video.mp4"
  }'
```

### 参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `url` | `string` | 触发下载的页面 URL，必填 |
| `fileUrl` | `string` | 目标文件 URL，必填 |
| `timeout` | `number` | 超时毫秒数，默认 `20000` |
| `cookies` | `string \| object[]` | Cookie 字符串或 Cookie 对象数组 |

### 返回说明

- 成功时直接返回文件二进制流
- 未捕获到目标文件时返回 `404`

---

## GET /health

健康检查接口。

### 请求示例

```bash
curl http://localhost:3000/health
```

### 返回示例

```json
{
  "ok": true,
  "pool": {
    "size": 5,
    "available": 3,
    "borrowed": 2
  }
}
```

---

## Cookie 格式

支持两种写法：

### 字符串格式

```json
{
  "cookies": "session=abc; token=xyz"
}
```

### 对象数组格式

```json
{
  "cookies": [
    {
      "name": "session",
      "value": "abc",
      "httpOnly": true,
      "secure": true
    }
  ]
}
```

## 反爬与隔离策略

当前版本已接入以下策略：

- `puppeteer-extra` + `puppeteer-extra-plugin-stealth`
- 定制 `user-agent-override`，统一处理 UA、语言和平台信息
- 随机轮换桌面端 `User-Agent`
- 启动 Chromium 时关闭常见自动化特征参数
- 每个请求使用独立 `BrowserContext`
- 通过浏览器池复用浏览器进程，避免每次都冷启动

说明：

- `stealth` 只能降低被简单规则识别的概率，不能保证绕过所有反爬策略
- 如果目标站点存在更强的指纹校验、行为校验或风控联动，仍可能被识别

## 测试

```bash
npm test
```

当前测试覆盖以下关键行为：

- URL 安全校验
- API 鉴权
- 浏览器上下文隔离
- 拦截响应和文件下载时的异步等待

## 部署建议

- 2GB 内存环境建议保持 `MAX_BROWSERS=10` 以下
- 8GB 内存环境可从 `MAX_BROWSERS=15` 起评估
- 如果频繁截图长页面，建议优先增加 `shm_size`
- Docker 部署时请确保容器内 Chromium 路径与 `PUPPETEER_EXECUTABLE_PATH` 一致
