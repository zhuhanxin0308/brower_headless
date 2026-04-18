# Browser Service

高性能无头浏览器渲染服务，支持动态页面抓取、接口监听、文件捕获。

## 快速启动

```bash
cp .env.example .env
# 修改 .env 中的 API_KEY
docker-compose up -d
```

## API 接口

所有请求需携带 Header：`x-api-key: your-secret-key`

---

### POST /render — 渲染页面

返回完整渲染后的 HTML。

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

**参数：**
| 参数 | 类型 | 说明 |
|------|------|------|
| url | string | 目标页面 URL（必填）|
| waitFor | string | 等待时机：load / domcontentloaded / networkidle0 / networkidle2 |
| timeout | number | 超时毫秒数，默认 15000 |
| headers | object | 附加请求头 |

**返回：**
```json
{
  "ok": true,
  "html": "<html>...</html>",
  "title": "页面标题",
  "finalUrl": "https://..."
}
```

---

### POST /intercept — 监听接口 & 文件

打开页面同时监听指定接口响应，或捕获特定类型的文件请求。

```bash
# 监听 API 接口
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

**参数：**
| 参数 | 类型 | 说明 |
|------|------|------|
| url | string | 目标页面 URL（必填）|
| listenUrls | string[] | 要监听的接口 URL 关键词 |
| fileTypes | string[] | 要监听的文件类型：image / video / audio / pdf / json / css / js / font |
| timeout | number | 超时毫秒数，默认 20000 |

**返回：**
```json
{
  "ok": true,
  "finalUrl": "https://...",
  "captured": [
    {
      "url": "https://api.example.com/feed",
      "status": 200,
      "contentType": "application/json",
      "body": { ... }
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

### POST /fetch-file — 下载文件流

以文件流形式返回目标文件内容。

```bash
curl -X POST http://localhost:3000/fetch-file \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-secret-key" \
  -d '{
    "url": "https://example.com/page",
    "fileUrl": "https://cdn.example.com/video.mp4"
  }' \
  --output video.mp4
```

---

### GET /health — 健康检查

```bash
curl http://localhost:3000/health
```

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

## 反爬策略

已内置以下反检测措施：

- 随机轮换 User-Agent
- 隐藏 `navigator.webdriver` 标志
- 伪造 `navigator.plugins` / `navigator.languages`
- 注入 `window.chrome` 对象
- 禁用自动化相关 Chromium 参数（`--disable-blink-features=AutomationControlled`）

## 性能调优

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| MIN_BROWSERS | 2 | 池中最少保持的浏览器实例数 |
| MAX_BROWSERS | 10 | 最大并发浏览器数，按服务器内存调整（每个约 200MB）|

建议：8GB 内存服务器设 MAX_BROWSERS=15，16GB 设 25。
