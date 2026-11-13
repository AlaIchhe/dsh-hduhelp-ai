/**
 * 杭电助手 Responses 协议客户端。
 *
 * 上游文本用途（app.mate.chat / summary / title）的入口协议是 **Responses**，
 * 走 /openai/v1/chat/completions 会被上游直接拒。
 *
 * 工具调用只用结构化 item，两条硬约束（实测）：
 *   1. input 里必须同时带上配对的 `function_call` item；
 *   2. `call_id` 必须是上游自己签发的。
 *
 * 本模块不做任何降级：配不上对的工具结果、缺终止事件的流一律抛错，
 * 不退回文本观察协议，也不把截断的响应当成功交给上层。
 */

import { randomUUID } from 'node:crypto';

const API_AI = 'https://api.hduhelp.com/hduhelp-neo/ai/v1';

export function aiUrl(purpose, sub = 'responses') {
  return `${API_AI}/purposes/${encodeURIComponent(purpose)}/openai/v1/${sub}`;
}

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') out.push(b.text);
    else if (b.type === 'input_text' && typeof b.text === 'string') out.push(b.text);
    else if (b.type === 'output_text' && typeof b.text === 'string') out.push(b.text);
  }
  return out.join('');
}

function imageUrls(content, images) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const b of content) {
    if (!b || b.type !== 'image') continue;
    const id = b.attachment?.attachmentId;
    const url = (id && images?.get(id)) || b.attachment?.url || b.attachment?.dataUrl || b.url;
    if (typeof url === 'string' && url) out.push(url);
  }
  return out;
}

/** 消息里是否带图片附件（供调用方按上游声明的能力做前置校验）。 */
export function hasImageBlocks(messages) {
  for (const m of messages || []) {
    if (!m || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b && b.type === 'image') return true;
    }
  }
  return false;
}

/**
 * DSH 风格 messages -> Responses `input`。返回 { instructions, input }。
 * 工具调用与结果一律结构化；无法配对时抛错，由上层如实报错。
 */
export function toResponsesInput(messages, { system, images } = {}) {
  const instructions = [];
  if (typeof system === 'string' && system.trim()) instructions.push(system.trim());

  const input = [];
  const emittedCalls = new Set();

  const pushMessage = (role, text) => {
    if (!text) return;
    input.push({ type: 'message', role, content: [{ type: 'input_text', text }] });
  };

  for (const m of messages || []) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role;
    if (role === 'system' || role === 'developer') {
      const t = textOfContent(m.content);
      if (t.trim()) instructions.push(t.trim());
      continue;
    }
    if (role === 'tool') {
      const id = String(m.toolCallId || m.tool_call_id || '');
      if (!id) {
        throw new Error('工具结果缺少 toolCallId，无法与上游 function_call 配对');
      }
      if (!emittedCalls.has(id)) {
        throw new Error(`工具结果 ${id} 在历史里找不到对应的 assistant 工具调用（历史可能已被压缩）；上游只接受配对的 function_call，请新开一轮对话`);
      }
      input.push({
        type: 'function_call_output',
        call_id: id,
        output: textOfContent(m.content) || '(no output)',
      });
      continue;
    }
    if (role === 'assistant') {
      const blocks = Array.isArray(m.content) ? m.content : [];
      const text = textOfContent(m.content);
      if (text) pushMessage('assistant', text);
      for (const c of blocks) {
        if (!c || c.type !== 'tool-call') continue;
        if (!c.id) {
          throw new Error('assistant 工具调用缺少 id，无法构造上游要求的 call_id');
        }
        input.push({
          type: 'function_call',
          id: randomUUID(),
          call_id: String(c.id),
          name: String(c.name || ''),
          arguments: String(c.arguments || '{}'),
          status: 'completed',
        });
        emittedCalls.add(String(c.id));
      }
      continue;
    }
    // user
    const text = textOfContent(m.content);
    const urls = imageUrls(m.content, images);
    if (urls.length) {
      const parts = [];
      if (text) parts.push({ type: 'input_text', text });
      for (const url of urls) parts.push({ type: 'input_image', image_url: url });
      input.push({ type: 'message', role: 'user', content: parts });
    } else {
      pushMessage('user', text);
    }
  }

  return { instructions: instructions.join('\n\n'), input };
}

