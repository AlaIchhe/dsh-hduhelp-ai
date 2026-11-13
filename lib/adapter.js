/**
 * DSH LLM adapter：把杭电助手的 AI 网关注册成 DSH 的 provider（模型选择器里的「杭电助手」）。
 *
 * 契约（@deepseek-ai/dsh-llm 的 LlmAdapter）：
 *   providerInfo / providerRetryPolicy / imageRequestPricing
 *   listModels / resolveModel / prepareCall / stream
 *
 * 两条硬规则：
 *   1. 模型能力**只认上游目录的显式声明**（input_modalities / capabilities.image_input /
 *      capabilities.function_call / context_window / supported_reasoning_levels）。
 *      不按模型名猜，缺失即「未知」，两处声明冲突时取严并记录冲突。
 *   2. 不做任何降级：结构化工具被拒、流被截断都如实报错，不退回文本协议、不伪造完成。
 */

import fs from 'node:fs';
import path from 'node:path';
import { toResponsesInput, postResponses, readResponsesStream, hasImageBlocks } from './responses.js';

const CATALOG_TTL = 5 * 60 * 1000;

// 上游瞬时故障的错误文案特征。刻意不含 rate limit / 429：
// 额度用尽走 QUOTA，绝不进重试。
const TRANSIENT = /(no_available_connectors|模型服务暂时不可用|稍后再试|temporarily|timeout|ETIMEDOUT|ECONNRESET|socket hang up|overloaded)/i;

function llmFailure(message, code, extra = {}) {
  const err = new Error(message);
  Object.defineProperty(err, 'failure', {
    value: Object.freeze({ message, code, ...extra }),
    enumerable: true,
    writable: false,
  });
  return err;
}

/** 上游 429 的两种成因要分开：额度用尽（QUOTA，不可重试）与瞬时限流（RATE_LIMIT）。 */
function isQuotaRejection(res, raw) {
  if (res.headers.get('x-hduhelp-quota-5h-utilization') !== null) return true;
  if (res.headers.get('x-hduhelp-quota-7d-utilization') !== null) return true;
  return /quota|额度|配额|用量|exhaust/i.test(raw || '');
}

function classifyFailure(error, status, quota) {
  const message = error instanceof Error ? error.message : String(error);
  if (error?.name === 'AbortError') return llmFailure(message || 'aborted', 'ABORTED');
  if (error?.failure?.code) return error;
  if (status === 401 || status === 403) return llmFailure(message, 'INVALID_CREDENTIAL', { status });
  if (status === 429) {
    return quota
      ? llmFailure(message, 'QUOTA', { status })
      : llmFailure(message, 'RATE_LIMIT', { status });
  }
  if (status && status >= 500) return llmFailure(message, 'SERVER', { status });
  if (TRANSIENT.test(message)) return llmFailure(message, 'SERVER', { status: status || 502 });
  return llmFailure(message, 'UNKNOWN', status ? { status } : {});
}

const EFFORT_NAMES = {
  none: '关闭',
  minimal: '最低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '更高',
  max: '最大',
};

function effortName(id) {
  return EFFORT_NAMES[id] || id;
}

function pickFinish(status, incomplete, sawToolCall) {
  if (sawToolCall) return { kind: 'tool-calls' };
  if (status === 'incomplete') {
    if (incomplete === 'max_output_tokens' || incomplete === 'max_tokens') return { kind: 'max-tokens' };
    if (incomplete === 'content_filter') return { kind: 'error', failure: { message: '内容被上游过滤', code: 'CONTENT_FILTERED' } };
    return { kind: 'error', failure: { message: `上游未正常完成（${incomplete || status}）`, code: 'SERVER' } };
  }
  return { kind: 'stop' };
}

/**
 * 只从上游声明里取能力。返回：
 *   vision: true/false/null（null = 上游未声明）
 *   functionCall: true/false/null
 *   conflict: 两处图像声明是否矛盾（矛盾时 vision 取严 = false）
 */
