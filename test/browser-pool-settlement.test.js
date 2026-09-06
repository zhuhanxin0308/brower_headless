const test = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { createBrowserPool, withPage } = require('../browser-pool');
const { createAdmissionPool } = require('../browser-pool-admission');
const { createPool } = require('generic-pool');

const TEST_WAIT_TIMEOUT_MS = 40;
const TEST_CLEANUP_TIMEOUT_MS = 20;

function deferred() {
  let resolve;
  const promise = new Promise((onResolve) => { resolve = onResolve; });
  return { promise, resolve };
}

function browserStub(overrides = {}) {
  return {
    closed: false,
    isConnected() { return !this.closed; },
    async close() { this.closed = true; },
    async createBrowserContext() {
      return { async newPage() { return {}; }, async close() {} };
    },
    ...overrides,
  };
}

function admissionPool(overrides = {}, options = {}) {
  const raw = {
    async acquire() { return browserStub(); },
    async release() {},
    async destroy() {},
    async drain() {},
    async clear() {},
    emit() {},
    ...overrides,
  };
  return createAdmissionPool(raw, {
    maxBrowsers: 1,
    maxPendingAcquires: 1,
    acquireTimeoutMillis: TEST_WAIT_TIMEOUT_MS,
    cleanupTimeoutMillis: TEST_CLEANUP_TIMEOUT_MS,
    closeAbandonedBrowser: (browser) => browser.close(),
    ...options,
  });
}

test('真实池销毁必须等旧浏览器关闭后才放行下一业务', async () => {
  const closing = deferred();
  const closeStarted = deferred();
  let launches = 0;
  let secondRan = false;
  const damaged = browserStub({
    async close() { closeStarted.resolve(); await closing.promise; this.closed = true; },
    async createBrowserContext() {
      return { async newPage() { return {}; }, async close() { throw new Error('上下文关闭失败'); } };
    },
  });
  const pool = createBrowserPool({
    minBrowsers: 0,
    maxBrowsers: 1,
    maxPendingAcquires: 1,
    launchBrowser: async () => ++launches === 1 ? damaged : browserStub(),
  });
  const first = withPage(pool, async () => '旧业务').catch((error) => error);
  await closeStarted.promise;
  const second = withPage(pool, async () => { secondRan = true; return '新业务'; });
  await delay(0);
  const ranBeforeClose = secondRan;
  const launchesBeforeClose = launches;
  closing.resolve();
  await first;
  assert.equal(await second, '新业务');
  await pool.drain();
  await pool.clear();
  assert.equal(ranBeforeClose, false, '旧实例仍在关闭时不能执行新业务');
  assert.equal(launchesBeforeClose, 1);
});

test('归还和销毁登记都失败但实际关闭成功后结算借用并保留原始错误', async () => {
  const damaged = browserStub();
  const releaseError = new Error('归还登记失败');
  const destroyError = new Error('销毁登记失败');
  let acquired = 0;
  const pool = admissionPool({
    async acquire() { return acquired++ === 0 ? damaged : browserStub(); },
    async release(browser) { if (browser === damaged) throw releaseError; },
    async destroy(browser) { if (browser === damaged) throw destroyError; },
  });
  const error = await withPage(pool, async () => '业务').catch((failure) => failure);
  const next = await withPage(pool, async () => '恢复').catch((failure) => failure);
  const drained = await Promise.race([pool.drain().then(() => true), delay(TEST_WAIT_TIMEOUT_MS).then(() => false)]);
  assert.equal(damaged.closed, true);
  assert.equal(error, releaseError);
  assert.equal(error.cleanupError, destroyError);
  assert.equal(pool.isBorrowedResource(damaged), false);
  assert.equal(next, '恢复');
  assert.equal(drained, true);
});

test('迟到归还与先完成的销毁只能结算同一借用一次', async () => {
  const firstRelease = deferred();
  let releaseCalls = 0;
  const pool = admissionPool({
    release() { return ++releaseCalls === 1 ? firstRelease.promise : Promise.resolve(); },
  });
  const browser = await pool.acquire();
  const lateRelease = pool.release(browser);
  await pool.destroy(browser);
  firstRelease.resolve();
  await lateRelease;
  const next = await pool.acquire();
  let concurrent = false;
  const waiting = pool.acquire().then((value) => { concurrent = true; return value; });
  await delay(0);
  const overAdmitted = concurrent;
  await pool.release(next);
  await pool.release(await waiting);
  const drained = await Promise.race([pool.drain().then(() => true), delay(TEST_WAIT_TIMEOUT_MS).then(() => false)]);
  assert.equal(overAdmitted, false, '并发上限不能因为迟到归还被重复减计数而失效');
  assert.equal(drained, true);
});