/** 发起 Responses 请求。返回原始 Response（调用方决定读流）。 */
export async function postResponses({ purpose, token, body, signal }) {
  return fetch(aiUrl(purpose, 'responses'), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: body?.stream === true ? 'text/event-stream' : 'application/json',
      'x-device-id': 'dsh-hduhelp-ai',
      'x-device-name': 'DSH',
      'x-hduhelp-source': 'app',
    },
    body: JSON.stringify(body),
    signal,
  });
}

function parseSseLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;
  const payload = trimmed.slice(5).trim();
  if (!payload) return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/**
 * 解析 Responses 的 SSE，产出归一化事件：
 *   {type:'reasoning', text} / {type:'text', text}
 *   {type:'tool-start', id, name} / {type:'tool-args', id, delta} / {type:'tool-end', id, args}
 *   {type:'usage', inputTokens, outputTokens}
 *   {type:'finish', status, incompleteReason}
 *
 * 没有终止事件就抛错：截断的流不会被当成正常完成。
 */
export async function* readResponsesStream(body) {
  const decoder = new TextDecoder();
  let buf = '';
  const callByItem = new Map(); // item_id -> {id, name, args}
  let usage = null;
  let status = '';
  let incomplete = '';
  let sawTerminal = false;

  const requireCall = (itemId) => {
    const rec = callByItem.get(itemId);
    if (!rec) {
      throw new Error(`上游工具事件引用了未知的 item_id（${String(itemId)}），无法确定属于哪次调用`);
    }
    return rec;
  };

  const handle = (evt) => {
    if (!evt || typeof evt !== 'object') return [];
    const out = [];
    switch (evt.type) {
      case 'response.output_item.added': {
        const item = evt.item || {};
        if (item.type === 'function_call') {
          const key = item.id || item.call_id;
          if (!key) throw new Error('上游 function_call 缺少 id/call_id');
          const rec = { id: item.call_id || item.id || '', name: item.name || '', args: '' };
          callByItem.set(key, rec);
          out.push({ type: 'tool-start', id: rec.id, name: rec.name });
        }
        break;
      }
      case 'response.function_call_arguments.delta': {
        const rec = requireCall(evt.item_id);
        const d = String(evt.delta || '');
        rec.args += d;
        out.push({ type: 'tool-args', id: rec.id, delta: d });
        break;
      }
      case 'response.function_call_arguments.done': {
        const rec = requireCall(evt.item_id);
        if (typeof evt.arguments === 'string' && evt.arguments) rec.args = evt.arguments;
        out.push({ type: 'tool-end', id: rec.id, args: rec.args || '{}' });
        break;
      }
      case 'response.output_item.done': {
        const item = evt.item || {};
        if (item.type === 'function_call') {
          const rec = requireCall(item.id || item.call_id);
          if (typeof item.arguments === 'string' && item.arguments) rec.args = item.arguments;
          out.push({ type: 'tool-end', id: rec.id, args: rec.args || '{}' });
        }
        break;
      }
      case 'response.reasoning_text.delta':
        if (evt.delta) out.push({ type: 'reasoning', text: String(evt.delta) });
        break;
      case 'response.output_text.delta':
        if (evt.delta) out.push({ type: 'text', text: String(evt.delta) });
        break;
      case 'response.completed':
      case 'response.incomplete': {
        const r = evt.response || {};
        if (r.usage) {
          usage = {
            inputTokens: Number(r.usage.input_tokens || 0),
            outputTokens: Number(r.usage.output_tokens || 0),
          };
        }
        status = r.status || (evt.type === 'response.incomplete' ? 'incomplete' : 'completed');
        if (r.incomplete_details?.reason) incomplete = r.incomplete_details.reason;
        sawTerminal = true;
        break;
      }
      case 'response.failed': {
        const r = evt.response || {};
        sawTerminal = true;
        throw new Error(r.error?.message || evt.error?.message || '上游返回失败');
      }
      case 'error': {
        sawTerminal = true;
        throw new Error(evt.message || evt.error?.message || '上游流错误');
      }
      default:
        break;
    }
    return out;
  };

  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      const evt = parseSseLine(line);
      for (const e of handle(evt)) yield e;
    }
  }
  if (buf.trim()) {
    const evt = parseSseLine(buf);
    for (const e of handle(evt)) yield e;
  }

  if (!sawTerminal) {
    throw new Error('stream ended without a terminal event（上游流被截断，未收到 response.completed）');
  }

  if (usage) yield { type: 'usage', ...usage };
  yield { type: 'finish', status, incompleteReason: incomplete };
}