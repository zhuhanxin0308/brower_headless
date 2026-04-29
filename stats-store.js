const DEFAULT_MAX_RECENT_REQUESTS = 60;
const DEFAULT_MAX_RECENT_LATENCIES = 2000;
const TRACKED_API_ROUTES = [
  'GET /health',
  'POST /render',
  'POST /screenshot',
  'POST /intercept',
  'POST /fetch-file',
];
const TRACKED_API_ROUTE_KEYS = new Set(TRACKED_API_ROUTES);

// 用环形缓冲区替代 shift，避免高频写入时反复搬移数组元素。
function createCircularBuffer(maxSize) {
  const values = maxSize > 0 ? new Array(maxSize) : [];
  let size = 0;
  let nextWriteIndex = 0;

  function getOrderedIndex(offset) {
    return (nextWriteIndex - size + offset + maxSize) % maxSize;
  }

  return {
    push(value) {
      if (maxSize <= 0) {
        return;
      }

      values[nextWriteIndex] = value;
      nextWriteIndex = (nextWriteIndex + 1) % maxSize;
      size = Math.min(size + 1, maxSize);
    },
    toArray() {
      if (size === 0) {
        return [];
      }

      return Array.from({ length: size }, (_, index) => values[getOrderedIndex(index)]);
    },
    toReversedArray() {
      if (size === 0) {
        return [];
      }

      return Array.from({ length: size }, (_, index) => values[getOrderedIndex(size - 1 - index)]);
    },
  };
}

function createMetricBucket(maxRecentLatencies) {
  return {
    totalRequests: 0,
    successRequests: 0,
    errorRequests: 0,
    totalDurationMs: 0,
    maxDurationMs: 0,
    lastDurationMs: 0,
    lastRequestedAt: null,
    lastStatusCode: null,
    recentDurations: createCircularBuffer(maxRecentLatencies),
    statusCounts: {},
  };
}

function normalizeDuration(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return 0;
  }

  return Number(durationMs.toFixed(2));
}

function calculatePercentile(sortedValues, percentile) {
  if (sortedValues.length === 0) {
    return 0;
  }

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
  const recentDurations = bucket.recentDurations.toArray();
  // 单次排序后复用到多个分位计算，避免首页每次刷新都重复排序同一批数据。
  const sortedDurations = recentDurations.length > 1
    ? [...recentDurations].sort((left, right) => left - right)
    : recentDurations;
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
    p50DurationMs: calculatePercentile(sortedDurations, 50),
    p95DurationMs: calculatePercentile(sortedDurations, 95),
    p99DurationMs: calculatePercentile(sortedDurations, 99),
    maxDurationMs: Number(bucket.maxDurationMs.toFixed(2)),
    lastDurationMs: Number(bucket.lastDurationMs.toFixed(2)),
    lastRequestedAt: bucket.lastRequestedAt,
    lastStatusCode: bucket.lastStatusCode,
    successRate,
    statusCounts: { ...bucket.statusCounts },
  };
}

function createRouteKey(method, path) {
  return `${String(method || '').toUpperCase()} ${path || ''}`.trim();
}

function createStatsStore(options = {}) {
  const now = options.now ?? (() => Date.now());
  const maxRecentRequests = options.maxRecentRequests ?? DEFAULT_MAX_RECENT_REQUESTS;
  const maxRecentLatencies = options.maxRecentLatencies ?? DEFAULT_MAX_RECENT_LATENCIES;
  const serviceStartedAtMs = now();
  const overallMetrics = createMetricBucket(maxRecentLatencies);
  const endpointMetrics = new Map();
  const recentRequests = createCircularBuffer(maxRecentRequests);
  let inflightRequests = 0;

  function shouldTrackRequest(method, path) {
    return TRACKED_API_ROUTE_KEYS.has(createRouteKey(method, path));
  }

  function getEndpointBucket(method, path) {
    const endpointKey = `${method.toUpperCase()} ${path}`;

    if (!endpointMetrics.has(endpointKey)) {
      endpointMetrics.set(endpointKey, {
        method: method.toUpperCase(),
        path,
        metrics: createMetricBucket(maxRecentLatencies),
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
      bucket.recentDurations.push(normalizedDuration);

      if (isSuccess) {
        bucket.successRequests += 1;
      } else {
        bucket.errorRequests += 1;
      }
    });

    // 最近调用记录保留关键信息，便于首页快速定位最新异常与慢请求。
    recentRequests.push({
      method: method.toUpperCase(),
      path,
      statusCode,
      durationMs: normalizedDuration,
      requestedAt: normalizedRequestedAt,
      errorMessage,
    });
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
      recentRequests: recentRequests.toReversedArray(),
      trackedRoutes: TRACKED_API_ROUTES,
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
  TRACKED_API_ROUTES,
  TRACKED_API_ROUTE_KEYS,
  createStatsStore,
};