test('旧借用的迟到归还不会删除同一浏览器的新借用身份', async () => {
  const firstRelease = deferred();
  const browser = browserStub();
  let releases = 0;
  const pool = admissionPool({
    async acquire() { return browser; },
    release() { return ++releases === 1 ? firstRelease.promise : Promise.resolve(); },
  }, { maxBrowsers: 2, closeAbandonedBrowser: async () => assert.fail('旧借用不能关闭新持有者') });
  const first = await pool.acquire();
  const firstToken = pool.borrowToken(first);
  const lateRelease = pool.release(first, firstToken);
  const next = await pool.acquire();
  const nextToken = pool.borrowToken(next);
  firstRelease.resolve();
  await lateRelease;
  const remainsBorrowed = pool.isBorrowedResource(next);
  await pool.destroy(first, firstToken);
  const remainsAfterDuplicateDestroy = pool.isBorrowedResource(next);
  await pool.release(next, nextToken);
  await pool.drain();
  assert.notEqual(firstToken, nextToken);
  assert.equal(remainsBorrowed, true);
  assert.equal(remainsAfterDuplicateDestroy, true);
});

test('实际关闭成功后通过公开借用状态补偿失败的销毁登记', async () => {
  const damaged = browserStub();
  const registered = new Set();
  const releaseError = new Error('首次归还失败');
  const destroyError = new Error('销毁登记失败');
  let acquisitions = 0;
  let releases = 0;
  const pool = admissionPool({
    async acquire() {
      const browser = acquisitions++ === 0 ? damaged : browserStub();
      registered.add(browser);
      return browser;
    },
    async release(browser) {
      if (releases++ === 0) throw releaseError;
      registered.delete(browser);
    },
    async destroy() { throw destroyError; },
    isBorrowedResource: (browser) => registered.has(browser),
    async drain() { assert.equal(registered.size, 0); },
  });
  const error = await withPage(pool, async () => '旧业务').catch((failure) => failure);
  assert.equal(error, releaseError);
  assert.equal(error.cleanupError, destroyError);
  assert.equal(damaged.closed, true);
  assert.equal(registered.has(damaged), false);
  assert.equal(await withPage(pool, async () => '恢复'), '恢复');
  await pool.drain();
});

test('真实关闭失败时保持槽位隔离并让排空报告失败', async () => {
  const closeError = new Error('真实浏览器无法关闭');
  const browser = browserStub({ async close() { throw closeError; } });
  let acquisitions = 0;
  let destroyRegistrations = 0;
  const events = [];
  const pool = admissionPool({
    async acquire() { acquisitions += 1; return browser; },
    async destroy() { destroyRegistrations += 1; },
    emit(name, error) { events.push({ name, error }); },
  });
  await pool.acquire();
  await assert.rejects(pool.destroy(browser), (error) => error === closeError);
  await assert.rejects(pool.acquire(), (error) => error.statusCode === 503);
  await assert.rejects(pool.drain(), (error) => error === closeError);
  assert.equal(acquisitions, 1);
  assert.equal(destroyRegistrations, 0);
  assert.equal(pool.isBorrowedResource(browser), true);
  assert.deepEqual(events, [{ name: 'factoryDestroyError', error: closeError }]);
});

test('底层明确仍持有借用且登记补偿失败时隔离并报告，不能假装恢复', async () => {
  const browser = browserStub();
  const releaseError = new Error('归还登记始终失败');
  const destroyError = new Error('销毁登记始终失败');
  const pool = admissionPool({
    async acquire() { return browser; },
    async release() { throw releaseError; },
    async destroy() { throw destroyError; },
    isBorrowedResource: () => true,
  });
  const error = await withPage(pool, async () => '业务').catch((failure) => failure);
  assert.equal(browser.closed, true);
  assert.equal(error, releaseError);
  assert.equal(error.cleanupError, destroyError);
  assert.equal(pool.isBorrowedResource(browser), true);
  await assert.rejects(pool.acquire(), (failure) => failure.statusCode === 503);
  await assert.rejects(pool.drain(), (failure) => failure === destroyError);
  assert.equal(destroyError.cleanupError, undefined, '错误附件不能形成循环引用');
});

test('迟到归还成功不能解除真实关闭失败后的槽位隔离', async () => {
  const release = deferred();
  const closeError = new Error('终止浏览器失败');
  const browser = browserStub({ async close() { throw closeError; } });
  const pool = admissionPool({
    async acquire() { return browser; },
    release() { return release.promise; },
  });
  await pool.acquire();
  const lateRelease = pool.release(browser).catch((error) => error);
  await assert.rejects(pool.destroy(browser), (error) => error === closeError);
  release.resolve();
  assert.equal(await lateRelease, closeError);
  assert.equal(pool.isBorrowedResource(browser), true);
  await assert.rejects(pool.acquire(), (error) => error.statusCode === 503);
  await assert.rejects(pool.drain(), (error) => error === closeError);
});

