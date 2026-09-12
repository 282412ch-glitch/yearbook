import type { ModelProfile, ModelRequest, ModelResult, ModelToolCall, ModelUsage } from '@yearbook/shared';
import { invalidResponse, modelHttp, ModelError, object, readJson, readSse, serviceError, usage, withModelUsage } from './transport.js';

export function chatBody(profile: ModelProfile, request: ModelRequest) {
  const messages: unknown[] = [{ role: 'system', content: request.system }];
  for (const message of request.messages) {
    if (message.role === 'tool') {
      if (!message.callId) throw invalidResponse('工具结果缺少调用编号');
      messages.push({ role: 'tool', content: message.text, tool_call_id: message.callId });
    } else messages.push({
      role: message.role,
      content: message.images?.length ? [{ type: 'text', text: message.text }, ...message.images.map(image => ({ type: 'image_url', image_url: { url: image.dataUrl, detail: image.detail ?? 'auto' } }))] : message.text || (message.toolCalls?.length ? null : ''),
      ...(message.toolCalls?.length ? { tool_calls: message.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) } : {}),
    });
  }
  return { model: profile.model, messages, store: false, max_completion_tokens: profile.maxOutputTokens, stream: request.stream ?? false,
    ...(request.stream ? { stream_options: { include_usage: true } } : {}),
    ...(request.tools?.length ? { tools: request.tools.map(tool => ({ type: 'function', function: { ...tool, strict: false } })), tool_choice: request.toolChoice ?? 'auto' } : {}),
  };
}
function parseCalls(value: unknown): ModelToolCall[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalidResponse();
  return value.map(raw => { const call = object(raw); const fn = object(call.function); if (call.type !== 'function' || typeof call.id !== 'string' || typeof fn.name !== 'string' || typeof fn.arguments !== 'string') throw invalidResponse(); return { id: call.id, name: fn.name, arguments: fn.arguments }; });
}
export function parseChat(raw: unknown): ModelResult {
  try { return parseChatValue(raw); }
  catch (error) { throw withModelUsage(error, usage(object(raw).usage, 'chat')); }
}
function parseChatValue(raw: unknown): ModelResult {
  const value = object(raw);
  if (value.error) throw serviceError(200, value);
  if (!Array.isArray(value.choices) || !value.choices.length) throw invalidResponse();
  const choice = object(value.choices[0]); const message = object(choice.message);
  if (choice.finish_reason === 'length') throw new ModelError('MODEL_OUTPUT_TRUNCATED', '模型输出达到长度上限，请增加输出长度或减少素材', 400);
  if (message.refusal || choice.finish_reason === 'content_filter') throw new ModelError('MODEL_REFUSED', '模型未能处理本次请求，可以修改整理要求后重试', 400);
  const text = typeof message.content === 'string' ? message.content : '';
  const calls = parseCalls(message.tool_calls);
  if (!text.trim() && !calls.length) throw invalidResponse('模型未返回文字或有效工具调用');
  return { text, toolCalls: calls, usage: usage(value.usage, 'chat') };
}
export async function generateChat(profile: ModelProfile, key: string | null, request: ModelRequest): Promise<ModelResult> {
  return modelHttp(profile, key, chatBody(profile, request), request.signal, async response => {
    if (!request.stream) return parseChat(await readJson(response));
    let text = ''; let tokenUsage: ModelUsage | null = null; let done = false; let finishReason: string | null = null;
    const calls = new Map<number, ModelToolCall>();
    try {
    await readSse(response, raw => {
      if (raw === '[DONE]') { done = true; return false; }
      const item = object(raw);
      if (item.usage) tokenUsage = usage(item.usage, 'chat');
      if (item.error) throw serviceError(200, item);
      if (!Array.isArray(item.choices)) throw invalidResponse();
      for (const rawChoice of item.choices) {
        const choice = object(rawChoice);
        if (choice.index !== undefined && choice.index !== 0) continue;
        const delta = object(choice.delta);
        if (typeof delta.content === 'string') { text += delta.content; request.onDelta?.(delta.content); }
        if (delta.refusal) throw new ModelError('MODEL_REFUSED', '模型未能处理本次请求', 400);
        if (choice.finish_reason) finishReason = choice.finish_reason;
        if (delta.tool_calls !== undefined && !Array.isArray(delta.tool_calls)) throw invalidResponse();
        for (const rawCall of delta.tool_calls ?? []) {
          const call = object(rawCall); const fn = object(call.function);
          if (!Number.isInteger(call.index) || call.index < 0 || call.index > 100) throw invalidResponse();
          const existing = calls.get(call.index) ?? { id: '', name: '', arguments: '' };
          if (call.id) existing.id += call.id;
          if (typeof fn.name === 'string') existing.name += fn.name;
          if (typeof fn.arguments === 'string') existing.arguments += fn.arguments;
          calls.set(call.index, existing);
        }
      }
    });
    if (!done || !finishReason) throw invalidResponse('流式连接中断，没有收到 Chat Completions 的完整结束标记');
    if (finishReason === 'length') throw new ModelError('MODEL_OUTPUT_TRUNCATED', '流式输出达到长度上限，请增加输出长度或减少素材', 400);
    if (finishReason === 'content_filter') throw new ModelError('MODEL_REFUSED', '模型未能处理本次请求', 400);
    const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
    if (toolCalls.some(call => !call.id || !call.name) || (!text.trim() && !toolCalls.length)) throw invalidResponse();
    return { text, toolCalls, usage: tokenUsage };
    } catch (error) { throw withModelUsage(error, tokenUsage); }
  });
}
