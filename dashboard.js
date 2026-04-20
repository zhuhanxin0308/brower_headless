function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatInteger(value) {
  return Number(value || 0).toLocaleString('zh-CN');
}

function formatDuration(value) {
  return `${Number(value || 0).toFixed(2)} ms`;
}

function formatPercent(value) {
  return `${Number(value || 0).toFixed(2)}%`;
}

function formatTime(value) {
  if (!value) {
    return '-';
  }

  return new Date(value).toLocaleString('zh-CN', {
    hour12: false,
  });
}

function formatUptime(uptimeMs) {
  const totalSeconds = Math.max(0, Math.floor((uptimeMs || 0) / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];

  if (days > 0) {
    parts.push(`${days} 天`);
  }

  if (hours > 0 || days > 0) {
    parts.push(`${hours} 小时`);
  }

  if (minutes > 0 || hours > 0 || days > 0) {
    parts.push(`${minutes} 分钟`);
  }

  parts.push(`${seconds} 秒`);
  return parts.join(' ');
}

function renderMetricCard({ label, value, note, accent }) {
  return `
    <article class="metric-card">
      <span class="metric-accent ${escapeHtml(accent)}"></span>
      <p class="metric-label">${escapeHtml(label)}</p>
      <strong class="metric-value">${escapeHtml(value)}</strong>
      ${note ? `<p class="metric-note">${escapeHtml(note)}</p>` : ''}
    </article>
  `;
}

function renderEndpointRows(endpoints) {
  if (endpoints.length === 0) {
    return `
      <tr>
        <td colspan="7" class="empty-row">服务刚启动，暂时还没有业务调用记录。</td>
      </tr>
    `;
  }

  return endpoints.map((endpoint) => `
    <tr>
      <td><span class="endpoint-pill">${escapeHtml(endpoint.name)}</span></td>
      <td>${formatInteger(endpoint.totalRequests)}</td>
      <td>${formatPercent(endpoint.successRate)}</td>
      <td>${formatDuration(endpoint.avgDurationMs)}</td>
      <td>${formatDuration(endpoint.p95DurationMs)}</td>
      <td>${formatDuration(endpoint.maxDurationMs)}</td>
      <td>
        <span class="status-badge ${endpoint.lastStatusCode >= 400 ? 'is-danger' : 'is-ok'}">
          ${escapeHtml(endpoint.lastStatusCode ?? '-')}
        </span>
        <span class="subtle-text">${escapeHtml(formatTime(endpoint.lastRequestedAt))}</span>
      </td>
    </tr>
  `).join('');
}

function renderRecentRows(recentRequests) {
  if (recentRequests.length === 0) {
    return `
      <tr>
        <td colspan="5" class="empty-row">暂无最近调用记录。</td>
      </tr>
    `;
  }

  return recentRequests.map((request) => `
    <tr>
      <td>${escapeHtml(formatTime(request.requestedAt))}</td>
      <td><span class="endpoint-pill">${escapeHtml(`${request.method} ${request.path}`)}</span></td>
      <td>
        <span class="status-badge ${request.statusCode >= 400 ? 'is-danger' : 'is-ok'}">
          ${escapeHtml(request.statusCode)}
        </span>
      </td>
      <td>${formatDuration(request.durationMs)}</td>
      <td class="result-cell">${escapeHtml(request.errorMessage || '成功')}</td>
    </tr>
  `).join('');
}

function renderPoolPanel(pool) {
  if (!pool) {
    return `
      <div class="panel-block empty-panel">
        浏览器池尚未完成初始化。
      </div>
    `;
  }

  return `
    <div class="pool-grid">
      <div class="pool-item">
        <span class="pool-label">池大小</span>
        <strong class="pool-value">${formatInteger(pool.size)}</strong>
      </div>
      <div class="pool-item">
        <span class="pool-label">空闲实例</span>
        <strong class="pool-value">${formatInteger(pool.available)}</strong>
      </div>
      <div class="pool-item">
        <span class="pool-label">借出实例</span>
        <strong class="pool-value">${formatInteger(pool.borrowed)}</strong>
      </div>
      <div class="pool-item">
        <span class="pool-label">利用率</span>
        <strong class="pool-value">${formatPercent(pool.utilizationRate)}</strong>
      </div>
    </div>
  `;
}

// 首页完全由服务端直出，避免再引入额外前端依赖和静态资源路由。
function renderDashboardHtml(snapshot) {
  const cards = [
    {
      label: '历史请求总数',
      value: formatInteger(snapshot.overview.totalRequests),
      note: `成功 ${formatInteger(snapshot.overview.successRequests)} / 失败 ${formatInteger(snapshot.overview.errorRequests)}`,
      accent: 'accent-teal',
    },
    {
      label: '当前进行中请求',
      value: formatInteger(snapshot.inflightRequests),
      note: '',
      accent: 'accent-orange',
    },
    {
      label: '整体成功率',
      value: formatPercent(snapshot.overview.successRate),
      note: `平均耗时 ${formatDuration(snapshot.overview.avgDurationMs)}`,
      accent: 'accent-green',
    },
    {
      label: '延迟分位',
      value: `P95 ${formatDuration(snapshot.overview.p95DurationMs)}`,
      note: `P99 ${formatDuration(snapshot.overview.p99DurationMs)} / 最大 ${formatDuration(snapshot.overview.maxDurationMs)}`,
      accent: 'accent-red',
    },
  ].map(renderMetricCard).join('');

  return `
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="refresh" content="15" />
    <title>Browser Service 服务运行看板</title>
    <link rel="icon" href="data:," />
    <style>
      :root {
        --bg: #06131a;
        --bg-soft: rgba(8, 30, 39, 0.84);
        --panel: rgba(11, 38, 49, 0.78);
        --panel-strong: rgba(16, 49, 63, 0.92);
        --line: rgba(121, 181, 196, 0.22);
        --text: #f3fbff;
        --muted: #99b7c1;
        --teal: #51d2c9;
        --green: #89e67a;
        --orange: #ffb86b;
        --red: #ff7a7a;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        color: var(--text);
        background:
          radial-gradient(circle at top left, rgba(81, 210, 201, 0.18), transparent 28%),
          radial-gradient(circle at top right, rgba(255, 184, 107, 0.18), transparent 26%),
          linear-gradient(135deg, #02070a 0%, #06131a 48%, #081e27 100%);
        font-family: "Segoe UI Variable", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      }

      .shell {
        width: min(1280px, calc(100% - 32px));
        margin: 0 auto;
        padding: 28px 0 48px;
      }

      .hero {
        display: grid;
        grid-template-columns: minmax(0, 1.7fr) minmax(280px, 0.9fr);
        gap: 18px;
        align-items: stretch;
        margin-bottom: 18px;
      }

      .hero-main,
      .hero-meta,
      .panel {
        background: var(--bg-soft);
        border: 1px solid var(--line);
        border-radius: 24px;
        backdrop-filter: blur(14px);
        box-shadow: 0 18px 80px rgba(0, 0, 0, 0.28);
      }

      .hero-main {
        padding: 28px;
      }

      .eyebrow {
        margin: 0 0 10px;
        color: var(--teal);
        letter-spacing: 0.18em;
        font-size: 12px;
        font-weight: 700;
        text-transform: uppercase;
      }

      h1 {
        margin: 0;
        font-size: clamp(28px, 4vw, 44px);
        line-height: 1.05;
      }

      .hero-meta {
        padding: 24px;
        display: grid;
        gap: 14px;
      }

      .meta-row {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        padding-bottom: 12px;
        border-bottom: 1px solid rgba(121, 181, 196, 0.14);
      }

      .meta-row:last-child {
        border-bottom: 0;
        padding-bottom: 0;
      }

      .meta-label {
        color: var(--muted);
        font-size: 13px;
      }

      .meta-value {
        text-align: right;
        font-weight: 700;
      }

      .metric-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 16px;
        margin-bottom: 18px;
      }

      .metric-card {
        position: relative;
        padding: 22px 20px 18px;
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 22px;
        overflow: hidden;
      }

      .metric-accent {
        display: block;
        width: 56px;
        height: 4px;
        border-radius: 999px;
        margin-bottom: 18px;
      }

      .accent-teal {
        background: var(--teal);
      }

      .accent-green {
        background: var(--green);
      }

      .accent-orange {
        background: var(--orange);
      }

      .accent-red {
        background: var(--red);
      }

      .metric-label,
      .subtle-text,
      .metric-note {
        color: var(--muted);
      }

      .metric-label {
        margin: 0 0 8px;
        font-size: 13px;
      }

      .metric-value {
        display: block;
        font-size: clamp(24px, 3.6vw, 36px);
        line-height: 1.1;
        margin-bottom: 8px;
      }

      .metric-note {
        margin: 0;
        line-height: 1.6;
        font-size: 13px;
      }

      .panel {
        padding: 22px;
        margin-bottom: 18px;
      }

      .panel-header {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        align-items: end;
        margin-bottom: 16px;
      }

      .panel-title {
        margin: 0;
        font-size: 20px;
      }

      .pool-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 14px;
      }

      .pool-item {
        padding: 18px;
        border-radius: 18px;
        background: var(--panel-strong);
        border: 1px solid rgba(121, 181, 196, 0.14);
      }

      .pool-label {
        display: block;
        color: var(--muted);
        font-size: 13px;
        margin-bottom: 10px;
      }

      .pool-value {
        font-size: 28px;
      }

      table {
        width: 100%;
        border-collapse: collapse;
      }

      th,
      td {
        padding: 14px 10px;
        border-bottom: 1px solid rgba(121, 181, 196, 0.1);
        text-align: left;
        vertical-align: top;
        font-size: 14px;
      }

      th {
        color: var(--muted);
        font-size: 12px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .endpoint-pill {
        display: inline-flex;
        align-items: center;
        max-width: 100%;
        padding: 6px 10px;
        border-radius: 999px;
        background: rgba(81, 210, 201, 0.1);
        border: 1px solid rgba(81, 210, 201, 0.2);
        font-family: "Cascadia Mono", "Consolas", monospace;
        font-size: 12px;
        word-break: break-all;
      }

      .status-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 52px;
        padding: 4px 10px;
        border-radius: 999px;
        font-weight: 700;
        margin-right: 8px;
      }

      .is-ok {
        background: rgba(137, 230, 122, 0.14);
        color: var(--green);
      }

      .is-danger {
        background: rgba(255, 122, 122, 0.14);
        color: var(--red);
      }

      .result-cell {
        max-width: 420px;
        color: #d6e6ec;
        word-break: break-word;
      }

      .empty-row,
      .empty-panel {
        padding: 24px 12px;
        color: var(--muted);
        text-align: center;
      }

      @media (max-width: 1080px) {
        .metric-grid,
        .pool-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }

      @media (max-width: 820px) {
        .shell {
          width: min(100%, calc(100% - 20px));
          padding-top: 18px;
        }

        .hero {
          grid-template-columns: 1fr;
        }

        .panel {
          overflow-x: auto;
        }

        table {
          min-width: 760px;
        }
      }

      @media (max-width: 560px) {
        .metric-grid,
        .pool-grid {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <section class="hero">
        <div class="hero-main">
          <p class="eyebrow">Browser Service Dashboard</p>
          <h1>服务运行看板</h1>
        </div>
        <aside class="hero-meta">
          <div class="meta-row">
            <span class="meta-label">服务启动时间</span>
            <strong class="meta-value">${escapeHtml(formatTime(snapshot.serviceStartedAt))}</strong>
          </div>
          <div class="meta-row">
            <span class="meta-label">已运行时长</span>
            <strong class="meta-value">${escapeHtml(formatUptime(snapshot.uptimeMs))}</strong>
          </div>
          <div class="meta-row">
            <span class="meta-label">页面生成时间</span>
            <strong class="meta-value">${escapeHtml(formatTime(snapshot.generatedAt))}</strong>
          </div>
        </aside>
      </section>

      <section class="metric-grid">
        ${cards}
      </section>

      <section class="panel">
        <div class="panel-header">
          <div><h2 class="panel-title">浏览器池状态</h2></div>
        </div>
        ${renderPoolPanel(snapshot.pool)}
      </section>

      <section class="panel">
        <div class="panel-header">
          <div><h2 class="panel-title">接口历史概览</h2></div>
        </div>
        <table>
          <thead>
            <tr>
              <th>接口</th>
              <th>请求数</th>
              <th>成功率</th>
              <th>平均耗时</th>
              <th>P95</th>
              <th>最大耗时</th>
              <th>最近一次</th>
            </tr>
          </thead>
          <tbody>
            ${renderEndpointRows(snapshot.endpoints)}
          </tbody>
        </table>
      </section>

      <section class="panel">
        <div class="panel-header">
          <div><h2 class="panel-title">最近调用记录</h2></div>
        </div>
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>接口</th>
              <th>状态</th>
              <th>耗时</th>
              <th>结果</th>
            </tr>
          </thead>
          <tbody>
            ${renderRecentRows(snapshot.recentRequests)}
          </tbody>
        </table>
      </section>
    </main>
  </body>
</html>
  `;
}

module.exports = {
  renderDashboardHtml,
};
