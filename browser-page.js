const DEFAULT_CLEANUP_TIMEOUT_MS = 5000;
const FORCE_KILL_TIMEOUT_MS = 1000;
const browserClosures = new WeakMap();

function bounded(operation, timeoutMillis, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMillis);
  });
  return Promise.race([Promise.resolve().then(operation), timeout])
    .finally(() => clearTimeout(timer));
}

function processHasExited(child) {
  return child.exitCode != null || child.signalCode != null;
}

function terminateProcess(child) {
  if (processHasExited(child)) {
    return Promise.resolve();
  }

  // 只使用当前浏览器返回的子进程句柄，不按名称或系统进程列表终止浏览器。
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      child.off('exit', onExit);
      child.off('error', onError);
      if (error) reject(error);
      else resolve();
    };
    const onExit = () => finish();
    const onError = (error) => finish(error);
    const timer = setTimeout(() => finish(new Error('浏览器子进程终止超时')), FORCE_KILL_TIMEOUT_MS);
    child.once('exit', onExit);
    child.once('error', onError);
    try {
      if (!child.kill('SIGKILL')) {
        finish(processHasExited(child) ? undefined : new Error('无法终止浏览器子进程'));
      }
    } catch (error) {
      finish(error);
    }
  });
}

function closeBrowser(browser, { cleanupTimeoutMillis = DEFAULT_CLEANUP_TIMEOUT_MS } = {}) {
  if (browserClosures.has(browser)) {
    return browserClosures.get(browser);
  }

  // 池的 destroy 立即返回；共享同一关闭任务，才能等到实际浏览器资源收尾。
  const closing = (async () => {
    const child = browser.process?.();
    try {
      await bounded(() => browser.close(), cleanupTimeoutMillis, '浏览器关闭超时');
    } catch (error) {
      if (child) {
        await terminateProcess(child);
      } else if (!browser.isConnected || browser.isConnected()) {
        throw error;
      }
    }
  })();
  browserClosures.set(browser, closing);
  return closing;
}

function reportCleanupError(pool, error) {
  // 请求已取消后才到达的资源没有响应通道，沿用池的资源回收错误事件进行报告。
  pool.emit?.('factoryDestroyError', error);
}

function attachCleanupError(error, cleanupError) {
  if (error && typeof error === 'object' && error !== cleanupError) {
    error.cleanupError = cleanupError;
  }
}

async function destroyBorrowedBrowser(pool, browser, cleanupTimeoutMillis, leaseToken) {
  if (pool.destroyAndClose) {
    // 适配器按借用身份完成实际关闭与槽位结算，不能再次关闭已转交后续请求的浏览器。
    return pool.destroyAndClose(browser, leaseToken);
  }
  let poolError;
  try {
    await bounded(() => pool.destroy(browser), cleanupTimeoutMillis, '浏览器池销毁超时');
  } catch (error) {
    poolError = error;
  }

  // 即使池的资源登记失败，也必须尝试终止本次借用的浏览器。
  try {
    await closeBrowser(browser, { cleanupTimeoutMillis });
  } catch (error) {
    if (!poolError) throw error;
    attachCleanupError(poolError, error);
  }
  if (poolError) {
    throw poolError;
  }
}

async function releaseBrowser(pool, browser, cleanupTimeoutMillis, leaseToken) {
  try {
    await bounded(() => pool.release(browser, leaseToken), cleanupTimeoutMillis, '浏览器归还超时');
  } catch (error) {
    try {
      await destroyBorrowedBrowser(pool, browser, cleanupTimeoutMillis, leaseToken);
    } catch (cleanupError) {
      attachCleanupError(error, cleanupError);
    }
    throw error;
  }
}

function abortable(operation, signal, onLateValue) {
  if (signal?.aborted) {
    return Promise.reject(signal.reason);
  }
  if (!signal) {
    return Promise.resolve().then(operation);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (!settled) {
        settled = true;
        reject(signal.reason);
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(() => {
      // 进入微任务前也可能取消，避免已经取消的请求继续分配新资源。
      if (signal.aborted) throw signal.reason;
      return operation();
    }).then((value) => {
      signal.removeEventListener('abort', onAbort);
      if (settled) {
        onLateValue?.(value);
      } else {
        settled = true;
        resolve(value);
      }
    }, (error) => {
      signal.removeEventListener('abort', onAbort);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

function mapAcquireError(error) {
  if (error?.name === 'TimeoutError'
    || error?.message === 'max waitingClients count exceeded'
    || error?.message === 'pool is draining and cannot accept work') {
    const unavailable = new Error('浏览器池繁忙或等待超时，请稍后重试', { cause: error });
    unavailable.statusCode = 503;
    return unavailable;
  }
  return error;
}

async function withPage(pool, fn, { signal, cleanupTimeoutMillis = DEFAULT_CLEANUP_TIMEOUT_MS } = {}) {
  let browser;
  try {
    browser = await abortable(() => pool.acquireForRequest ? pool.acquireForRequest(signal) : pool.acquire(), signal, (lateBrowser) => {
      releaseBrowser(pool, lateBrowser, cleanupTimeoutMillis, pool.borrowToken?.(lateBrowser))
        .catch((error) => reportCleanupError(pool, error));
    });
  } catch (error) {
    throw signal?.aborted && error === signal.reason ? error : mapAcquireError(error);
  }

  const leaseToken = pool.borrowToken?.(browser);
  let context;
  let phase = 'context';
  let discardBrowser = false;
  let result;
  let taskError;
  let hasTaskError = false;
  const retainFirstError = (error) => {
    if (!hasTaskError) {
      taskError = error;
      hasTaskError = true;
    }
  };
  const closeLateResource = (resource) => {
    bounded(() => resource.close(), cleanupTimeoutMillis, '迟到浏览器资源清理超时')
      .catch((error) => reportCleanupError(pool, error));
  };

  try {
    // 每个请求始终使用独立上下文，创建页面失败也必须关闭已经创建的上下文。
    context = await abortable(() => browser.createBrowserContext(), signal, closeLateResource);
    phase = 'page';
    const page = await abortable(() => context.newPage(), signal, closeLateResource);
    phase = 'running';
    result = await abortable(() => fn(page, context), signal);
  } catch (error) {
    retainFirstError(error);
    // 创建过程尚未结束时不能证明资源已稳定，取消后直接淘汰整个浏览器。
    discardBrowser = signal?.aborted && error === signal.reason && phase !== 'running';
  }

  if (context) {
    try {
      await bounded(() => context.close(), cleanupTimeoutMillis, '浏览器上下文清理超时');
    } catch (error) {
      retainFirstError(error);
      discardBrowser = true;
    }
  }

  try {
    if (discardBrowser) {
      await destroyBorrowedBrowser(pool, browser, cleanupTimeoutMillis, leaseToken);
    } else {
      await releaseBrowser(pool, browser, cleanupTimeoutMillis, leaseToken);
    }
  } catch (error) {
    reportCleanupError(pool, error);
    retainFirstError(error);
  }

  // 总时限也覆盖资源收尾，不能在取消后把已经过期的业务结果返回给调用者。
  if (signal?.aborted) {
    throw signal.reason;
  }
  if (hasTaskError) {
    throw taskError;
  }
  return result;
}

module.exports = {
  attachCleanupError,
  bounded,
  closeBrowser,
  DEFAULT_CLEANUP_TIMEOUT_MS,
  FORCE_KILL_TIMEOUT_MS,
  withPage,
};
