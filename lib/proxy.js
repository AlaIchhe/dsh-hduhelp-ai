/**
 * OpenAI 兼容反代（宿主内嵌）。
 *
 * 上游实测：文本用途（app.mate.chat / summary / title）只接受 **Responses** 协议，
 * 走 chat/completions 会被拒。所以本反代把客户端的 /v1/chat/completions
 * 翻译成 Responses 请求，再把流翻译回 chat.completion.chunk。
 * /v1/responses 原样透传。
 */

import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import { toResponsesInput, readResponsesStream, readResponsesJson } from './responses.js';

export function createProxyServer({
  port = 8787,
  host = '0.0.0.0',
  upstreamBase = 'https://api.hduhelp.com/hduhelp-neo/ai/v1',
  purpose = 'app.mate.chat',
  apiKey = 'sk-hduhelp',
  defaultModel = '',
  allowPassthrough = true,
  deviceId = 'dsh-hduhelp-ai',
  deviceName = 'DSH',
  getToken,
  onUnauthorized,
  onQuota,
  log = () => {},
} = {}) {
  const state = { modelsCache: null, modelsCacheAt: 0 };

  const base = upstreamBase.replace(/\/$/, '');

  const tokenOf = (req) => {
    const raw = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (allowPassthrough && raw && raw !== apiKey && raw.length > 20) return raw;
    return getToken() || '';
  };

  const upstream = (pu, sub) => `${base}/purposes/${encodeURIComponent(pu)}/openai/v1/${sub}`;

  const headersFor = (token, accept = 'application/json') => ({
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    accept,
    'x-device-id': deviceId,
    'x-device-name': deviceName,
    'x-hduhelp-source': 'app',
    'x-hduhelp-model-request-id': randomUUID(),
    'accept-encoding': 'identity',
  });

  const oaError = (status, message, type = 'invalid_request_error', code = null) => ({
    error: { message, type, param: null, code, status },
  });

  function json(res, status, body) {
    const buf = Buffer.from(JSON.stringify(body));
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': buf.length,
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    });
    res.end(buf);
  }

  function sseHead(res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    });
  }

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > 64 * 1024 * 1024) return reject(new Error('body too large'));
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });

  function reportQuota(res) {
    if (typeof onQuota !== 'function' || !res) return;
    try {
      const h = res.headers;
      const util5 = h.get('x-hduhelp-quota-5h-utilization');
      const util7 = h.get('x-hduhelp-quota-7d-utilization');
      const retryAfter = h.get('retry-after');
      if (util5 === null && util7 === null && retryAfter === null) return;
      onQuota({
        provider: 'hduhelp',
        status: res.status,
        exhausted: res.status === 429,
        retryAfter: retryAfter ? Number(retryAfter) : null,
        windows: {
          '5h': util5 !== null ? { utilization: Number(util5), resetAt: Number(h.get('x-hduhelp-quota-5h-reset')) || null } : null,
          '7d': util7 !== null ? { utilization: Number(util7), resetAt: Number(h.get('x-hduhelp-quota-7d-reset')) || null } : null,
        },
      });
    } catch { /* ignore */ }
  }

  async function fetchUpstream(url, token, body, accept, signal) {
    const res = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: headersFor(token, accept),
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
    reportQuota(res);
    return res;
  }

  // ---- 请求翻译 ----------------------------------------------------------

  function toResponsesBody(openai) {
    const { instructions, input } = toResponsesInput(openai.messages || [], { system: openai.system });
    const body = { model: openai.model, input, stream: openai.stream === true };
    if (instructions) body.instructions = instructions;
    if (typeof openai.temperature === 'number') body.temperature = openai.temperature;
    const maxTokens = openai.max_completion_tokens ?? openai.max_tokens;
    if (typeof maxTokens === 'number' && maxTokens > 0) body.max_output_tokens = maxTokens;
    if (Array.isArray(openai.tools) && openai.tools.length) {
      body.tools = openai.tools
        .filter((t) => t && (t.type === 'function' || t.function))
        .map((t) => {
          const fn = t.function || t;
          return {
            type: 'function',
            name: fn.name,
            description: fn.description || '',
            parameters: fn.parameters || { type: 'object', properties: {} },
          };
        });
      body.tool_choice = 'auto';
    }
    return body;
  }

  function chunkBase(id, model) {
    return {
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [],
    };
  }

  async function streamChat(res, upstreamRes, model) {
    sseHead(res);
    const id = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    let index = -1;
    let toolIndex = -1;
    let toolId = '';
    let sawTool = false;
    let usage = null;

    const write = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    write({ ...chunkBase(id, model), choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });

    for await (const evt of readResponsesStream(upstreamRes.body)) {
      if (evt.type === 'reasoning') {
        write({ ...chunkBase(id, model), choices: [{ index: 0, delta: { reasoning_content: evt.text }, finish_reason: null }] });
      } else if (evt.type === 'text') {
        write({ ...chunkBase(id, model), choices: [{ index: 0, delta: { content: evt.text }, finish_reason: null }] });
      } else if (evt.type === 'tool-start') {
        sawTool = true;
        index += 1;
        toolIndex = index;
        toolId = evt.id;
        write({
          ...chunkBase(id, model),
          choices: [{ index: 0, delta: { tool_calls: [{ index: toolIndex, id: toolId, type: 'function', function: { name: evt.name, arguments: '' } }] }, finish_reason: null }],
        });
      } else if (evt.type === 'tool-args') {
        write({
          ...chunkBase(id, model),
          choices: [{ index: 0, delta: { tool_calls: [{ index: toolIndex, function: { arguments: evt.delta } }] }, finish_reason: null }],
        });
      } else if (evt.type === 'usage') {
        usage = { prompt_tokens: evt.inputTokens, completion_tokens: evt.outputTokens, total_tokens: evt.inputTokens + evt.outputTokens };
      }
    }

    write({
      ...chunkBase(id, model),
      choices: [{ index: 0, delta: {}, finish_reason: sawTool ? 'tool_calls' : 'stop' }],
      ...(usage ? { usage } : {}),
    });
    res.write('data: [DONE]\n\n');
    res.end();
  }

  async function chatCompletion(res, upstreamRes, model) {
    const raw = await upstreamRes.text();
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return json(res, 502, oaError(502, '上游返回了非 JSON', 'api_error'));
    }
    if (upstreamRes.status !== 200) {
      return json(res, upstreamRes.status, payload?.error ? payload : oaError(upstreamRes.status, payload?.message || raw.slice(0, 300), 'api_error'));
    }
    const out = readResponsesJson(payload);
    const message = { role: 'assistant', content: out.text || null };
    if (out.reasoning) message.reasoning_content = out.reasoning;
    if (out.toolCalls.length) {
      message.tool_calls = out.toolCalls.map((c, i) => ({
        index: i,
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.arguments },
      }));
    }
    json(res, 200, {
      id: `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: out.toolCalls.length ? 'tool_calls' : 'stop',
        },
      ],
      usage: {
        prompt_tokens: out.usage.inputTokens,
        completion_tokens: out.usage.outputTokens,
        total_tokens: out.usage.inputTokens + out.usage.outputTokens,
      },
    });
  }

  // ---- server ------------------------------------------------------------

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url, 'http://localhost');
    res.on('finish', () => log(`${req.method} ${url.pathname} -> ${res.statusCode} ${Date.now() - started}ms`));

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
      });
      return res.end();
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      return json(res, 200, {
        ok: true,
        name: 'dsh-hduhelp-ai',
        upstream: base,
        purpose,
        token: getToken() ? 'present' : 'missing',
      });
    }

    const pu = purpose;
    const token = tokenOf(req);
    if (!token) {
      return json(res, 401, oaError(401, 'hduhelp 未登录：请先在 DSH 设置面板里登录', 'authentication_error', 'not_logged_in'));
    }

    if (url.pathname === '/v1/models' && req.method === 'GET') {
      if (state.modelsCache && Date.now() - state.modelsCacheAt < 60000) return json(res, 200, state.modelsCache);
      try {
        const up = await fetchUpstream(upstream(pu, 'models'), token, null, 'application/json', AbortSignal.timeout(30000));
        const buf = await up.text();
        if (up.status === 200) {
          try {
            const j = JSON.parse(buf);
            const out = Array.isArray(j?.data) ? j : { object: 'list', data: j?.data || [] };
            state.modelsCache = out;
            state.modelsCacheAt = Date.now();
            return json(res, 200, out);
          } catch { /* fallthrough */ }
        }
        res.writeHead(up.status, { 'content-type': up.headers.get('content-type') || 'application/json' });
        return res.end(buf);
      } catch (e) {
        return json(res, 502, oaError(502, `上游不可用: ${e.message}`, 'api_error'));
      }
    }

    let body;
    try {
      body = await readBody(req);
    } catch {
      return json(res, 413, oaError(413, 'body too large'));
    }

    let parsed = null;
    try { parsed = body.length ? JSON.parse(body.toString('utf8')) : null; } catch { parsed = null; }

    // 原生 Responses 透传
    if (url.pathname === '/v1/responses') {
      const payload = parsed || {};
      if (defaultModel && !payload.model) payload.model = defaultModel;
      try {
        const up = await fetchUpstream(upstream(pu, 'responses'), token, payload, payload.stream ? 'text/event-stream' : 'application/json');
        if (up.status !== 200) {
          const text = await up.text();
          res.writeHead(up.status, { 'content-type': 'application/json; charset=utf-8' });
          return res.end(text);
        }
        if (payload.stream) {
          sseHead(res);
          for await (const chunk of up.body) res.write(chunk);
          return res.end();
        }
        const text = await up.text();
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
        return res.end(text);
      } catch (e) {
        return json(res, 502, oaError(502, `上游不可用: ${e.message}`, 'api_error'));
      }
    }

    if (url.pathname === '/v1/chat/completions' || url.pathname === '/v1/completions') {
      if (!parsed || typeof parsed !== 'object') return json(res, 400, oaError(400, '请求体不是合法 JSON'));
      if (defaultModel && !parsed.model) parsed.model = defaultModel;
      if (!parsed.model) return json(res, 400, oaError(400, '缺少 model'));
      const model = parsed.model;
      const wantStream = parsed.stream === true;
      const payload = toResponsesBody(parsed);

      try {
        let up = await fetchUpstream(upstream(pu, 'responses'), token, payload, wantStream ? 'text/event-stream' : 'application/json');
        if (up.status === 401 && onUnauthorized) {
          const fresh = await onUnauthorized();
          if (fresh) up = await fetchUpstream(upstream(pu, 'responses'), fresh, payload, wantStream ? 'text/event-stream' : 'application/json');
        }
        if (up.status !== 200) {
          const text = await up.text();
          let msg = text.slice(0, 400);
          try { msg = JSON.parse(text)?.error?.message || msg; } catch { /* keep */ }
          return json(res, up.status, oaError(up.status, msg, up.status === 401 ? 'authentication_error' : 'api_error'));
        }
        if (wantStream) return streamChat(res, up, model);
        return chatCompletion(res, up, model);
      } catch (e) {
        return json(res, 502, oaError(502, `上游不可用: ${e.message}`, 'api_error'));
      }
    }

    // 其它（embeddings / images / rerank）按原路径透传
    const passthrough = url.pathname.replace(/^\/v1\//, '');
    if (['embeddings', 'images/generations', 'images/edits', 'rerank'].includes(passthrough)) {
      try {
        const up = await fetchUpstream(upstream(pu, passthrough), token, parsed, '*/*');
        const buf = Buffer.from(await up.arrayBuffer());
        res.writeHead(up.status, {
          'content-type': up.headers.get('content-type') || 'application/json',
          'access-control-allow-origin': '*',
        });
        return res.end(buf);
      } catch (e) {
        return json(res, 502, oaError(502, `上游不可用: ${e.message}`, 'api_error'));
      }
    }

    return json(res, 404, oaError(404, `unknown endpoint ${url.pathname}`));
  });

  return {
    port,
    host,
    server,
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
    },
    stop() {
      return new Promise((resolve) => {
        try { server.close(() => resolve()); } catch { resolve(); }
      });
    },
    get listening() { return server.listening; },
    invalidateModels() { state.modelsCache = null; },
  };
}
