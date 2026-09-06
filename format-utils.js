// Dashboard 与测试共用的格式化工具函数。

const DATE_TIME_FORMAT_OPTIONS = {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
  hour12: false,
};
let defaultTimeFormatter = null;
let formatterTimeZone;

function getDefaultTimeFormatter() {
  const timeZone = process.env.TZ;
  // 复用同一默认时区的格式化器；运行时切换 TZ 后重新读取进程默认时区。
  if (!defaultTimeFormatter || formatterTimeZone !== timeZone) {
    defaultTimeFormatter = new Intl.DateTimeFormat('zh-CN', DATE_TIME_FORMAT_OPTIONS);
    formatterTimeZone = timeZone;
  }
  return defaultTimeFormatter;
}

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

  const date = new Date(value);
  // Intl.format 会拒绝无效日期，保留原 toLocaleString 返回文本的行为。
  return Number.isNaN(date.getTime()) ? date.toString() : getDefaultTimeFormatter().format(date);
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
