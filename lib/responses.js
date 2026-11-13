/**
 * 杭电助手 Responses 协议客户端。
 *
 * 逆向发现：文本用途（app.mate.chat / summary / title）的入口协议是
 * **Responses**，走 /openai/v1/chat/completions 会被上游直接拒（"入口协议是 responses"）。
 *
 * 工具结果是**支持结构化**的，但有两条硬约束（实测）：
 *   1. input 里必须同时带上配对的 `function_call` item（只有 function_call_output 会 400）；
 *   2. `call_id` 必须是上游自己签发的（伪造的 call_id 一律 400）。
 * 因为 DSH 的 toolCallId 就是我们上报的 call_id，正常循环天然满足。
 *
 * 会话恢复、跨进程等情况下历史 call_id 可能已失效，此时上游返回 400，
 * 适配器会自动退回文本观察协议（「工具调用 name(args) 返回：…」）重试一次。
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

/**
 * DSH / OpenAI 风格 messages -> Responses `input`。
 * 返回 { instructions, input }。
 */
export function toResponsesInput(messages, { system, vision = false, toolProtocol = false, images, structuredTools = true } = {}) {
  const instructions = [];
  if (typeof system === 'string' && system.trim()) instructions.push(system.trim());

  // 先建 callId -> {name, arguments} 索引，工具结果要带上名字和参数，
  // 否则模型认不出这是哪次调用的返回值。
  const callIndex = new Map();
  const emittedCalls = new Set();
  for (const m of messages || []) {
    if (!m || m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b && b.type === 'tool-call' && b.id) callIndex.set(String(b.id), { name: b.name || '', arguments: b.arguments || '{}' });
    }
  }

  const input = [];

  const pushMessage = (role, text) => {
    if (!text) return;
    // 连续的工具结果合并成一条 user 观察消息，接近原生 tool 批次的观感
    if (role === 'user' && toolBuffer.length) {
      toolBuffer.push(text);
      return;
    }
    input.push({ type: 'message', role, content: [{ type: 'input_text', text }] });
  };
  const toolBuffer = [];
  const flushTools = () => {
    if (!toolBuffer.length) return;
    input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: toolBuffer.join('\n\n') }] });
    toolBuffer.length = 0;
  };

  for (const m of messages || []) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role;
    if (role === 'system' || role === 'developer') {
      const t = textOfContent(m.content);
      if (t.trim()) instructions.push(t.trim());
      continue;
    }
    if (role !== 'tool') flushTools();
    if (role === 'tool') {
      const id = String(m.toolCallId || m.tool_call_id || '');
      const body = textOfContent(m.content) || '(no output)';
      if (structuredTools && id && emittedCalls.has(id)) {
        flushTools();
        input.push({ type: 'function_call_output', call_id: id, output: body });
        continue;
      }
      // 配不上对（没有对应的 function_call）时退回文本观察
      const call = callIndex.get(id);
      const head = call ? `工具调用 ${call.name}(${call.arguments})` : `工具调用${id ? ` ${id}` : ''}`;
      toolBuffer.push(`${head} 返回：\n${body}`);
      continue;
    }
    if (role === 'assistant') {
      const blocks = Array.isArray(m.content) ? m.content : [];
      const calls = blocks.filter((b) => b && b.type === 'tool-call');
      const text = textOfContent(m.content);
      if (text) pushMessage('assistant', text);
      if (structuredTools && calls.length) {
        for (const c of calls) {
          if (!c.id) continue;
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
      }
      continue;
    }
    // user
    const text = textOfContent(m.content);
    const urls = vision ? imageUrls(m.content, images) : [];
    if (urls.length) {
      const parts = [];
      if (text) parts.push({ type: 'input_text', text });
      for (const url of urls) parts.push({ type: 'input_image', image_url: url });
      input.push({ type: 'message', role: 'user', content: parts });
    } else {
      pushMessage('user', text);
    }
  }

  flushTools();
  if (toolProtocol && !structuredTools) {
    instructions.push('工具用法：你通过 tools 声明调用函数；一次调用结束后，工具结果会作为 user 消息「工具调用 <name>(<args>) 返回：…」送回，请基于结果继续，需要时继续调用工具。');
  }
  return { instructions: instructions.join('\n\n'), input };
}

/**
 * 发起 Responses 请求。返回原始 Response（调用方决定读流还是读 JSON）。
 */
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
 *   {type:'reasoning', text}
 *   {type:'text', text}
 *   {type:'tool-start', id, name}
 *   {type:'tool-args', id, delta}
 *   {type:'tool-end', id, args}
 *   {type:'usage', inputTokens, outputTokens}
 *   {type:'finish', status, incompleteReason}
 */
export async function* readResponsesStream(body) {
  const decoder = new TextDecoder();
  let buf = '';
  const callByItem = new Map(); // item_id -> {id, name, args}
  let usage = null;
  let status = '';
  let incomplete = '';

  const handle = (evt) => {
    if (!evt || typeof evt !== 'object') return [];
    const out = [];
    switch (evt.type) {
      case 'response.output_item.added': {
        const item = evt.item || {};
        if (item.type === 'function_call') {
          const rec = { id: item.call_id || item.id || '', name: item.name || '', args: '' };
          callByItem.set(item.id || item.call_id || rec.id, rec);
          out.push({ type: 'tool-start', id: rec.id, name: rec.name });
        }
        break;
      }
      case 'response.function_call_arguments.delta': {
        const rec = callByItem.get(evt.item_id) || [...callByItem.values()].pop();
        if (rec) {
          const d = String(evt.delta || '');
          rec.args += d;
          out.push({ type: 'tool-args', id: rec.id, delta: d });
        }
        break;
      }
      case 'response.function_call_arguments.done': {
        const rec = callByItem.get(evt.item_id) || [...callByItem.values()].pop();
        if (rec) {
          if (typeof evt.arguments === 'string' && evt.arguments) rec.args = evt.arguments;
          out.push({ type: 'tool-end', id: rec.id, args: rec.args || '{}' });
        }
        break;
      }
      case 'response.output_item.done': {
        const item = evt.item || {};
        if (item.type === 'function_call') {
          const rec = callByItem.get(item.id || item.call_id) || [...callByItem.values()].pop();
          if (rec) {
            if (typeof item.arguments === 'string' && item.arguments) rec.args = item.arguments;
            out.push({ type: 'tool-end', id: rec.id, args: rec.args || '{}' });
          }
        }
        break;
      }
      case 'response.reasoning_text.delta':
        if (evt.delta) out.push({ type: 'reasoning', text: String(evt.delta) });
        break;
      case 'response.output_text.delta':
        if (evt.delta) out.push({ type: 'text', text: String(evt.delta) });
        break;
      case 'response.completed': {
        const r = evt.response || {};
        if (r.usage) {
          usage = {
            inputTokens: Number(r.usage.input_tokens || 0),
            outputTokens: Number(r.usage.output_tokens || 0),
          };
        }
        status = r.status || 'completed';
        if (r.incomplete_details?.reason) incomplete = r.incomplete_details.reason;
        break;
      }
      case 'response.failed': {
        const r = evt.response || {};
        const msg = r.error?.message || evt.error?.message || '上游返回失败';
        throw new Error(msg);
      }
      case 'error': {
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

  if (usage) yield { type: 'usage', ...usage };
  yield { type: 'finish', status: status || 'completed', incompleteReason: incomplete };
}
