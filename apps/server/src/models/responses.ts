import type { ModelProfile, ModelRequest, ModelResult, ModelToolCall } from '@yearbook/shared';
import { invalidResponse, modelHttp, ModelError, object, readJson, readSse, serviceError, usage, withModelUsage } from './transport.js';

export function responsesBody(profile: ModelProfile, request: ModelRequest) {
  const input: unknown[] = [];
  for (const message of request.messages) {
    if (message.role === 'tool') {
      if (!message.callId) throw invalidResponse('工具结果缺少调用编号');
      input.push({ type: 'function_call_output', call_id: message.callId, output: message.text });
    } else if (message.role === 'assistant' && message.providerItems?.length) {
      // Only known output-item fields are replayed. Reasoning (including encrypted state) is retained.
      for (const raw of message.providerItems) {
        const item = object(raw);
        if (item.type === 'reasoning') input.push({ type: 'reasoning', ...(item.id ? { id: item.id } : {}), summary: item.summary ?? [], ...(item.encrypted_content ? { encrypted_content: item.encrypted_content } : {}) });
        else if (item.type === 'function_call') input.push({ type: 'function_call', call_id: item.call_id, name: item.name, arguments: item.arguments });
        else if (item.type === 'message') input.push({ role: 'assistant', content: (Array.isArray(item.content) ? item.content : []).filter((part: any) => part.type === 'output_text').map((part: any) => part.text).join('') });
      }
    } else {
      input.push({ role: message.role, content: message.images?.length ? [{ type: 'input_text', text: message.text }, ...message.images.map(image => ({ type: 'input_image', image_url: image.dataUrl, detail: image.detail ?? 'auto' }))] : message.text });
      if (message.role === 'assistant') for (const call of message.toolCalls ?? []) input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments });
    }
  }
  return {
    model: profile.model, instructions: request.system, input, store: false, max_output_tokens: profile.maxOutputTokens,
    include: ['reasoning.encrypted_content'],
    ...(request.tools?.length ? { tools: request.tools.map(tool => ({ type: 'function', ...tool, strict: false })), tool_choice: request.toolChoice ?? 'auto' } : {}),
    stream: request.stream ?? false,
  };
}
export function parseResponses(raw: unknown): ModelResult {
  try { return parseResponsesValue(raw); }
  catch (error) { throw withModelUsage(error, usage(object(raw).usage, 'responses')); }
}
function parseResponsesValue(raw: unknown): ModelResult {
  const value = object(raw);
  if (value.error || value.status === 'failed') throw serviceError(400, value);
  if (value.status === 'incomplete') throw new ModelError('MODEL_OUTPUT_TRUNCATED', '模型输出未完成，请提高输出长度限制或减少素材后重试', 400);
  if (!Array.isArray(value.output)) throw invalidResponse();
  const parts: string[] = []; const calls: ModelToolCall[] = [];
  for (const rawItem of value.output) {
    const item = object(rawItem);
    if (item.type === 'message') {
      if (!Array.isArray(item.content)) throw invalidResponse();
      for (const rawPart of item.content) { const part = object(rawPart); if (part.type === 'output_text' && typeof part.text === 'string') parts.push(part.text); else if (part.type === 'refusal') throw new ModelError('MODEL_REFUSED', '模型未能处理本次请求，可以修改整理要求后重试', 400); }
    } else if (item.type === 'function_call') {
      if (typeof item.call_id !== 'string' || typeof item.name !== 'string' || typeof item.arguments !== 'string') throw invalidResponse();
      calls.push({ id: item.call_id, name: item.name, arguments: item.arguments });
    }
  }
  if (!parts.join('').trim() && !calls.length) throw invalidResponse('模型未返回文字或有效工具调用');
  return { text: parts.join(''), toolCalls: calls, usage: usage(value.usage, 'responses'), providerItems: value.output };
}
export async function generateResponses(profile: ModelProfile, key: string | null, request: ModelRequest): Promise<ModelResult> {
  return modelHttp(profile, key, responsesBody(profile, request), request.signal, async response => {
    if (!request.stream) return parseResponses(await readJson(response));
    let result: ModelResult | undefined;
    await readSse(response, raw => {
      const event = object(raw);
      if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') request.onDelta?.(event.delta);
      if (event.type === 'response.completed') result = parseResponses(event.response);
      if (event.type === 'response.failed' || event.type === 'error') throw withModelUsage(serviceError(400, event.response ?? event), usage(object(event.response ?? event).usage, 'responses'));
      if (event.type === 'response.incomplete') throw new ModelError('MODEL_OUTPUT_TRUNCATED', '流式输出未完成，请增加输出长度或减少素材', 400, usage(object(event.response).usage, 'responses'));
    });
    if (!result) throw invalidResponse('流式连接结束前没有收到 Responses 完成事件，可重试');
    return result;
  });
}
