// 额度推送（长轮询）单测：node --test test/
import assert from 'node:assert/strict';
import test from 'node:test';
import { createQuotaHub } from '../lib/quota-hub.js';

const quota = { windows: { '5h': { utilization: 0.1 }, '7d': { utilization: 0.2 } } };

function makeHub(overrides = {}) {
  const hub = createQuotaHub({
    waitMs: 400,
    body: (seq) => ({ ok: true, seq, quota }),
    json: (res, status, body) => {
      res.writableEnded = true;
      res.body = body;
      res.resolve();
    },
    ...overrides,
  });
  return hub;
}

function pendingRes() {
  const res = { writableEnded: false };
  res.done = new Promise((resolve) => { res.resolve = resolve; });
  return res;
}

const quietReq = () => ({ on() {} });

test('seq 落后时立即返回当前快照', () => {
  const hub = makeHub();
  const res = pendingRes();
  hub.handle(quietReq(), res, -1);
  assert.equal(res.body.seq, 0);
  assert.deepEqual(res.body.quota, quota);
});

test('挂起后 notify 立即放行，带新 seq', async () => {
  const hub = makeHub();
  const res = pendingRes();
  const t0 = Date.now();
  hub.handle(quietReq(), res, 0);
  assert.equal(res.writableEnded, false, '应处于挂起状态');
  setTimeout(() => hub.notify(), 20);
  await res.done;
  assert.equal(res.body.seq, 1);
  assert.deepEqual(res.body.quota, quota);
  assert.ok(Date.now() - t0 < 200, '推送延迟过高');
});

test('没有新观测时到点返回 unchanged', async () => {
  const hub = makeHub({ waitMs: 120 });
  const res = pendingRes();
  hub.handle(quietReq(), res, hub.seq);
  await res.done;
  assert.equal(res.body.unchanged, true);
  assert.equal(res.body.seq, hub.seq);
});

test('等待连接数到上限后退化为立即返回', () => {
  const hub = makeHub({ waitMs: 5000, maxWaiters: 2 });
  hub.handle(quietReq(), pendingRes(), 0);
  hub.handle(quietReq(), pendingRes(), 0);
  assert.equal(hub.size, 2);
  const extra = pendingRes();
  hub.handle(quietReq(), extra, 0);
  assert.equal(extra.body.unchanged, true);
  assert.equal(hub.size, 2);
});

test('连接关闭后回收等待者', () => {
  const hub = makeHub({ waitMs: 5000 });
  let onClose = null;
  const req = { on(ev, fn) { if (ev === 'close') onClose = fn; } };
  const res = pendingRes();
  hub.handle(req, res, 0);
  assert.equal(hub.size, 1);
  onClose();
  assert.equal(hub.size, 0);
  assert.equal(res.writableEnded, false);
});
