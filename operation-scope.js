// Node 定时器支持的最大毫秒数，避免较大值溢出后被当成一毫秒执行。
const MAX_TOTAL_TIMEOUT_MS = 2 ** 31 - 1;

function createOperationError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

// 总时限与客户端断连共用一个信号，下游必须在取消时清理持有的浏览器资源。
function createOperationScope({ totalTimeout, request, response }) {
  const controller = new AbortController();
  const { signal } = controller;
  let timer;

  function disconnect() {
    if (!response.writableEnded) {
      controller.abort(createOperationError('客户端已断开连接', 499));
    }
  }

  request.once('aborted', disconnect);
  response.once('close', disconnect);
  if (request.aborted || response.destroyed) disconnect();

  if (totalTimeout != null && !signal.aborted) {
    timer = setTimeout(() => {
      controller.abort(createOperationError('操作超过总时限', 504));
    }, totalTimeout);
  }

  return {
    signal,
    // DNS 查询没有取消接口，停止等待后仍观察迟到结果，禁止迟到启动浏览器。
    waitFor(promise) {
      return new Promise((resolve, reject) => {
        const cancel = () => reject(signal.reason);
        signal.addEventListener('abort', cancel, { once: true });
        Promise.resolve(promise).then(
          (value) => {
            signal.removeEventListener('abort', cancel);
            if (signal.aborted) reject(signal.reason);
            else resolve(value);
          },
          (error) => {
            signal.removeEventListener('abort', cancel);
            reject(signal.aborted ? signal.reason : error);
          },
        );
        if (signal.aborted) {
          signal.removeEventListener('abort', cancel);
          cancel();
        }
      });
    },
    dispose() {
      clearTimeout(timer);
      request.removeListener('aborted', disconnect);
      response.removeListener('close', disconnect);
    },
  };
}

module.exports = { createOperationScope, MAX_TOTAL_TIMEOUT_MS };
