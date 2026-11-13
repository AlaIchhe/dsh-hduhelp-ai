/**
 * dsh-hduhelp-ai — host half.
 *
 * 定位：账号所有者单人使用。宿主侧只做两件事：
 *   1. 管 token（~/.dsh/hduhelp-ai/token.json，0600），刷新；
 *   2. 在 webServer 上挂 /__hduhelp/* 路由给设置面板用（登录/登出/状态/模型/额度）。
 * 模型调用走 adapter 直连 https://api.hduhelp.com/hduhelp-neo/ai/v1，
 * 不再对内网暴露任何 OpenAI 兼容端口。
 *
 * 登录走杭电 CAS：起子进程 lib/cas-login.mjs（纯 HTTP），宿主只拿结果。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HduhelpAdapter } from './adapter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAS_SCRIPT = path.join(__dirname, 'cas-login.mjs');
const API_BASE = 'https://api.hduhelp.com/hduhelp-neo';
// 到期前多久主动续期。expires_in 缺失时不做定时猜测，只靠 401 触发。
const RENEW_SKEW_MS = 2 * 60 * 1000;

const ROUTES = {
  status: '/__hduhelp/status',
  login: '/__hduhelp/login',
  logout: '/__hduhelp/logout',
  refresh: '/__hduhelp/refresh',
  models: '/__hduhelp/models',
  selection: '/__hduhelp/models/selection',
  quota: '/__hduhelp/quota',
};

function normalizeConfig(config = {}) {
  const dataDir = config.dataDir || path.join(os.homedir(), '.dsh', 'hduhelp-ai');
  return {
    purpose: config.purpose || 'app.mate.chat',
    dataDir,
    providerId: config.providerId || 'hduhelp',
    displayName: config.displayName || '杭电助手',
  };
}

/** Host 头允许列表：本机 + --public-url/--trusted-host 里的名字（仅用于面板门禁）。 */
function allowedHosts() {
  const set = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--public-url' || a === '--trusted-host') {
      const v = argv[i + 1] || '';
      try {
        const u = v.includes('://') ? new URL(v) : new URL(`http://${v}`);
        set.add(u.hostname);
      } catch { /* ignore */ }
    }
  }
  return set;
}

