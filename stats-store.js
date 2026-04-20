const DEFAULT_MAX_RECENT_REQUESTS = 60;
const DEFAULT_MAX_RECENT_LATENCIES = 2000;
const DASHBOARD_EXCLUDED_PATHS = new Set(['/', '/favicon.ico']);

// 统一限制数组长度，避免历史记录无限增长导致内存持续膨胀。
function pushLimited(list, value, maxSize) {
  if (maxSize <= 0) {
    return;
  }

  list.push(value);

  while (list.length > maxSize) {
    list.shift();
  }
}

function createMetricBucket() {
  return {
    totalRequests: 0,
    successRequests: 0,
    errorRequests: 0,
    totalDurationMs: 0,
    maxDurationMs: 0,
    lastDurationMs: 0,
    lastRequestedAt: null,
    lastStatusCode: null,
    recentDurations: [],
    statusCounts: {},
  };
}

function normalizeDuration(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return 0;
  }

  return Number(durationMs.toFixed(2));
}

function calculatePercentile(values, percentile) {
  if (values.length === 0) {
    return 0;
  }

  const sortedValues = [...values].sort((left, right) => left - right);
  const position = (sortedValues.length - 1) * (percentile / 100);
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);

  if (lowerIndex === upperIndex) {
    return Number(sortedValues[lowerIndex].toFixed(2));
  }

  const lowerValue = sortedValues[lowerIndex];
  const upperValue = sortedValues[upperIndex];
  const result = lowerValue + (upperValue - lowerValue) * (position - lowerIndex);
  return Number(result.toFixed(2));
}

function summarizeMetricBucket(bucket) {
  const avgDurationMs = bucket.totalRequests === 0
    ? 0
    : Number((bucket.totalDurationMs / bucket.totalRequests).toFixed(2));
  const successRate = bucket.totalRequests === 0
    ? 100
    : Number(((bucket.successRequests / bucket.totalRequests) * 100).toFixed(2));

  return {
    totalRequests: bucket.totalRequests,
    successRequests: bucket.successRequests,
    errorRequests: bucket.errorRequests,
    avgDurationMs,
    p50DurationMs: calculatePercentile(bucket.recentDurations, 50),
    p95DurationMs: calculatePercentile(bucket.recentDurations, 95),
    p99DurationMs: calculatePercentile(bucket.recentDurations, 99),
    maxDurationMs: Number(bucket.maxDurationMs.toFixed(2)),
    lastDurationMs: Number(bucket.lastDurationMs.toFixed(2)),
    lastRequestedAt: bucket.lastRequestedAt,
    lastStatusCode: bucket.lastStatusCode,
    successRate,
    statusCounts: { ...bucket.statusCounts },
  };
}

function createStatsStore(options = {}) {
  const now = options.now ?? (() => Date.now());
  const maxRecentRequests = options.maxRecentRequests ?? DEFAULT_MAX_RECENT_REQUESTS;
  const maxRecentLatencies = options.maxRecentLatencies ?? DEFAULT_MAX_RECENT_LATENCIES;
  const serviceStartedAtMs = now();
  const overallMetrics = createMetricBucket();
  const endpointMetrics = new Map();
  const recentRequests = [];
  let inflightRequests = 0;

  function shouldTrackRequest(method, path) {
    return Boolean(method) && Boolean(path) && !DASHBOARD_EXCLUDED_PATHS.has(path);
  }

  function getEndpointBucket(method, path) {
    const endpointKey = `${method.toUpperCase()} ${path}`;

    if (!endpointMetrics.has(endpointKey)) {
      endpointMetrics.set(endpointKey, {
        method: method.toUpperCase(),
        path,
        metrics: createMetricBucket(),
      });
    }

    return endpointMetrics.get(endpointKey);
  }

  function markRequestStart(method, path) {
    if (!shouldTrackRequest(method, path)) {
      return null;
    }

    inflightRequests += 1;
    return now();
  }

  function recordRequest({
    method,
    path,
    statusCode,
    durationMs,
    requestedAt,
    errorMessage = '',
  }) {
    if (!shouldTrackRequest(method, path)) {
      return;
    }

    inflightRequests = Math.max(0, inflightRequests - 1);
    const normalizedDuration = normalizeDuration(durationMs);
    const normalizedRequestedAt = requestedAt ?? new Date(now()).toISOString();
    const isSuccess = statusCode < 400;
    const endpointBucket = getEndpointBucket(method, path);

    [overallMetrics, endpointBucket.metrics].forEach((bucket) => {
      bucket.totalRequests += 1;
      bucket.totalDurationMs += normalizedDuration;
      bucket.maxDurationMs = Math.max(bucket.maxDurationMs, normalizedDuration);
      bucket.lastDurationMs = normalizedDuration;
      bucket.lastRequestedAt = normalizedRequestedAt;
      bucket.lastStatusCode = statusCode;
      bucket.statusCounts[statusCode] = (bucket.statusCounts[statusCode] || 0) + 1;
      pushLimited(bucket.recentDurations, normalizedDuration, maxRecentLatencies);

      if (isSuccess) {
        bucket.successRequests += 1;
      } else {
        bucket.errorRequests += 1;
      }
    });

    // 最近调用记录保留关键信息，便于首页快速定位最新异常与慢请求。
    pushLimited(recentRequests, {
      method: method.toUpperCase(),
      path,
      statusCode,
      durationMs: normalizedDuration,
      requestedAt: normalizedRequestedAt,
      errorMessage,
    }, maxRecentRequests);
  }

  function buildSnapshot({ poolInfo = null } = {}) {
    const generatedAtMs = now();
    const overview = summarizeMetricBucket(overallMetrics);
    const endpoints = [...endpointMetrics.values()]
      .map((entry) => ({
        method: entry.method,
        path: entry.path,
        name: `${entry.method} ${entry.path}`,
        ...summarizeMetricBucket(entry.metrics),
      }))
      .sort((left, right) => {
        if (right.totalRequests !== left.totalRequests) {
          return right.totalRequests - left.totalRequests;
        }

        return String(right.lastRequestedAt).localeCompare(String(left.lastRequestedAt));
      });
    const pool = poolInfo
      ? {
        ...poolInfo,
        utilizationRate: poolInfo.size > 0
          ? Number(((poolInfo.borrowed / poolInfo.size) * 100).toFixed(2))
          : 0,
      }
      : null;

    return {
      generatedAt: new Date(generatedAtMs).toISOString(),
      serviceStartedAt: new Date(serviceStartedAtMs).toISOString(),
      uptimeMs: Math.max(0, generatedAtMs - serviceStartedAtMs),
      inflightRequests,
      overview,
      pool,
      endpoints,
      recentRequests: [...recentRequests].reverse(),
      excludedPaths: [...DASHBOARD_EXCLUDED_PATHS],
    };
  }

  return {
    buildSnapshot,
    markRequestStart,
    recordRequest,
    shouldTrackRequest,
  };
}

module.exports = {
  DASHBOARD_EXCLUDED_PATHS,
  createStatsStore,
};
