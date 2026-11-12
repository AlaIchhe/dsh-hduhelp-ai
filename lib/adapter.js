/**
 * DSH LLM adapter：把杭电助手的 AI 网关注册成 DSH 的 provider（模型选择器里的「杭电助手」）。
 *
 * 契约（@deepseek-ai/dsh-llm 的 LlmAdapter）：
 *   providerInfo / providerRetryPolicy / imageRequestPricing
 *   listModels / resolveModel / prepareCall / stream
 *
 * 上游实测：文本用途的入口协议是 **Responses**（/openai/v1/responses），
 * 见 lib/responses.js。模型目录走 /openai/v1/models，自带 context_length。
 */

import fs from 'node:fs';
import path from 'node:path';
import { toResponsesInput, postResponses, readResponsesStream } from './responses.js';

const DEFAULT_CONTEXT = 128000;
const DEFAULT_MAX_TOKENS = 32000;
const CATALOG_TTL = 5 * 60 * 1000;

const VISION_HINTS = /(gpt-4o|gpt-4\.1|gpt-5|o3|o4|claude|gemini|qwen-?vl|qwen2\.5-vl|qwen3-vl|glm-4v|glm-4\.5v|doubao.*vision|step-1v|step-1o|kimi.*vision|minimax.*vl|grok.*vision|vision)/i;

const TRANSIENT = /(stream ended without a terminal event|no_available_connectors|模型服务暂时不可用|稍后再试|temporarily|timeout|ETIMEDOUT|ECONNRESET|socket hang up|overloaded|rate limit|429)/i;

function llmFailure(message, code, extra = {}) {
  const err = new Error(message);
  Object.defineProperty(err, 'failure', {
    value: Object.freeze({ message, code, ...extra }),
    enumerable: true,
    writable: false,
  });
  return err;
}

function classifyFailure(error, status) {
  const message = error instanceof Error ? error.message : String(error);
  if (error?.name === 'AbortError') return llmFailure(message || 'aborted', 'ABORTED');
  if (status === 401 || status === 403) return llmFailure(message, 'INVALID_CREDENTIAL', { status });
  if (status === 429) return llmFailure(message, 'RATE_LIMIT', { status });
  if (status && status >= 500) return llmFailure(message, 'SERVER', { status });
  if (TRANSIENT.test(message)) return llmFailure(message, 'SERVER', { status: status || 502 });
  return llmFailure(message, 'UNKNOWN', status ? { status } : {});
}

function pickFinish(status, incomplete, sawToolCall) {
  if (sawToolCall) return { kind: 'tool-calls' };
  if (status === 'incomplete') {
    if (incomplete === 'max_output_tokens' || incomplete === 'max_tokens') return { kind: 'max-tokens' };
    if (incomplete === 'content_filter') return { kind: 'error', failure: { message: '内容被上游过滤', code: 'CONTENT_FILTERED' } };
  }
  return { kind: 'stop' };
}

export class HduhelpAdapter {
  constructor(opts) {
    this.providerId = opts.providerId || 'hduhelp';
    this.displayName = opts.displayName || '杭电助手';
    this.apiBase = (opts.apiBase || 'https://api.hduhelp.com/hduhelp-neo/ai/v1').replace(/\/+$/, '');
    this.purpose = opts.purpose || 'app.mate.chat';
    this.getToken = opts.getToken;
    this.refreshToken = opts.refreshToken;
    this.dataDir = opts.dataDir;
    this.defaultContext = Number(opts.contextWindow || DEFAULT_CONTEXT);
    this.attachments = opts.attachments;
    this.onQuota = opts.onQuota;
    this.getSelected = opts.getSelected;
    this.log = opts.log || (() => {});
    this.catalogFile = path.join(this.dataDir, 'models.json');
    this.catalog = [];
    this.catalogAt = 0;
    this.refreshing = null;
    try {
      const saved = JSON.parse(fs.readFileSync(this.catalogFile, 'utf8'));
      if (Array.isArray(saved?.models)) {
        this.catalog = saved.models;
      }
    } catch { /* 首次运行没有缓存 */ }
  }

  // ---- 契约 --------------------------------------------------------------

  providerInfo(provider) {
    return { id: provider, name: this.displayName };
  }

