/**
 * 额度变更推送（长轮询）。
 *
 * 额度只有真的发过一次模型请求才有新观测（上游没有查询接口），所以这里的
 * 「实时」指的是：一次请求结束后立刻把新观测放行给正开着胶囊的页面，而不是
 * 让页面等下一次轮询。
 *
 * 用长轮询而不是 SSE：面板请求要带 x-dsh-hduhelp 头，EventSource 发不了
 * 自定义头。这里与宿主解耦，json 由调用方注入，便于单测。
 */

export const DEFAULT_WAIT_MS = 20000;
export const DEFAULT_MAX_WAITERS = 32;

export function createQuotaHub(opts = {}) {
  const waitMs = Number(opts.waitMs) > 0 ? Number(opts.waitMs) : DEFAULT_WAIT_MS;
  const maxWaiters = Number(opts.maxWaiters) > 0 ? Number(opts.maxWaiters) : DEFAULT_MAX_WAITERS;
  const json = typeof opts.json === 'function' ? opts.json : () => {};
  const body = typeof opts.body === 'function' ? opts.body : (seq) => ({ ok: true, seq });

  const waiters = new Set();
  let seq = 0;

  /** 当前快照（含 seq，客户端拿它做 since）。 */
  function payload() {
    return body(seq);
  }

  /** 有新观测（或额度被清空）就把所有还在等的页面放行。 */
  function notify() {
    seq += 1;
    const current = seq;
    for (const w of [...waiters]) {
      try { w.send(current); } catch { /* 单个连接坏掉不影响其他页面 */ }
    }
  }

  /**
   * 处理一次 GET /quota/wait?since=N：
   *   · seq 已经比 since 新 → 立即返回当前值
   *   · 否则挂起，最多 waitMs，没有新观测就返回 { unchanged: true }
   */
  function handle(req, res, since) {
    const at = Number.isFinite(since) ? since : 0;
    if (seq > at) {
      json(res, 200, body(seq));
      return;
    }
    if (waiters.size >= maxWaiters) {
      // 连接太多就退化成「立刻返回当前值」，不让等待集合无上限增长。
      json(res, 200, { ...body(seq), unchanged: true });
      return;
    }

    let settled = false;
    const waiter = {
      send(current) {
        finish(body(current));
      },
    };

    function finish(out) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      waiters.delete(waiter);
      try {
        if (!res.writableEnded) json(res, 200, out);
      } catch { /* 浏览器已断开 */ }
    }

    const timer = setTimeout(() => finish({ ...body(seq), unchanged: true }), waitMs);
    if (typeof timer.unref === 'function') timer.unref();
    waiters.add(waiter);

    // 页面刷新/关闭立刻回收，别让空连接占到超时。
    if (req && typeof req.on === 'function') {
      req.on('close', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        waiters.delete(waiter);
      });
    }
  }

  return {
    payload,
    notify,
    handle,
    get seq() { return seq; },
    get size() { return waiters.size; },
  };
}