function declaredCapabilities(m) {
  const caps = m && typeof m.capabilities === 'object' && m.capabilities ? m.capabilities : null;
  const mods = Array.isArray(m?.input_modalities) ? m.input_modalities.filter((x) => typeof x === 'string') : null;
  const capImage = caps && typeof caps.image_input === 'boolean' ? caps.image_input : null;
  const modImage = mods ? mods.includes('image') : null;

  let vision = null;
  let conflict = false;
  if (capImage !== null && modImage !== null) {
    conflict = capImage !== modImage;
    vision = conflict ? false : capImage;
  } else {
    vision = capImage !== null ? capImage : modImage;
  }

  const functionCall = caps && typeof caps.function_call === 'boolean' ? caps.function_call : null;
  // 声明冲突时对外通告的模态也要取严，否则选择器说支持图片、请求却被拒。
  const modalities = mods ? mods.filter((x) => !(conflict && x === 'image')) : null;
  return { vision, functionCall, conflict, modalities };
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
    this.attachments = opts.attachments;
    this.onQuota = opts.onQuota;
    this.getSelected = opts.getSelected;
    this.log = opts.log || (() => {});
    this.catalogFile = path.join(this.dataDir, 'models.json');
    this.catalog = [];
    this.catalogAt = 0;
    this.refreshing = null;
    // 缓存只接受本版本写入的目录（带 schema 标记）。旧版本缓存里的 vision 是猜出来的，
    // 一律丢弃，等登录后从上游重新拉取声明。
    try {
      const saved = JSON.parse(fs.readFileSync(this.catalogFile, 'utf8'));
      if (saved?.schema === 2 && Array.isArray(saved.models)) {
        this.catalog = saved.models;
        this.catalogAt = Number(saved.at) || 0;
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
      // QUOTA 不在列：额度用尽重试没有意义，还会加重上游风控。
      retryableCodes: ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE'],
    };
  }

  imageRequestPricing() {
    return undefined;
  }

  async listModels(provider) {
    if (this.getToken()) await this.refreshModels().catch(() => {});
    const selected = typeof this.getSelected === 'function' ? this.getSelected() : null;
    const pool = selected && selected.size ? this.catalog.filter((m) => selected.has(m.id)) : [];
    return pool.map((m) => ({
      provider,
      id: m.id,
      name: m.name || m.id,
      // 上游未声明模态时不编造：省略该字段即「未知」。
      ...(m.modalities ? { inputModalities: m.modalities } : {}),
    }));
  }

  async resolveModel(provider, model) {
    // 未登录时目录必然为空：先给出可行动的「去登录」，不要报成「模型不在目录里」。
    if (!this.getToken()) {
      throw llmFailure('杭电助手还没有登录：请到 设置 → 杭电助手 AI 用学号密码登录', 'MISSING_CREDENTIAL');
    }
    const selected = typeof this.getSelected === 'function' ? this.getSelected() : null;
    if (selected && !selected.has(model)) {
      throw llmFailure(
        `模型 ${model} 未在「设置 → 杭电助手 AI → 模型注册」里勾选，请先勾选并保存`,
        'INVALID_MODEL_INFO',
      );
    }
    const entry = this.catalog.find((m) => m.id === model);
    if (!entry) {
      throw llmFailure(
        `模型 ${model} 不在上游目录里（目录共 ${this.catalog.length} 项）；请在面板重新拉取模型列表`,
        'INVALID_MODEL_INFO',
      );
    }

    // 上下文长度只用上游声明值；缺失就不上报 context，不用兜底数字假装知道。
    const context = entry.contextWindow > 0 ? { context: { contextWindow: entry.contextWindow } } : {};
    const levels = entry.reasoningLevels || [];
    const reasoning = levels.length
      ? {
          efforts: levels.map((id) => ({ id, name: effortName(id) })),
          ...(entry.defaultReasoning ? { defaultEffort: entry.defaultReasoning } : {}),
        }
      : undefined;

    return {
      provider,
      id: model,
      name: entry.name || model,
      ...(entry.modalities ? { inputModalities: entry.modalities } : {}),
      ...context,
      // 不设 defaultMaxTokens：上游没声明输出上限，交给上游自己的默认值。
      ...(reasoning ? { reasoning } : {}),
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
          .filter((m) => m && typeof m === 'object')
          .map((m) => {
            const cap = declaredCapabilities(m);
            const ctx = Number(m.context_window);
            return {
              id: String(m.id || '').trim(),
              name: String(m.display_name || m.name || m.id || '').trim(),
              contextWindow: Number.isFinite(ctx) && ctx > 0 ? Math.trunc(ctx) : 0,
              vision: cap.vision,
              functionCall: cap.functionCall,
              visionConflict: cap.conflict,
              modalities: cap.modalities,
              reasoningLevels: Array.isArray(m.supported_reasoning_levels)
                ? m.supported_reasoning_levels.filter((x) => typeof x === 'string' && x)
                : [],
              defaultReasoning: typeof m.default_reasoning_level === 'string' ? m.default_reasoning_level : '',
            };
          })
          .filter((m) => m.id);
        if (!models.length) return;
        this.catalog = models;
        this.catalogAt = Date.now();
        const undeclaredCtx = models.filter((m) => !m.contextWindow).map((m) => m.id);
        const conflicts = models.filter((m) => m.visionConflict).map((m) => m.id);
        if (undeclaredCtx.length) this.log('上游未声明上下文长度（不做猜测）:', undeclaredCtx.join(', '));
        if (conflicts.length) this.log('上游图像能力声明自相矛盾，按不支持处理:', conflicts.join(', '));
        try {
          fs.writeFileSync(this.catalogFile, JSON.stringify({ schema: 2, purpose, at: this.catalogAt, models }, null, 2), { mode: 0o600 });
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

  /** 换账号/登出后清掉内存目录与磁盘缓存，避免沿用上一个账号的可见模型。 */
  invalidateCatalog() {
    this.catalog = [];
    this.catalogAt = 0;
    try { fs.rmSync(this.catalogFile, { force: true }); } catch { /* ignore */ }
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
        const failure = classifyFailure(error, error?.status, error?.quotaExhausted);
        const retryable = failure.failure.code === 'SERVER';
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

  /** 从响应头里读额度窗口（x-hduhelp-quota-5h/7d-*）。缺失的窗口不上报，交给宿主保留已知值。 */
  #reportQuota(res) {
    if (typeof this.onQuota !== 'function') return;
    try {
      const h = res.headers;
      const util5 = h.get('x-hduhelp-quota-5h-utilization');
      const reset5 = h.get('x-hduhelp-quota-5h-reset');
      const util7 = h.get('x-hduhelp-quota-7d-utilization');
      const reset7 = h.get('x-hduhelp-quota-7d-reset');
      const retryAfter = h.get('retry-after');
      const windows = {};
      if (util5 !== null) {
        windows['5h'] = { utilization: Number(util5), resetAt: reset5 ? Number(reset5) : null };
      }
      if (util7 !== null) {
        windows['7d'] = { utilization: Number(util7), resetAt: reset7 ? Number(reset7) : null };
      }
      const payload = {
        status: res.status,
        at: Date.now(),
        source: 'plugin-requests',
      };
      if (Object.keys(windows).length) payload.windows = windows;
      if (res.status === 200) {
        payload.exhausted = false;
        payload.retryAfter = null;
      } else if (res.status === 429) {
        payload.exhausted = true;
        payload.retryAfter = retryAfter ? Number(retryAfter) : null;
      } else {
        return;
      }
      this.onQuota(payload);
    } catch { /* 头部不规范就忽略 */ }
  }

  /**
   * 把 DSH 的图片附件读成 data URL；读失败如实抛错，不静默丢图。
   * 直接带 url / dataUrl 的图片块由 responses.js 原样透传，不需要附件服务。
   */
  async #readImages(messages, signal) {
    const refs = new Map();
    let unusable = 0;
    for (const m of messages || []) {
      if (!m || !Array.isArray(m.content)) continue;
      for (const b of m.content) {
        if (!b || b.type !== 'image') continue;
        const id = b.attachment?.attachmentId;
        if (id) { refs.set(id, b.attachment); continue; }
        const direct = b.attachment?.url || b.attachment?.dataUrl || b.url;
        if (typeof direct !== 'string' || !direct) unusable += 1;
      }
    }
    if (unusable) {
      throw llmFailure(`有 ${unusable} 个图片块既无附件引用也无可用 URL，已中止请求（不静默丢图）`, 'INVALID_ARGS');
    }
    if (!refs.size) return undefined;
    const attachments = this.attachments;
    if (!attachments || typeof attachments.readImageRequest !== 'function') {
      throw llmFailure('宿主未提供附件读取服务，无法把图片附件交给模型', 'INVALID_ARGS');
    }
    const out = new Map();
    for (const [id, ref] of refs) {
      const read = await attachments.readImageRequest(ref, undefined, signal);
      if (!read || read.bytes <= 0 || !read.data?.length) {
        throw llmFailure(`图片附件 ${id} 读取为空，已中止请求（不静默丢图）`, 'INVALID_ARGS');
      }
      const mediaType = read.mediaType || ref.mediaType || 'image/png';
      const base64 = Buffer.from(read.data.buffer, read.data.byteOffset, read.data.byteLength).toString('base64');
      out.set(id, `data:${mediaType};base64,${base64}`);
    }
    return out;
  }

  async *#streamOnce(options) {
    const purpose = this.purpose;
    const token = this.getToken();
    if (!token) {
      throw llmFailure('杭电助手还没有登录：请到 设置 → 杭电助手 AI 用学号密码登录', 'MISSING_CREDENTIAL');
    }

    // resolveModel 已校验勾选与目录存在性，这里复用同一份声明。
    await this.resolveModel(options.provider || this.providerId, options.model);
    const entry = this.catalog.find((m) => m.id === options.model);
    const hasTools = Array.isArray(options.tools) && options.tools.length > 0;
    const wantsImages = hasImageBlocks(options.messages);

    if (wantsImages && entry.vision !== true) {
      throw llmFailure(
        entry.visionConflict
          ? `模型 ${options.model} 的上游图像能力声明自相矛盾，按不支持处理；请换用明确声明支持图片的模型`
          : `模型 ${options.model} 未声明支持图片输入，已中止请求（不静默丢图）`,
        'INVALID_ARGS',
      );
    }
    if (hasTools && entry.functionCall === false) {
      throw llmFailure(`模型 ${options.model} 的上游声明不支持工具调用（function_call=false）`, 'INVALID_ARGS');
    }

    const images = wantsImages ? await this.#readImages(options.messages, options.signal) : undefined;
    const { instructions, input } = toResponsesInput(options.messages, {
      system: options.system,
      images,
    });
    const body = { model: options.model, input, stream: true };
    if (instructions) body.instructions = instructions;
    if (typeof options.temperature === 'number') body.temperature = options.temperature;
    if (typeof options.reasoningEffort === 'string' && options.reasoningEffort) {
      body.reasoning = { effort: options.reasoningEffort };
    }
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

    const send = (tk) => postResponses({ purpose, token: tk, body, signal: options.signal });
    let res = await send(token);
    this.#reportQuota(res);
    if (res.status === 401 && this.refreshToken) {
      const fresh = await this.refreshToken();
      if (fresh) { res = await send(fresh); this.#reportQuota(res); }
    }
    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      let msg = raw.trim().slice(0, 500);
      try {
        const j = JSON.parse(raw);
        msg = j?.error?.message || j?.message || msg;
      } catch { /* 保留原文 */ }
      const quota = res.status === 429 && isQuotaRejection(res, raw);
      if (quota) {
        const wait = res.headers.get('retry-after');
        const tail = wait ? `，约 ${Math.ceil(Number(wait) / 60)} 分钟后恢复` : '';
        const err = llmFailure(`杭电助手额度已用尽${tail}；上游原文：${msg || '无'}`, 'QUOTA', { status: 429 });
        err.status = 429;
        err.quotaExhausted = true;
        throw err;
      }
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

    // readResponsesStream 在没有终止事件时抛错，因此这里不再有「假成功」兜底。
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

    // 理论上不可达：readResponsesStream 要么给出 finish，要么抛错。
    throw new Error('stream ended without a terminal event');
  }
}