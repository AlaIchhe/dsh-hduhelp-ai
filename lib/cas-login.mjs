#!/usr/bin/env node
/**
 * 杭电 CAS 登录（纯 HTTP，无浏览器）。
 *
 * 思路来自 HDU-Library-Sniper 的 crates/auth/src/sso.rs + crates/hdu/src/auth.rs：
 *   SSO 登录页把 AES-128 的 key 和 flowkey 直接写在 HTML 里
 *   (id="login-croypto" / id="login-page-flowkey")，密码用 key 做
 *   AES-128-ECB + PKCS#7 后 base64，随普通表单 POST 回去即可；
 *   页面上的图形验证码是可选的，`captcha_payload = AES(key, "{}")` 就能过。
 *
 * 流程：
 *   1. GET  {API}/identity/login/url?grant-key=cas&client_id=poplar -> CAS 地址
 *   2. GET  CAS 地址，解析 croypto / flowkey / form action
 *   3. POST /login 表单（username/type/_eventId/execution/croypto/password/captcha_payload）
 *   4. 跟随 302：api.hduhelp.com/.../identity/login/sso?state&ticket -> .../auth/callback?code=
 *   5. POST {API}/identity/login/exchange {code} -> access_token / refresh_token
 *
 * 输入（环境变量）：HDU_USER, HDU_PASS
 * 输出（stdout 一行 JSON）：{ok:true, access_token, refresh_token, expires_in}
 *                           或 {ok:false, error}
 */

import crypto from 'node:crypto';

const API = (process.env.API_BASE || 'https://api.hduhelp.com/hduhelp-neo').replace(/\/$/, '');
const CLIENT_ID = process.env.CLIENT_ID || 'poplar';
const USER = process.env.HDU_USER || '';
const PASS = process.env.HDU_PASS || '';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// ---- cookie jar ----------------------------------------------------------

const jar = new Map();

function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function absorbCookies(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const raw of list) {
    const pair = raw.split(';')[0];
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}

async function request(url, opts = {}) {
  const headers = { 'user-agent': UA, ...(opts.headers || {}) };
  if (jar.size) headers.cookie = cookieHeader();
  const res = await fetch(url, {
    ...opts,
    redirect: 'manual',
    headers,
    signal: AbortSignal.timeout(30000),
  });
  absorbCookies(res);
  return res;
}

// ---- AES-128-ECB + PKCS#7 ------------------------------------------------

export function encryptPassword(keyBase64, text) {
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== 16) throw new Error(`AES key 长度不是 16 字节: ${key.length}`);
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]).toString('base64');
}

// ---- 页面解析 ------------------------------------------------------------

function pick(html, patterns) {
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1] && m[1].trim()) return m[1].trim();
  }
  return '';
}

const RE_CROYPTO = [
  /id=["']login-croypto["'][^>]*>\s*([^<]+?)\s*</i,
  /id=["']login-croypto["'][^>]*value=["']([^"']+)["']/i,
];
const RE_FLOWKEY = [
  /id=["']login-page-flowkey["'][^>]*>\s*([^<]+?)\s*</i,
  /id=["']login-page-flowkey["'][^>]*value=["']([^"']+)["']/i,
  /name=["']execution["'][^>]*value=["']([^"']+)["']/i,
];
const RE_ACTION = [/<form[^>]+id=["']normalLoginForm["'][^>]+action=["']([^"']+)["']/i];

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
}

// ---- main ----------------------------------------------------------------

async function main() {
  if (!USER || !PASS) throw new Error('缺少 HDU_USER / HDU_PASS');

  // 1. 拿 CAS 地址（带 state，回调里会带 code）
  const r = await request(`${API}/identity/login/url?grant-key=cas&client_id=${CLIENT_ID}`, {
    headers: { accept: 'application/json' },
  });
  const j = await r.json();
  const casUrl = j?.data?.url;
  if (!casUrl) throw new Error(`获取 CAS 地址失败: ${JSON.stringify(j).slice(0, 200)}`);

  // 2. 打开登录页，抓 key / flowkey
  let page = await request(casUrl);
  let html = await page.text();
  const key = pick(html, RE_CROYPTO);
  const flowkey = pick(html, RE_FLOWKEY);
  const action = pick(html, RE_ACTION) || '/login';
  if (!key || !flowkey) {
    throw new Error(`CAS 登录页缺少参数 (croypto=${Boolean(key)}, flowkey=${Boolean(flowkey)}, status=${page.status})`);
  }

  // 3. 提交表单
  const form = new URLSearchParams({
    username: USER,
    type: 'UsernamePassword',
    _eventId: 'submit',
    execution: flowkey,
    croypto: key,
    password: encryptPassword(key, PASS),
    captcha_payload: encryptPassword(key, '{}'),
  });

  const actionUrl = new URL(action, casUrl).toString();
  let res = await request(actionUrl, {
    method: 'POST',
    body: form,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: new URL(casUrl).origin,
      referer: casUrl,
    },
  });
  let text = await res.text();
  let currentUrl = actionUrl;

  // 4. 跟 302，直到拿到 code 或不跳转了
  let code = '';
  for (let hop = 0; hop < 12; hop += 1) {
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      currentUrl = new URL(loc, currentUrl).toString();
      const m = currentUrl.match(/[?&]code=([^&]+)/);
      if (m) { code = decodeURIComponent(m[1]); break; }
      res = await request(currentUrl);
      text = await res.text();
      continue;
    }
    break;
  }
  if (!code) {
    const m = currentUrl.match(/[?&]code=([^&]+)/)
      || text.match(/[?&]code=([^&\s"'<>]+)/)
      || text.match(/"code"\s*:\s*"([A-Za-z0-9_-]{8,})"/);
    if (m) code = decodeURIComponent(m[1]);
  }

  // 没拿到 code：说明还停在 SSO（密码错/验证码/账号锁定）
  if (!code) {
    const plain = htmlToText(text);
    const known = [
      /用户名或密码错误/,
      /密码错误/,
      /验证码错误/,
      /验证码[^。！!]{0,12}不正确/,
      /账号[^。！!]{0,6}(锁定|冻结|停用)/,
      /尝试次数过多/,
      /用户不存在/,
    ];
    for (const re of known) {
      const hit = plain.match(re);
      if (hit) throw new Error(hit[0].trim());
    }
    const flowError = currentUrl.match(/[?&]flow_error=([^&]+)/);
    if (flowError) throw new Error(`登录回调失败（flow_error=${flowError[1]}），请在杭电助手 App 里登录一次激活账号`);
    throw new Error(`CAS 登录未完成（status=${res.status}，url=${currentUrl.slice(0, 100)}）`);
  }

  // 5. 换 token
  const ex = await request(`${API}/identity/login/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ code }),
  });
  const ej = await ex.json();
  const d = ej?.data || ej || {};
  const token = d.access_token || d.accessToken || d.token;
  if (!token) throw new Error(`换取 token 失败: ${JSON.stringify(ej).slice(0, 200)}`);

  emit({
    ok: true,
    access_token: token,
    refresh_token: d.refresh_token || d.refreshToken || null,
    expires_in: d.expires_in || d.expiresIn || null,
  });
}

main().catch((e) => {
  emit({ ok: false, error: e?.message || String(e) });
  process.exit(1);
});
