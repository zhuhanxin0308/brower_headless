const { waitForPageInitialization, stopContextInitialization } = require('./browser-initialization');

const states = new WeakMap();

function unavailable(message) {
  return Object.assign(new Error(message), { statusCode: 503 });
}

function requestUnsafeClosure(state) {
  if (!state.unsafe || state.consumer || state.initializing || state.closureRequested) return;
  state.closureRequested = true;
  // 没有业务使用者时立即清理不确定资源；业务持有时由 withPage 完成上下文收尾后再淘汰。
  Promise.resolve().then(() => state.closeBrowser(state.browser)).catch(state.reportError);
}

function closeContext(state, context) {
  if (!state.contextClosures.has(context)) {
    const closing = state.bounded(async () => {
      await stopContextInitialization(context, state.browser);
      await context.close();
    }, state.cleanupTimeoutMillis, '预热上下文清理超时')
      .catch((error) => {
        state.unsafe = true;
        state.error ||= error;
        throw error;
      });
    state.contextClosures.set(context, closing);
  }
  return state.contextClosures.get(context);
}

function observeFailure(state, error, unsafe = false) {
  state.disabled = true;
  if (!state.failureReported) state.error = error;
  state.failureReported = true;
  state.unsafe ||= unsafe;
  state.reportError(error);
  requestUnsafeClosure(state);
}

function prepare(state) {
  if (!state.replenish || state.stopped || state.disabled || state.ready || state.pending) return;
  const job = { context: null, finished: false };
  state.pending = job;
  job.done = Promise.resolve().then(async () => {
    try {
      job.context = await state.browser.createBrowserContext();
      if (state.stopped || state.disabled) {
        await closeContext(state, job.context);
        return;
      }
      const page = await job.context.newPage();
      await waitForPageInitialization(page);
      if (state.stopped || state.disabled) {
        await closeContext(state, job.context);
        return;
      }
      state.ready = { context: job.context, page };
    } catch (error) {
      if (job.context) {
        try {
          await closeContext(state, job.context);
        } catch (cleanupError) {
          if (error && typeof error === 'object' && error !== cleanupError) error.cleanupError = cleanupError;
        }
      }
      throw error;
    }
  }).finally(() => {
    job.finished = true;
    if (state.pending === job) state.pending = null;
  });
  // 停止时取消等待计时器，实际初始化仍独立被观察，迟到资源的清理不会因此丢失。
  job.handled = job.done.catch((error) => observeFailure(state, error));
  job.stopWaiting = new Promise((resolve) => { job.cancelWaiting = resolve; });
  // 每次消费最多补充一次。失败后停止预热，确认已清理时才允许退回原来的独立建页流程。
  job.wait = state.bounded(() => Promise.race([job.handled, job.stopWaiting]),
    state.preparationTimeoutMillis, '预热页面初始化超时')
    .catch((error) => observeFailure(state, error, !job.finished));
}

async function initializePrewarm(browser, options) {
  const state = {
    ...options,
    browser,
    replenish: true,
    stopped: false,
    disabled: false,
    unsafe: false,
    initializing: true,
    consumer: null,
    pending: null,
    ready: null,
    contextClosures: new WeakMap(),
  };
  states.set(browser, state);
  state.onDisconnected = () => {
    // 断连后也观察进行中的初始化；迟到的上下文和页面必须由准备任务收尾。
    stopPrewarm(browser).catch(state.reportError);
  };
  browser.once?.('disconnected', state.onDisconnected);
  prepare(state);
  await state.pending.wait;
  state.initializing = false;
  requestUnsafeClosure(state);
}

async function takePreparedPage(browser, signal) {
  const state = states.get(browser);
  if (!state) return null;
  if (signal?.aborted) throw signal.reason;
  if (state.consumer) throw unavailable('浏览器已有页面使用者');
  const consumer = Symbol('一次性页面使用者');
  state.consumer = consumer;
  if (state.pending) await state.pending.wait;
  if (signal?.aborted) throw signal.reason;
  if (state.unsafe) throw state.error;
  if (state.consumer !== consumer || state.stopped) throw unavailable('浏览器预热资源正在关闭');
  if (!state.ready) return null;
  const prepared = state.ready;
  state.ready = null;
  // 业务首次加载完成后再补充，避免初始化下一页与当前导航争用浏览器资源。
  state.refillPage = prepared.page;
  state.onLoad = () => {
    detachRefillListener(state);
    prepare(state);
  };
  prepared.page.once?.('load', state.onLoad);
  return prepared;
}

function detachRefillListener(state) {
  state.refillPage?.off?.('load', state.onLoad);
  state.refillPage = null;
  state.onLoad = null;
}

function finishPreparedPage(browser, { discard = false } = {}) {
  const state = states.get(browser);
  if (!state) return undefined;
  detachRefillListener(state);
  state.consumer = null;
  if (discard) state.replenish = false;
  // 没有导航的业务也会在自身上下文清理后补充，但不会等待补充完成才返回结果。
  prepare(state);
  requestUnsafeClosure(state);
  return unsafePrewarmError(browser);
}

function unsafePrewarmError(browser) {
  const state = states.get(browser);
  return state?.unsafe ? { error: state.error } : undefined;
}

function pausePrewarm(browser) {
  const state = states.get(browser);
  if (state) state.replenish = false;
}

function stopPrewarm(browser) {
  const state = states.get(browser);
  if (!state) return Promise.resolve();
  if (state.stopping) return state.stopping;
  state.stopped = true;
  state.replenish = false;
  detachRefillListener(state);
  state.pending?.cancelWaiting();
  browser.off?.('disconnected', state.onDisconnected);
  state.stopping = (async () => {
    // 正常关闭必须等 newPage 的插件初始化结束，避免浏览器关闭截断 UA 插件尚未返回的命令。
    if (state.pending) await state.pending.handled;
    if (state.ready) {
      const prepared = state.ready;
      state.ready = null;
      await closeContext(state, prepared.context).catch(state.reportError);
    }
  })();
  return state.stopping;
}

module.exports = {
  finishPreparedPage,
  initializePrewarm,
  pausePrewarm,
  stopPrewarm,
  takePreparedPage,
  unsafePrewarmError,
};
