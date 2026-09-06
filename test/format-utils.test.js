const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

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

test('formatTime 对无效日期保持原有文本且不抛出异常', () => {
  assert.equal(formatTime('invalid-date'), new Date('invalid-date').toLocaleString('zh-CN', { hour12: false }));
  assert.equal(formatTime(Infinity), new Date(Infinity).toLocaleString('zh-CN', { hour12: false }));
});

test('formatTime 复用格式化器并在默认时区改变后保持原有日期输出', () => {
  // 使用独立进程验证默认时区切换，避免影响其他测试的时间格式。
  const script = `
    const assert = require('node:assert/strict');
    const OriginalDateTimeFormat = Intl.DateTimeFormat;
    let formatterCount = 0;
    Intl.DateTimeFormat = class extends OriginalDateTimeFormat {
      constructor(...args) {
        super(...args);
        formatterCount += 1;
      }
    };
    const { formatTime } = require(${JSON.stringify(require.resolve('../format-utils'))});
    const values = [
      '2026-01-01T00:00:00.000Z',
      '2026-07-01T12:34:56.000Z',
      '2026-03-08T07:30:00.000Z',
      new Date('2026-11-01T06:30:00.000Z'),
      1710000000000,
    ];
    const timeZones = ['UTC', 'Asia/Shanghai', 'America/New_York'];
    for (const [index, timeZone] of timeZones.entries()) {
      process.env.TZ = timeZone;
      for (let iteration = 0; iteration < 2; iteration += 1) {
        for (const value of values) {
          assert.equal(formatTime(value), new Date(value).toLocaleString('zh-CN', { hour12: false }));
        }
      }
      assert.equal(formatterCount, index + 1, '同一默认时区只应构造一次日期格式化器');
    }
    delete process.env.TZ;
    assert.equal(formatTime(values[0]), new Date(values[0]).toLocaleString('zh-CN', { hour12: false }));
    assert.equal(formatterCount, timeZones.length + 1);
  `;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr || result.error?.message);
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
