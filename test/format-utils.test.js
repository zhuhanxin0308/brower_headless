const test = require('node:test');
const assert = require('node:assert/strict');

const {
  escapeHtml,
  formatDuration,
  formatInteger,
  formatPercent,
  formatTime,
  formatUptime,
} = require('../format-utils');

// ====== escapeHtml ======

test('escapeHtml 会转义五种 HTML 特殊字符', () => {
  assert.equal(escapeHtml('&<>"\' '), '&amp;&lt;&gt;&quot;&#39; ');
});

test('escapeHtml 对 null 和 undefined 返回空字符串', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});

test('escapeHtml 对数字和布尔值会转换为字符串', () => {
  assert.equal(escapeHtml(123), '123');
  assert.equal(escapeHtml(true), 'true');
});

test('escapeHtml 对空字符串返回空字符串', () => {
  assert.equal(escapeHtml(''), '');
});

// ====== formatInteger ======

test('formatInteger 对 0 返回 0', () => {
  assert.equal(formatInteger(0), '0');
});

test('formatInteger 对 null 和 undefined 返回 0', () => {
  assert.equal(formatInteger(null), '0');
  assert.equal(formatInteger(undefined), '0');
});

test('formatInteger 对正整数返回本地化格式', () => {
  // 不同 locale 可能有不同分隔符，只验证核心数字内容
  const result = formatInteger(12345);
  assert.ok(result.includes('12') && result.includes('345'));
});

// ====== formatDuration ======

test('formatDuration 对 0 返回 0.00 ms', () => {
  assert.equal(formatDuration(0), '0.00 ms');
});

test('formatDuration 对 null 返回 0.00 ms', () => {
  assert.equal(formatDuration(null), '0.00 ms');
});

test('formatDuration 对浮点数保留两位小数', () => {
  assert.equal(formatDuration(123.456), '123.46 ms');
});

test('formatDuration 对负数正常格式化', () => {
  assert.equal(formatDuration(-5), '-5.00 ms');
});

// ====== formatPercent ======

test('formatPercent 对 0 返回 0.00%', () => {
  assert.equal(formatPercent(0), '0.00%');
});

test('formatPercent 对 100 返回 100.00%', () => {
  assert.equal(formatPercent(100), '100.00%');
});

test('formatPercent 对 null 返回 0.00%', () => {
  assert.equal(formatPercent(null), '0.00%');
});

test('formatPercent 对浮点数保留两位小数', () => {
  assert.equal(formatPercent(99.999), '100.00%');
});

// ====== formatTime ======

test('formatTime 对 falsy 值返回 -', () => {
  assert.equal(formatTime(null), '-');
  assert.equal(formatTime(''), '-');
  assert.equal(formatTime(undefined), '-');
});

test('formatTime 对有效 ISO 时间戳返回本地化字符串', () => {
  const result = formatTime('2026-04-20T12:00:00.000Z');
  // 至少包含年份和时间分隔符
  assert.ok(result.includes('2026'));
});

// ====== formatUptime ======

test('formatUptime 对 0 返回 0 秒', () => {
  assert.equal(formatUptime(0), '0 秒');
});

test('formatUptime 对 null 返回 0 秒', () => {
  assert.equal(formatUptime(null), '0 秒');
});

test('formatUptime 对负数返回 0 秒', () => {
  assert.equal(formatUptime(-5000), '0 秒');
});

test('formatUptime 对不足一分钟只显示秒', () => {
  assert.equal(formatUptime(45000), '45 秒');
});

test('formatUptime 对超过一天显示天时分秒', () => {
  // 1天2小时3分4秒 = 93784000ms
  const ms = (86400 + 7200 + 180 + 4) * 1000;
  assert.equal(formatUptime(ms), '1 天 2 小时 3 分钟 4 秒');
});

test('formatUptime 对恰好整分钟显示 0 秒', () => {
  assert.equal(formatUptime(60000), '1 分钟 0 秒');
});

test('formatUptime 对恰好整小时显示 0 分钟 0 秒', () => {
  assert.equal(formatUptime(3600000), '1 小时 0 分钟 0 秒');
});