export function apply(ctx, config) {
  const cfg = normalizeConfig(config);
  const log = (...a) => {
    try { ctx.logger?.info?.('[hduhelp-ai]', ...a); } catch { /* ignore */ }
  };

  const tokenFile = path.join(cfg.dataDir, 'token.json');
  const selectionFile = path.join(cfg.dataDir, 'selection.json');
  const quotaFile = path.join(cfg.dataDir, 'quota.json');
  const state = {
    access_token: '',
    refresh_token: '',
    user: '',
    obtained_at: null,
    expires_at: null,
    last_error: '',
    last_error_at: '',
    quota: null,
    selected: new Set(),
  };

  function saveQuota() {
    try {
      fs.writeFileSync(quotaFile, JSON.stringify(state.quota, null, 2), { mode: 0o600 });
    } catch { /* 缓存写失败不影响使用 */ }
  }

  function clearQuota() {
    state.quota = null;
    try { fs.rmSync(quotaFile, { force: true }); } catch { /* ignore */ }
  }

  // 重启后先展示上次快照。快照只是「上次观测」，不代表当前额度：
  // 客户端按 observedAt / resetAt 标注时效，不把过期观测当成 0%。
  try {
    if (fs.existsSync(quotaFile)) {
      const q = JSON.parse(fs.readFileSync(quotaFile, 'utf8'));
      if (q && typeof q === 'object') state.quota = { ...q, source: 'plugin-requests', restored: true };
    }
  } catch { /* 忽略损坏的快照 */ }

  // 只注册用户勾选的模型；没有选择文件时默认空（面板里勾选后保存）
  try {
    if (fs.existsSync(selectionFile)) {
      const j = JSON.parse(fs.readFileSync(selectionFile, 'utf8'));
      if (Array.isArray(j?.ids)) state.selected = new Set(j.ids.map(String));
    }
  } catch (e) {
    log('selection.json 读取失败:', e.message);
  }

  function saveSelection() {
    try {
      fs.writeFileSync(selectionFile, JSON.stringify({ ids: [...state.selected] }, null, 2), { mode: 0o600 });
      fs.chmodSync(selectionFile, 0o600);
    } catch (e) {
      log('selection.json 写入失败:', e.message);
    }
  }

  // ---- token store -------------------------------------------------------

  try {
    fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
  } catch { /* ignore */ }

  try {
    if (fs.existsSync(tokenFile)) {
      const j = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
      Object.assign(state, j);
    }
  } catch (e) {
    log('token.json 读取失败:', e.message);
  }

  function saveToken() {
    const payload = {
      access_token: state.access_token,
      refresh_token: state.refresh_token,
      user: state.user,
      obtained_at: state.obtained_at,
      expires_at: state.expires_at,
    };
    try {
      fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(tokenFile, JSON.stringify(payload, null, 2), { mode: 0o600 });
      fs.chmodSync(tokenFile, 0o600);
    } catch (e) {
      log('token.json 写入失败:', e.message);
    }
  }

  // ---- 凭证状态机 ---------------------------------------------------------
  //
  // 唯一真相：state.access_token 非空 <=> 已登录。
  //   · 续期只有 refreshToken() 一个入口，单飞（并发调用共用同一次请求），
  //     避免多路 401 拿同一个 refresh_token 竞态刷新、把轮换后的新 token 冲掉。
  //   · 有 expires_at 时提前 RENEW_SKEW_MS 主动续期，不等请求失败。
  //   · 续期确定失败（上游拒绝 refresh_token）即置未登录并清掉账号态，
  //     不留着过期 token 假装已登录；网络抖动不清凭证，留给下次重试。

  let adapter = null;
  let refreshInflight = null;
  let renewTimer = null;

  function stopRenewTimer() {
    if (renewTimer) { clearTimeout(renewTimer); renewTimer = null; }
  }

  function scheduleRenew() {
    stopRenewTimer();
    if (!state.access_token || !state.expires_at) return;
    const delay = Math.max(5000, Number(state.expires_at) - Date.now() - RENEW_SKEW_MS);
    renewTimer = setTimeout(() => {
      renewTimer = null;
      void refreshToken().then((t) => {
        if (!t && state.refresh_token) scheduleRenew();
      });
    }, delay);
    if (typeof renewTimer.unref === 'function') renewTimer.unref();
  }

  /** 凭证失效：清 token 与该账号的观测数据，面板回到未登录态。 */
  function markLoggedOut(reason) {
    state.access_token = '';
    state.refresh_token = '';
    state.obtained_at = null;
    state.expires_at = null;
    state.last_error = reason || '';
    state.last_error_at = reason ? new Date().toISOString() : '';
    saveToken();
    stopRenewTimer();
    clearQuota();
    if (adapter) adapter.invalidateCatalog();
  }

  async function refreshToken() {
    if (refreshInflight) return refreshInflight;
    if (!state.refresh_token) {
      if (state.access_token) markLoggedOut('登录已过期，且没有 refresh_token，请重新登录');
      return '';
    }
    const usedRefreshToken = state.refresh_token;
    refreshInflight = (async () => {
      let res;
      try {
        res = await fetch(`${API_BASE}/identity/auth/token/refresh`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken: usedRefreshToken }),
          signal: AbortSignal.timeout(15000),
        });
      } catch (e) {
        // 传输层失败：凭证可能仍然有效，保留状态，等下次 401 或定时重试。
        log('续期请求失败（网络）:', e.message);
        return '';
      }
      let j = null;
      try { j = await res.json(); } catch { /* 非 JSON */ }
      const d = j?.data || j || {};
      const t = d.access_token || d.accessToken || d.token;
      if (!t) {
        // 上游明确拒绝（4xx）视为凭证失效；5xx 视为上游故障，保留凭证。
        if (res.status >= 400 && res.status < 500) {
          log('续期被上游拒绝:', res.status);
          markLoggedOut('登录已失效（refresh_token 被上游拒绝），请重新登录');
        } else {
          log('续期失败（上游故障）:', res.status);
        }
        return '';
      }
      // 期间用户可能已登出或换了账号：不要写回旧账号的 token。
      if (state.refresh_token !== usedRefreshToken) return state.access_token || '';
      state.access_token = t;
      const rotated = d.refresh_token || d.refreshToken;
      if (rotated) state.refresh_token = rotated;
      const expiresIn = Number(d.expires_in ?? d.expiresIn);
      state.obtained_at = new Date().toISOString();
      state.expires_at = Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : null;
      state.last_error = '';
      state.last_error_at = '';
      saveToken();
      scheduleRenew();
      log('token 已续期');
      return t;
    })().finally(() => { refreshInflight = null; });
    return refreshInflight;
  }

  // ---- llm adapter（把模型注册进 DSH 模型列表）---------------------------

  const attachments = (() => {
    try { return typeof ctx.get === 'function' ? ctx.get('attachments') : undefined; } catch { return undefined; }
  })();

  adapter = new HduhelpAdapter({
    providerId: cfg.providerId,
    displayName: cfg.displayName,
    apiBase: 'https://api.hduhelp.com/hduhelp-neo/ai/v1',
    purpose: cfg.purpose,
    getToken: () => state.access_token,
    refreshToken: () => refreshToken(),
    dataDir: cfg.dataDir,
    getSelected: () => state.selected,
    attachments,
    // 额度合并：只覆盖本次真的观测到的窗口，缺失的窗口保留上次观测值，
    // 不用「这次没带头」当成「额度归零」。
    onQuota: (q) => {
      const prev = state.quota || {};
      const windows = { ...(prev.windows || {}) };
      if (q.windows) {
        for (const [k, v] of Object.entries(q.windows)) {
          if (v) windows[k] = { ...v, observedAt: q.at };
        }
      }
      state.quota = {
        purpose: cfg.purpose,
        source: 'plugin-requests',
        status: q.status,
        at: q.at,
        observedAt: q.at,
        restored: false,
        ...(Object.keys(windows).length ? { windows } : {}),
        ...(q.exhausted === undefined ? {} : { exhausted: q.exhausted }),
        ...(q.retryAfter === undefined ? {} : { retryAfter: q.retryAfter }),
      };
      saveQuota();
    },
    log: (...a) => log(...a),
  });

  // 重启后按已有凭证恢复主动续期；已过期就立刻续一次。
  if (state.access_token) {
    if (state.expires_at && Number(state.expires_at) - RENEW_SKEW_MS <= Date.now()) {
      void refreshToken();
    } else {
      scheduleRenew();
    }
  }
  ctx.effect(() => () => { stopRenewTimer(); }, 'dsh-hduhelp-ai: renew timer');

  let providerRegistered = false;

  ctx.inject(['llm'], (llmCtx) => {
    try {
      llmCtx.llm.registerAdapter([cfg.providerId], adapter);
      providerRegistered = true;
      log(`已注册模型 provider "${cfg.providerId}"（${cfg.displayName}）`);
    } catch (e) {
      log('registerAdapter 失败:', e.message);
      return;
    }
    if (state.access_token) {
      void adapter.refreshModels(true).then(() => {
        log(`模型目录 ${adapter.catalog.length} 项`);
      });
    }
  });

  // ---- login -------------------------------------------------------------

  let loginInflight = null;

  function runCasLogin(user, pass) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [CAS_SCRIPT], {
        env: { ...process.env, HDU_USER: user, HDU_PASS: pass, API_BASE },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        resolve({ ok: false, error: '登录超时（60s）' });
      }, 60000);
      child.stdout.on('data', (c) => { out += c.toString(); });
      child.stderr.on('data', (c) => { err += c.toString(); });
      child.on('close', (code) => {
        clearTimeout(timer);
        const line = out.trim().split('\n').filter(Boolean).pop() || '';
        try {
          resolve(JSON.parse(line));
        } catch {
          const detail = (err || out || '').trim().split('\n').filter(Boolean).slice(-3).join(' ') || `登录进程退出码 ${code}`;
          resolve({ ok: false, error: detail.slice(0, 300) });
        }
      });
      child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    });
  }

  async function doLogin(user, pass) {
    if (!user || !pass) return { ok: false, error: '学号和密码都要填' };
    if (loginInflight) return { ok: false, error: '正在登录中，请稍候' };
    loginInflight = runCasLogin(user, pass);
    try {
      const r = await loginInflight;
      if (!r.ok) {
        state.last_error = r.error || '登录失败';
        state.last_error_at = new Date().toISOString();
        log('登录失败:', r.error);
        return r;
      }
      // 换账号：上一个账号的额度观测与模型目录不能沿用。
      const switched = state.user && state.user !== user;
      if (switched) {
        clearQuota();
        adapter.invalidateCatalog();
      }
      state.last_error = '';
      state.last_error_at = '';
      state.access_token = r.access_token;
      state.refresh_token = r.refresh_token || '';
      state.user = user;
      state.obtained_at = new Date().toISOString();
      const expiresIn = Number(r.expires_in);
      state.expires_at = Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : null;
      saveToken();
      scheduleRenew();
      void adapter.refreshModels(true).catch(() => {});
      log('登录成功:', user);
      return { ok: true, user: maskUser(user) };
    } finally {
      loginInflight = null;
    }
  }

  function maskUser(u) {
    const s = String(u || '');
    if (s.length <= 4) return s;
    return s.slice(0, 3) + '*'.repeat(Math.max(1, s.length - 5)) + s.slice(-2);
  }

  // ---- http helpers ------------------------------------------------------

  function json(res, status, body) {
    const buf = Buffer.from(JSON.stringify(body));
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': buf.length,
      'cache-control': 'no-store',
    });
    res.end(buf);
  }

  async function readJson(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { return {}; }
  }

  function gate(req) {
    const hosts = allowedHosts();
    const host = String(req.headers.host || '').split(':')[0];
    if (!hosts.has(host)) return 'forbidden-host';
    if (req.headers['x-dsh-hduhelp'] !== '1') return 'missing-header';
    return null;
  }

  function guard(handler) {
    return async (req, res) => {
      const refusal = gate(req);
      if (refusal) return json(res, 403, { ok: false, reason: refusal });
      try {
        await handler(req, res);
      } catch (e) {
        json(res, 500, { ok: false, error: e?.message || String(e) });
      }
    };
  }

  function statusPayload() {
    return {
      ok: true,
      loggedIn: Boolean(state.access_token),
      user: state.user ? maskUser(state.user) : '',
      obtainedAt: state.obtained_at,
      expiresAt: state.expires_at,
      loginInflight: Boolean(loginInflight),
      renewing: Boolean(refreshInflight),
      lastError: state.last_error || '',
      lastErrorAt: state.last_error_at || '',
      quota: state.quota,
      provider: {
        registered: providerRegistered,
        id: cfg.providerId,
        name: cfg.displayName,
        models: adapter.catalog.filter((m) => state.selected.has(m.id)).length,
        total: adapter.catalog.length,
        sample: adapter.catalog.filter((m) => state.selected.has(m.id)).slice(0, 8).map((m) => m.id),
      },
    };
  }

  // ---- routes ------------------------------------------------------------

  ctx.inject(['webServer'], (webCtx) => {
    const routes = [
      [ROUTES.status, 'GET', guard(async (req, res) => json(res, 200, statusPayload()))],
      [ROUTES.login, 'POST', guard(async (req, res) => {
        const body = await readJson(req);
        const r = await doLogin(String(body.user || '').trim(), String(body.pass || ''));
        if (!r.ok) return json(res, 401, { ok: false, error: r.error });
        json(res, 200, statusPayload());
      })],
      [ROUTES.logout, 'POST', guard(async (req, res) => {
        // 登出把账号态清干净：token、额度观测、模型目录、勾选集。
        // 上游没有公开的吊销接口，这里不猜测端点；本地凭证与该账号的缓存一律清除。
        markLoggedOut('');
        state.user = '';
        saveToken();
        state.selected = new Set();
        saveSelection();
        try { ctx.emit('llm/models-updated', cfg.providerId); } catch { /* ignore */ }
        json(res, 200, statusPayload());
      })],
      [ROUTES.refresh, 'POST', guard(async (req, res) => {
        const t = await refreshToken();
        json(res, t ? 200 : 401, t ? statusPayload() : {
          ok: false,
          error: state.last_error || '续期失败：请检查网络，或重新登录',
        });
      })],
      [ROUTES.models, 'GET', guard(async (req, res) => {
        if (!state.access_token) return json(res, 401, { ok: false, error: '未登录' });
        await adapter.refreshModels(true).catch(() => {});
        json(res, 200, {
          ok: true,
          total: adapter.catalog.length,
          selectedCount: adapter.catalog.filter((m) => state.selected.has(m.id)).length,
          // vision / functionCall 是三态：true / false / null（上游未声明）。
          // contextWindow 为 0 表示上游未声明，面板如实显示「未声明」。
          models: adapter.catalog.map((m) => ({
            id: m.id,
            name: m.name,
            contextWindow: m.contextWindow || 0,
            vision: m.vision === true ? true : m.vision === false ? false : null,
            visionConflict: m.visionConflict === true,
            functionCall: m.functionCall === true ? true : m.functionCall === false ? false : null,
            modalities: m.modalities || null,
            reasoningLevels: m.reasoningLevels || [],
            defaultReasoning: m.defaultReasoning || '',
            selected: state.selected.has(m.id),
          })),
        });
      })],
      [ROUTES.selection, 'POST', guard(async (req, res) => {
        const body = await readJson(req);
        const ids = Array.isArray(body.ids) ? body.ids.map(String) : null;
        if (!ids) return json(res, 400, { ok: false, error: 'ids 必须是数组' });
        const known = new Set(adapter.catalog.map((m) => m.id));
        const next = new Set(ids.filter((id) => known.has(id)));
        const rejected = ids.filter((id) => !known.has(id));
        state.selected = next;
        saveSelection();
        // 通知宿主/浏览器刷新模型目录（客户端监听 llm/models-updated）
        try { ctx.emit('llm/models-updated', cfg.providerId); } catch (e) { log('emit models-updated 失败:', e.message); }
        json(res, 200, { ok: true, selectedCount: next.size, total: known.size, rejected });
      })],
      [ROUTES.quota, 'GET', guard(async (req, res) => {
        json(res, 200, { ok: true, quota: state.quota, loggedIn: Boolean(state.access_token) });
      })],
    ];

    for (const [p, method, handler] of routes) {
      webCtx.effect(
        () => webCtx.webServer.register({
          kind: 'exact',
          path: p,
          handler: (req, res) => {
            if ((req.method || 'GET') !== method) {
              return json(res, 405, { ok: false, reason: 'method-not-allowed' });
            }
            return handler(req, res);
          },
        }),
        `dsh-hduhelp-ai: route ${p}`,
      );
    }

    log(`routes ready; token ${state.access_token ? 'present' : 'missing'}`);
  });
}