  providerRetryPolicy() {
    return {
      mode: 'normal',
      maxRetries: 3,
      retryableCodes: ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE'],
    };
  }

  imageRequestPricing() {
    return undefined;
  }

  async listModels(provider) {
    if (this.getToken()) await this.refreshModels().catch(() => {});
    var selected = typeof this.getSelected === 'function' ? this.getSelected() : null;
    var pool = selected && selected.size ? this.catalog.filter((m) => selected.has(m.id)) : [];
    return pool.map((m) => ({
      provider,
      id: m.id,
      name: m.name || m.id,
      inputModalities: m.vision ? ['text', 'image'] : ['text'],
    }));
  }

  async resolveModel(provider, model) {
    const entry = this.catalog.find((m) => m.id === model);
    const contextWindow = Number(entry?.contextWindow) || this.defaultContext;
    return {
      provider,
      id: model,
      name: entry?.name || model,
      inputModalities: entry?.vision ? ['text', 'image'] : ['text'],
      context: { contextWindow },
      defaultMaxTokens: Math.min(DEFAULT_MAX_TOKENS, contextWindow),
    };
  }

  async prepareCall(provider, model) {
    const info = await this.resolveModel(provider, model);
    return {
      model: info,
      stream: (options) => this.stream({ ...options, model, provider }),
    };
  }

  // ---- 模型目录 ----------------------------------------------------------

  async refreshModels(force = false) {
    const purpose = this.purpose;
    const fresh = Date.now() - this.catalogAt < CATALOG_TTL && this.catalog.length > 0;
    if (fresh && !force) return;
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const token = this.getToken();
      if (!token) return;
      try {
        const res = await fetch(`${this.apiBase}/purposes/${encodeURIComponent(purpose)}/openai/v1/models`, {
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/json',
            'x-device-id': 'dsh-hduhelp-ai',
            'x-device-name': 'DSH',
            'x-hduhelp-source': 'app',
          },
          signal: AbortSignal.timeout(20000),
        });
        if (res.status === 401 && this.refreshToken) {
          const t = await this.refreshToken();
          if (t) {
            this.refreshing = null;
            return this.refreshModels(true);
          }
        }
        if (!res.ok) return;
        const json = await res.json();
        const list = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : Array.isArray(json) ? json : [];
        const models = list
          .map((m) => (typeof m === 'string' ? { id: m } : m || {}))
          .map((m) => ({
            id: String(m.id || m.model || '').trim(),
            name: String(m.name || m.id || '').trim(),
            contextWindow: Number(m.context_window || m.context_length || m.contextWindow || 0) || 0,
            vision: VISION_HINTS.test(String(m.id || '')),
          }))
          .filter((m) => m.id);
        if (!models.length) return;
        this.catalog = models;
        this.catalogAt = Date.now();
        try {
          fs.writeFileSync(this.catalogFile, JSON.stringify({ purpose, at: this.catalogAt, models }, null, 2), { mode: 0o600 });
        } catch { /* 缓存写失败不影响使用 */ }
        this.log(`模型目录 ${models.length} 项`);
      } catch (e) {
        this.log('拉取模型目录失败:', e.message);
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  // ---- 流式请求 ----------------------------------------------------------

  async *stream(options) {
    let attempts = 0;
    let emitted = false;
    for (;;) {
      try {
        for await (const chunk of this.#streamOnce(options)) {
          emitted = true;
          yield chunk;
        }
        return;
      } catch (error) {
        const failure = classifyFailure(error, error?.status);
        const retryable = failure.failure.code === 'SERVER' || failure.failure.code === 'RATE_LIMIT';
        if (!emitted && retryable && attempts < 2) {
          attempts += 1;
          this.log(`上游瞬时失败，重试 ${attempts}/2：`, failure.message);
          await new Promise((r) => setTimeout(r, 800 * attempts));
          continue;
        }
        throw failure;
      }
    }
  }

  /** 从响应头里读额度窗口（x-hduhelp-quota-5h/7d-*）。 */
  #reportQuota(res, provider) {
    if (typeof this.onQuota !== 'function') return;
    try {
      const h = res.headers;
      const util5 = h.get('x-hduhelp-quota-5h-utilization');
      const reset5 = h.get('x-hduhelp-quota-5h-reset');
      const util7 = h.get('x-hduhelp-quota-7d-utilization');
      const reset7 = h.get('x-hduhelp-quota-7d-reset');
      const retryAfter = h.get('retry-after');
      if (util5 === null && util7 === null && retryAfter === null) return;
      this.onQuota({
        provider,
        status: res.status,
        exhausted: res.status === 429,
        retryAfter: retryAfter ? Number(retryAfter) : null,
        windows: {
          '5h': util5 !== null ? { utilization: Number(util5), resetAt: reset5 ? Number(reset5) : null } : null,
          '7d': util7 !== null ? { utilization: Number(util7), resetAt: reset7 ? Number(reset7) : null } : null,
        },
      });
    } catch { /* 头部不规范就忽略 */ }
  }

