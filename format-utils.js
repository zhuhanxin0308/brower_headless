// Dashboard 与测试共用的格式化工具函数。

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

module.exports = {
  escapeHtml,
  formatDuration,
  formatInteger,
  formatPercent,
  formatTime,
  formatUptime,
};
