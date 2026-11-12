/**
 * dsh-hduhelp-ai — host half.
 *
 * 宿主侧做三件事：
 *   1. 管 token（~/.dsh/hduhelp-ai/token.json，0600），刷新；
 *   2. 在 webServer 上挂 /__hduhelp/* 路由给设置面板用（登录/登出/状态/模型/开关反代）；
 *   3. 起一个 OpenAI 兼容反代（默认 8787），把请求转到
 *      https://api.hduhelp.com/hduhelp-neo/ai/v1/purposes/{purpose}/openai/v1/...
 *
 * 登录走杭电 CAS：起子进程 lib/cas-login.mjs（Playwright），宿主只拿结果。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProxyServer } from './proxy.js';
import { HduhelpAdapter } from './adapter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAS_SCRIPT = path.join(__dirname, 'cas-login.mjs');
const API_BASE = 'https://api.hduhelp.com/hduhelp-neo';

const ROUTES = {
  status: '/__hduhelp/status',
  login: '/__hduhelp/login',
  logout: '/__hduhelp/logout',
  refresh: '/__hduhelp/refresh',
  models: '/__hduhelp/models',
  selection: '/__hduhelp/models/selection',
  proxy: '/__hduhelp/proxy',
  quota: '/__hduhelp/quota',
};

function normalizeConfig(config = {}) {
  const dataDir = config.dataDir || path.join(os.homedir(), '.dsh', 'hduhelp-ai');
  return {
    port: Number(config.port ?? 8787),
    host: config.host || '0.0.0.0',
    purpose: config.purpose || 'app.mate.chat',
    apiKey: config.apiKey || 'sk-hduhelp',
    defaultModel: config.defaultModel || '',
    allowPassthrough: config.allowPassthrough !== false,
    dataDir,
    providerId: config.providerId || 'hduhelp',
    displayName: config.displayName || '杭电助手',
    contextWindow: Number(config.contextWindow || 128000),
  };
}

/** Host 头允许列表：本机 + --public-url/--trusted-host 里的名字。 */
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

  async function refreshToken() {
    if (!state.refresh_token) return '';
    try {
      const r = await fetch(`${API_BASE}/identity/auth/token/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: state.refresh_token }),
        signal: AbortSignal.timeout(15000),
      });
      const j = await r.json();
      const d = j?.data || j || {};
      const t = d.access_token || d.accessToken || d.token;
      if (!t) return '';
      state.access_token = t;
      if (d.refresh_token || d.refreshToken) state.refresh_token = d.refresh_token || d.refreshToken;
      saveToken();
      log('token 已刷新');
      return t;
    } catch {
      return '';
    }
  }

  // ---- proxy -------------------------------------------------------------

  const proxy = createProxyServer({
    port: cfg.port,
    host: cfg.host,
    purpose: cfg.purpose,
    apiKey: cfg.apiKey,
    defaultModel: cfg.defaultModel,
    allowPassthrough: cfg.allowPassthrough,
    deviceId: 'dsh-hduhelp-ai',
    deviceName: 'DSH',
    getToken: () => state.access_token,
    onUnauthorized: () => refreshToken(),
    onQuota: (q) => {
      state.quota = { ...q, at: Date.now(), purpose: cfg.purpose };
    },
    log: (...a) => log(...a),
  });

  // ---- llm adapter（把模型注册进 DSH 模型列表）---------------------------

  const attachments = (() => {
    try { return typeof ctx.get === 'function' ? ctx.get('attachments') : undefined; } catch { return undefined; }
  })();

  const adapter = new HduhelpAdapter({
    providerId: cfg.providerId,
    displayName: cfg.displayName,
    apiBase: 'https://api.hduhelp.com/hduhelp-neo/ai/v1',
    purpose: cfg.purpose,
    getToken: () => state.access_token,
    refreshToken: () => refreshToken(),
    dataDir: cfg.dataDir,
    contextWindow: cfg.contextWindow,
    getSelected: () => state.selected,
    attachments,
    onQuota: (q) => {
      state.quota = { ...q, at: Date.now(), purpose: cfg.purpose };
    },
    log: (...a) => log(...a),
  });

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

  let proxyStarting = null;
  async function ensureProxy() {
    if (proxy.listening) return true;
    if (proxyStarting) return proxyStarting;
    proxyStarting = proxy.start()
      .then(() => { log(`proxy listening on :${cfg.port}`); return true; })
      .catch((e) => { log('proxy 启动失败:', e.message); return false; })
      .finally(() => { proxyStarting = null; });
    return proxyStarting;
  }

  if (cfg.port) ensureProxy();

  ctx.effect(() => () => { proxy.stop(); }, 'dsh-hduhelp-ai: proxy');

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
      state.last_error = '';
      state.last_error_at = '';
      state.access_token = r.access_token;
      state.refresh_token = r.refresh_token || '';
      state.user = user;
      state.obtained_at = new Date().toISOString();
      state.expires_at = r.expires_in ? Date.now() + Number(r.expires_in) * 1000 : null;
      saveToken();
      proxy.invalidateModels();
      await ensureProxy();
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
      proxy: {
        running: proxy.listening,
        port: cfg.port,
        baseUrl: `http://${guessLanHost()}:${cfg.port}/v1`,
        apiKey: cfg.apiKey,
      },
      loginInflight: Boolean(loginInflight),
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

  function guessLanHost() {
    const hosts = allowedHosts();
    for (const h of hosts) if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(h)) return h;
    return '127.0.0.1';
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
        state.access_token = '';
        state.refresh_token = '';
        state.user = '';
        state.obtained_at = null;
        state.expires_at = null;
        state.last_error = '';
        state.last_error_at = '';
        saveToken();
        proxy.invalidateModels();
        json(res, 200, statusPayload());
      })],
      [ROUTES.refresh, 'POST', guard(async (req, res) => {
        const t = await refreshToken();
        json(res, t ? 200 : 401, t ? statusPayload() : { ok: false, error: '没有 refresh_token 或已失效，请重新登录' });
      })],
      [ROUTES.models, 'GET', guard(async (req, res) => {
        if (!state.access_token) return json(res, 401, { ok: false, error: '未登录' });
        await adapter.refreshModels(true).catch(() => {});
        json(res, 200, {
          ok: true,
          total: adapter.catalog.length,
          selectedCount: adapter.catalog.filter((m) => state.selected.has(m.id)).length,
          models: adapter.catalog.map((m) => ({
            id: m.id,
            name: m.name,
            contextWindow: m.contextWindow,
            vision: m.vision === true,
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
        state.selected = next;
        saveSelection();
        // 通知宿主/浏览器刷新模型目录（客户端监听 llm/models-updated）
        try { ctx.emit('llm/models-updated', cfg.providerId); } catch (e) { log('emit models-updated 失败:', e.message); }
        json(res, 200, { ok: true, selectedCount: next.size, total: known.size });
      })],
      [ROUTES.quota, 'GET', guard(async (req, res) => {
        json(res, 200, { ok: true, quota: state.quota, loggedIn: Boolean(state.access_token) });
      })],
      [ROUTES.proxy, 'POST', guard(async (req, res) => {
        const body = await readJson(req);
        if (body.enabled === false) {
          await proxy.stop();
          return json(res, 200, statusPayload());
        }
        const ok = await ensureProxy();
        json(res, ok ? 200 : 500, { ...statusPayload(), error: ok ? undefined : '反代启动失败' });
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

    log(`routes ready; proxy port ${cfg.port}; token ${state.access_token ? 'present' : 'missing'}`);
  });
}