test('实际已归还但确认迟到时旧请求收尾不能关闭新请求接手的浏览器', async () => {
  const acknowledgement = deferred();
  const browser = browserStub();
  let releases = 0;
  const raw = createPool({ create: async () => browser, destroy: (value) => value.close() }, { min: 0, max: 2 });
  const pool = admissionPool({
    acquire: () => raw.acquire(),
    async release(value) {
      await raw.release(value);
      if (++releases === 1) await acknowledgement.promise;
    },
    destroy: (value) => raw.destroy(value),
    isBorrowedResource: (value) => raw.isBorrowedResource(value),
    drain: () => raw.drain(),
    clear: () => raw.clear(),
  }, { maxBrowsers: 2 });
  const oldBrowser = await pool.acquire();
  const oldToken = pool.borrowToken(oldBrowser);
  const lateRelease = pool.release(oldBrowser, oldToken);
  await delay(0);
  const currentBrowser = await pool.acquire();
  const currentToken = pool.borrowToken(currentBrowser);
  await pool.destroyAndClose(oldBrowser, oldToken);
  const closedByOldOwner = currentBrowser.closed;
  const currentRegistrationPreserved = raw.isBorrowedResource(currentBrowser);
  acknowledgement.resolve();
  await lateRelease;
  await pool.destroyAndClose(currentBrowser, currentToken).catch(() => {});
  await pool.drain();
  await pool.clear();
  assert.equal(currentBrowser, oldBrowser);
  assert.notEqual(currentToken, oldToken);
  assert.equal(closedByOldOwner, false);
  assert.equal(currentRegistrationPreserved, true);
});

test('旧浏览器仍在关闭时再次获取到该实例必须拒绝交付', async () => {
  const acknowledgement = deferred();
  const closing = deferred();
  const closeStarted = deferred();
  let releases = 0;
  const browser = browserStub({ async close() { closeStarted.resolve(); await closing.promise; this.closed = true; } });
  const raw = createPool({ create: async () => browser, destroy: (value) => value.close() }, { min: 0, max: 2 });
  const pool = admissionPool({
    acquire: () => raw.acquire(),
    async release(value) { await raw.release(value); if (++releases === 1) await acknowledgement.promise; },
    destroy: (value) => raw.destroy(value),
    isBorrowedResource: (value) => raw.isBorrowedResource(value),
    drain: () => raw.drain(),
    clear: () => raw.clear(),
  }, { maxBrowsers: 2 });
  await pool.acquire();
  const token = pool.borrowToken(browser);
  const lateRelease = pool.release(browser, token);
  await delay(0);
  const retiring = pool.destroyAndClose(browser, token);
  await closeStarted.promise;
  const next = await pool.acquire().then((value) => ({ browser: value }), (error) => ({ error }));
  closing.resolve();
  await retiring;
  acknowledgement.resolve();
  await lateRelease;
  if (next.browser) await pool.destroy(next.browser).catch(() => {});
  await pool.drain();
  await pool.clear();
  assert.equal(next.error?.statusCode, 503);
  assert.equal(next.browser, undefined);
});

test('原借用已结算后迟到的底层获取仍不能交付已退役浏览器', async () => {
  const acknowledgement = deferred();
  const acquiredAck = deferred();
  const acquiredInUnderlying = deferred();
  let releases = 0;
  let acquisitions = 0;
  const raw = createPool({ create: async () => browserStub(), destroy: (value) => value.close() }, { min: 0, max: 2 });
  const pool = admissionPool({
    async acquire() {
      const browser = await raw.acquire();
      if (++acquisitions === 2) { acquiredInUnderlying.resolve(); await acquiredAck.promise; }
      return browser;
    },
    async release(value) { await raw.release(value); if (++releases === 1) await acknowledgement.promise; },
    destroy: (value) => raw.destroy(value),
    isBorrowedResource: (value) => raw.isBorrowedResource(value),
    drain: () => raw.drain(),
    clear: () => raw.clear(),
  }, { maxBrowsers: 2 });
  const oldBrowser = await pool.acquire();
  const oldToken = pool.borrowToken(oldBrowser);
  const lateRelease = pool.release(oldBrowser, oldToken);
  await delay(0);
  const lateAcquire = pool.acquire().then((browser) => ({ browser }), (error) => ({ error }));
  await acquiredInUnderlying.promise;
  await pool.destroyAndClose(oldBrowser, oldToken);
  acquiredAck.resolve();
  const result = await lateAcquire;
  acknowledgement.resolve();
  await lateRelease;
  if (result.browser) await pool.destroy(result.browser).catch(() => {});
  const next = await pool.acquire();
  const healthy = !next.closed;
  await pool.release(next);
  await pool.drain();
  await pool.clear();
  assert.equal(result.error?.statusCode, 503);
  assert.equal(result.browser, undefined);
  assert.equal(healthy, true);
});