  /** 把 DSH 的图片附件读成 data URL，供 vision 模型使用。 */
  async #readImages(messages, signal) {
    const attachments = this.attachments;
    if (!attachments || typeof attachments.readImageRequest !== 'function') return undefined;
    const refs = new Map();
    for (const m of messages || []) {
      if (!m || !Array.isArray(m.content)) continue;
      for (const b of m.content) {
        if (!b || b.type !== 'image' || !b.attachment?.attachmentId) continue;
        refs.set(b.attachment.attachmentId, b.attachment);
      }
    }
    if (!refs.size) return undefined;
    const out = new Map();
    await Promise.all([...refs.entries()].map(async ([id, ref]) => {
      try {
        const read = await attachments.readImageRequest(ref, undefined, signal);
        if (!read || read.bytes <= 0 || !read.data?.length) return;
        const mediaType = read.mediaType || ref.mediaType || 'image/png';
        const base64 = Buffer.from(read.data.buffer, read.data.byteOffset, read.data.byteLength).toString('base64');
        out.set(id, `data:${mediaType};base64,${base64}`);
      } catch (e) {
        this.log('读取图片失败:', e.message);
      }
    }));
    return out.size ? out : undefined;
  }

  async *#streamOnce(options) {
    const purpose = this.purpose;
    const token = this.getToken();
    if (!token) throw new Error('杭电助手还没有登录：请到 设置 → 杭电助手 AI 用学号密码登录');

    const entry = this.catalog.find((m) => m.id === options.model);
    const vision = entry?.vision === true;
    const images = vision ? await this.#readImages(options.messages, options.signal) : undefined;
    const hasTools = Array.isArray(options.tools) && options.tools.length > 0;

    const buildBody = (structuredTools) => {
      const { instructions, input } = toResponsesInput(options.messages, {
        system: options.system,
        vision,
        images,
        structuredTools,
        toolProtocol: hasTools,
      });
      const body = { model: options.model, input, stream: true };
      if (instructions) body.instructions = instructions;
      if (typeof options.temperature === 'number') body.temperature = options.temperature;
      if (typeof options.maxTokens === 'number' && options.maxTokens > 0) body.max_output_tokens = options.maxTokens;
      if (hasTools) {
        body.tools = options.tools.map((t) => ({
          type: 'function',
          name: t.name,
          description: t.description || '',
          parameters: t.parameters || { type: 'object', properties: {} },
        }));
        body.tool_choice = 'auto';
      }
      return body;
    };

    let structuredTools = true;
    let body = buildBody(true);
    const send = (tk) => postResponses({ purpose, token: tk, body, signal: options.signal });
    let res = await send(token);
    this.#reportQuota(res, 'hduhelp');
    if (res.status === 401 && this.refreshToken) {
      const fresh = await this.refreshToken();
      if (fresh) { res = await send(fresh); this.#reportQuota(res, 'hduhelp'); }
    }
    if (res.status === 400 && structuredTools && hasTools) {
      // 结构化工具被拒是协议问题，不代表额度异常
      // 结构化工具 item 被拒（例如历史里的 call_id 太旧、上游不再认），
      // 退回文本工具协议再试一次。
      const raw400 = await res.text().catch(() => '');
      this.log('结构化工具 item 被拒，退回文本协议:', raw400.slice(0, 120));
      structuredTools = false;
      body = buildBody(false);
      res = await send(token);
      this.#reportQuota(res, 'hduhelp');
    }
    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      let msg = raw.trim().slice(0, 500);
      try {
        const j = JSON.parse(raw);
        msg = j?.error?.message || j?.message || msg;
      } catch { /* 保留原文 */ }
      const err = new Error(`杭电助手上游 ${res.status}: ${msg || '无响应内容'}`);
      err.status = res.status;
      throw err;
    }
    if (!res.body) throw new Error('杭电助手上游没有返回 body');

    // ---- 归一化事件 -> DSH StreamChunk ----
    let nextIndex = 0;
    let textIndex = -1;
    let reasoningIndex = -1;
    let textOpen = false;
    let reasoningOpen = false;
    const textAcc = new Map();
    const reasoningAcc = new Map();
    const toolIndex = new Map();
    const toolName = new Map();
    const toolArgs = new Map();
    const toolClosed = new Set();
    let sawToolCall = false;

    for await (const evt of readResponsesStream(res.body)) {
      if (evt.type === 'reasoning') {
        if (!reasoningOpen) {
          reasoningIndex = nextIndex++;
          reasoningOpen = true;
          yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' };
        }
        reasoningAcc.set(reasoningIndex, (reasoningAcc.get(reasoningIndex) || '') + evt.text);
        yield { type: 'reasoning-delta', index: reasoningIndex, text: evt.text };
        continue;
      }
      if (evt.type === 'text') {
        if (reasoningOpen) {
          reasoningOpen = false;
          yield { type: 'block-end', index: reasoningIndex, block: { type: 'reasoning', text: reasoningAcc.get(reasoningIndex) || '' } };
        }
        if (!textOpen) {
          textIndex = nextIndex++;
          textOpen = true;
          yield { type: 'block-start', index: textIndex, blockType: 'text' };
        }
        textAcc.set(textIndex, (textAcc.get(textIndex) || '') + evt.text);
        yield { type: 'text-delta', index: textIndex, text: evt.text };
        continue;
      }
      if (evt.type === 'tool-start') {
        sawToolCall = true;
        const index = nextIndex++;
        toolIndex.set(evt.id, index);
        toolName.set(evt.id, evt.name);
        toolArgs.set(evt.id, '');
        yield { type: 'block-start', index, blockType: 'tool-call' };
        continue;
      }
      if (evt.type === 'tool-args') {
        const index = toolIndex.get(evt.id);
        if (index === undefined) continue;
        toolArgs.set(evt.id, (toolArgs.get(evt.id) || '') + evt.delta);
        yield { type: 'tool-call-delta', index, id: evt.id, argumentsDelta: evt.delta };
        continue;
      }
      if (evt.type === 'tool-end') {
        const index = toolIndex.get(evt.id);
        if (index === undefined || toolClosed.has(evt.id)) continue;
        toolClosed.add(evt.id);
        const args = evt.args || toolArgs.get(evt.id) || '{}';
        yield { type: 'block-end', index, block: { type: 'tool-call', id: evt.id, name: toolName.get(evt.id) || '', arguments: args } };
        continue;
      }
      if (evt.type === 'usage') {
        yield { type: 'usage', usage: { inputTokens: evt.inputTokens || 0, outputTokens: evt.outputTokens || 0 } };
        continue;
      }
      if (evt.type === 'finish') {
        if (reasoningOpen) {
          yield { type: 'block-end', index: reasoningIndex, block: { type: 'reasoning', text: reasoningAcc.get(reasoningIndex) || '' } };
        }
        if (textOpen) {
          yield { type: 'block-end', index: textIndex, block: { type: 'text', text: textAcc.get(textIndex) || '' } };
        }
        yield { type: 'finish', reason: pickFinish(evt.status, evt.incompleteReason, sawToolCall) };
        return;
      }
    }

    // 流提前结束的兜底
    if (reasoningOpen) {
      yield { type: 'block-end', index: reasoningIndex, block: { type: 'reasoning', text: reasoningAcc.get(reasoningIndex) || '' } };
    }
    if (textOpen) {
      yield { type: 'block-end', index: textIndex, block: { type: 'text', text: textAcc.get(textIndex) || '' } };
    }
    yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } };
    yield { type: 'finish', reason: pickFinish('completed', '', sawToolCall) };
  }
}
