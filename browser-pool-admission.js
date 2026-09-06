const { attachCleanupError, bounded, DEFAULT_CLEANUP_TIMEOUT_MS, FORCE_KILL_TIMEOUT_MS } = require('./browser-page');

function unavailable(message) {
  return Object.assign(new Error(message), { statusCode: 503 });
}

function createAdmissionPool(pool, {
  maxBrowsers, maxPendingAcquires, acquireTimeoutMillis, closeAbandonedBrowser,
  cleanupTimeoutMillis = DEFAULT_CLEANUP_TIMEOUT_MS,
}) {
  const waiting = new Map();
  const borrowed = new Map();
  const leaseTokens = new WeakMap();
  const retiredBrowsers = new WeakSet();
  const quarantined = new Map();
  let occupiedSlots = 0;
  let draining = false;
  let drainPromise;
  let resolveDrained;
  let rejectDrained;

  function notifyDrained() {
    if (draining && quarantined.size > 0) {
      for (const entry of waiting.values()) {
        complete(entry, unavailable('浏览器资源清理失败，服务正在关闭'));
      }
      waiting.clear();
      rejectDrained?.(quarantined.values().next().value);
    } else if (draining && occupiedSlots === 0 && waiting.size === 0) {
      resolveDrained?.();
    }
  }

  function complete(entry, error, browser) {
    if (entry.settled) return;
    entry.settled = true;
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener('abort', entry.onAbort);
    if (arguments.length === 3) entry.resolve(browser);
    else entry.reject(error);
  }

  function releaseSlot(slot) {
    if (slot.settled) return;
    slot.settled = true;
    occupiedSlots -= 1;
    dispatch();
    notifyDrained();
  }

  function settleLease(lease) {
    // 同一个浏览器可被后续请求再次借出，迟到操作只能结算自己持有的借用身份。
    if (borrowed.get(lease.browser) === lease) {
      borrowed.delete(lease.browser);
    }
    quarantined.delete(lease);
    releaseSlot(lease.slot);
  }

  function quarantineLease(lease, error) {
    quarantined.set(lease, error);
    pool.emit('factoryDestroyError', error);
    notifyDrained();
  }

  function registeredInUnderlyingPool(browser) {
    return typeof pool.isBorrowedResource === 'function' ? pool.isBorrowedResource(browser) : null;
  }

  async function removeRegistration(lease) {
    let registrationError;
    try {
      await bounded(() => pool.destroy(lease.browser), cleanupTimeoutMillis, '浏览器池销毁登记超时');
    } catch (error) {
      registrationError = error;
    }

    if (registeredInUnderlyingPool(lease.browser) === true) {
      let compensationError;
      try {
        // 浏览器已实际关闭，重新归还可让底层通过连接校验淘汰它，不接触依赖的私有账本。
        await bounded(() => pool.release(lease.browser), cleanupTimeoutMillis, '浏览器销毁补偿登记超时');
      } catch (error) {
        compensationError = error;
      }
      if (registeredInUnderlyingPool(lease.browser) === true) {
        const error = registrationError || new Error('浏览器已关闭但底层池仍登记为借用状态');
        if (compensationError && compensationError !== lease.releaseError) {
          attachCleanupError(error, compensationError);
        }
        throw error;
      }
    }
    return registrationError;
  }

  function retireLease(lease) {
    if (lease.retirement) return lease.retirement;
    if (lease.slot.settled) return Promise.resolve();
    if (borrowed.get(lease.browser) !== lease) {
      // 底层已经将浏览器交给新借用时，旧请求只能结算旧槽，不能关闭或修改新借用登记。
      settleLease(lease);
      return Promise.resolve();
    }
    lease.retiring = true;
    retiredBrowsers.add(lease.browser);
    lease.retirement = (async () => {
      try {
        // 必须先确认真实浏览器关闭，再移除底层登记；否则底层会提前补建最小实例。
        await bounded(() => closeAbandonedBrowser(lease.browser),
          cleanupTimeoutMillis + FORCE_KILL_TIMEOUT_MS, '浏览器销毁清理超时');
        if (borrowed.get(lease.browser) !== lease) {
          settleLease(lease);
          return;
        }
        const registrationError = await removeRegistration(lease);
        settleLease(lease);
        if (registrationError) throw registrationError;
      } catch (error) {
        if (!lease.slot.settled) quarantineLease(lease, error);
        throw error;
      }
    })();
    return lease.retirement;
  }

  async function releaseLease(lease) {
    if (lease.slot.settled) return;
    if (lease.retiring) return lease.retirement;
    try {
      await pool.release(lease.browser);
    } catch (error) {
      lease.releaseError = error;
      throw error;
    }
    if (lease.retiring) return lease.retirement;
    settleLease(lease);
  }

  async function releaseAbandoned(lease) {
    try {
      await bounded(() => releaseLease(lease), cleanupTimeoutMillis, '迟到浏览器归还超时');
    } catch (error) {
      try {
        await retireLease(lease);
      } catch (cleanupError) {
        attachCleanupError(error, cleanupError);
      }
      pool.emit('factoryDestroyError', error);
    }
  }

  function start(entry) {
    occupiedSlots += 1;
    const slot = { settled: false };
    Promise.resolve().then(() => {
      // 队列取消与启动位于同一事件循环，已取消项不再进入底层借用队列。
      if (entry.settled) return undefined;
      return pool.acquire();
    }).then((browser) => {
      if (!browser) {
        releaseSlot(slot);
      } else {
        const previousLease = borrowed.get(browser);
        if (previousLease?.retiring && !previousLease.slot.settled) {
          // 底层归还成功但确认迟到时，正在关闭的实例可能再次被取出；交给旧借用清理，禁止进入新业务。
          complete(entry, unavailable('浏览器正在回收，请稍后重试'));
          releaseSlot(slot);
          return;
        }
        const token = Object.freeze({});
        const lease = { browser, token, slot, retiring: false, retirement: null };
        leaseTokens.set(token, lease);
        borrowed.set(browser, lease);
        if (previousLease) {
          // 底层重新借出证明上次归还已生效，即使归还确认仍迟到，也不能继续保留旧所有权。
          settleLease(previousLease);
        }
        if (retiredBrowsers.has(browser)) {
          // 旧借用可能已经结算，但底层获取确认仍会迟到；对象退役记录不能随借用记录删除。
          complete(entry, unavailable('浏览器已退役，请稍后重试'));
          retireLease(lease).catch((error) => pool.emit('factoryDestroyError', error));
        } else if (entry.settled) {
          // Chromium 正在启动时无法撤销底层借用，迟到实例仍按同一个借用身份完成回收。
          releaseAbandoned(lease).catch((error) => pool.emit('factoryDestroyError', error));
        } else {
          complete(entry, null, browser);
        }
      }
    }, (error) => {
      complete(entry, error);
      releaseSlot(slot);
    });
  }

  function dispatch() {
    while (occupiedSlots < maxBrowsers && waiting.size > 0) {
      const [key, entry] = waiting.entries().next().value;
      waiting.delete(key);
      start(entry);
    }
  }

  function acquireForRequest(signal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (draining) return Promise.reject(unavailable('浏览器池正在关闭'));
    const canStart = occupiedSlots < maxBrowsers && waiting.size === 0;
    if (!canStart && waiting.size >= maxPendingAcquires) {
      return Promise.reject(unavailable('浏览器池等待队列已满，请稍后重试'));
    }

    return new Promise((resolve, reject) => {
      const key = Symbol('浏览器等待请求');
      const entry = { resolve, reject, signal, settled: false };
      const cancel = (error) => {
        waiting.delete(key);
        complete(entry, error);
        notifyDrained();
      };
      entry.onAbort = () => cancel(signal.reason);
      signal?.addEventListener('abort', entry.onAbort, { once: true });
      // 同一时限同时覆盖外部排队与浏览器启动，进入底层池时不重新计算等待预算。
      entry.timer = setTimeout(() => cancel(unavailable('浏览器池等待超时，请稍后重试')), acquireTimeoutMillis);
      if (canStart) start(entry);
      else waiting.set(key, entry);
    });
  }

  function findLease(browser, token) {
    const lease = token ? leaseTokens.get(token) : borrowed.get(browser);
    if (!lease || lease.browser !== browser) {
      throw new Error('浏览器不属于当前借用请求');
    }
    return lease;
  }

  const adapter = {
    acquire: () => acquireForRequest(),
    acquireForRequest,
    release: async (browser, token) => releaseLease(findLease(browser, token)),
    destroy: async (browser, token) => retireLease(findLease(browser, token)),
    destroyAndClose: async (browser, token) => retireLease(findLease(browser, token)),
    borrowToken: (browser) => borrowed.get(browser)?.token,
    ready: () => pool.ready(),
    clear: () => pool.clear(),
    isBorrowedResource: (browser) => borrowed.has(browser),
    drain() {
      if (!drainPromise) {
        draining = true;
        drainPromise = new Promise((resolve, reject) => {
          resolveDrained = resolve;
          rejectDrained = reject;
        }).then(() => pool.drain());
        notifyDrained();
      }
      return drainPromise;
    },
    // 等待数只统计尚未获得并发槽的请求，启动或已借出的浏览器不会挤占等待额度。
    get pending() { return waiting.size; },
    get size() { return pool.size; },
    get available() { return pool.available; },
    get borrowed() { return pool.borrowed; },
    get min() { return pool.min; },
    get max() { return pool.max; },
    on(event, listener) { pool.on(event, listener); return adapter; },
    once(event, listener) { pool.once(event, listener); return adapter; },
    off(event, listener) { pool.off(event, listener); return adapter; },
    emit: (event, ...args) => pool.emit(event, ...args),
  };
  return adapter;
}

module.exports = { createAdmissionPool };
