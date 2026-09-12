import type { ModelProfile, ModelUsage } from '@yearbook/shared';
import { AppError } from '../errors.js';

export class ModelError extends AppError {
  constructor(code: string, message: string, status = 502, public usage: ModelUsage | null = null) { super(status, code, message); }
}
/** Preserve only validated counters, never an upstream response or its sensitive fields. */
export function withModelUsage(error: unknown, tokenUsage: ModelUsage | null): ModelError {
  const result = error instanceof ModelError ? error : new ModelError('MODEL_NETWORK_ERROR', '模型连接中断，请稍后重试', 503);
  if (tokenUsage) result.usage = tokenUsage;
  return result;
}
export function invalidResponse(message = '模型响应结构不符合所选协议，请检查服务协议和模型设置') { return new ModelError('MODEL_RESPONSE_INVALID', message); }
export function object(value: unknown): Record<string, any> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}; }
export function usage(value: unknown, protocol: 'responses' | 'chat'): ModelUsage | null {
  const item = object(value);
  const mapping = protocol === 'responses' ? { inputTokens: 'input_tokens', outputTokens: 'output_tokens', totalTokens: 'total_tokens' } : { inputTokens: 'prompt_tokens', outputTokens: 'completion_tokens', totalTokens: 'total_tokens' };
  const result: ModelUsage = {};
  for (const [to, from] of Object.entries(mapping)) if (Number.isSafeInteger(item[from]) && item[from] >= 0) result[to as keyof ModelUsage] = item[from];
  return Object.keys(result).length ? result : null;
}
export function serviceError(status: number, value: unknown, event?: 'response.failed' | 'error'): ModelError {
  // Responses SSE errors use top-level fields; HTTP failures commonly nest them.
  // Upstream strings are inspected only for classification, never echoed into logs/UI.
  const root = object(value);
  const error = Object.keys(object(root.error)).length ? object(root.error) : root;
  const hint = [error.code, error.type, error.message, error.param, root.detail, typeof root.error === 'string' ? root.error : null].filter(v => typeof v === 'string').join(' ').toLowerCase();
  const codes = ['invalid_api_key', 'authentication_error', 'permission_denied', 'rate_limit_exceeded', 'insufficient_quota', 'server_error', 'service_unavailable', 'overloaded_error', 'model_not_found', 'unsupported_parameter', 'invalid_parameter', 'invalid_request_error', 'invalid_responses_request', 'new_api_error', 'stream_required'];
  const upstreamCode = [error.code, error.type].find(v => typeof v === 'string' && codes.includes(v));
  const parameters = ['max_output_tokens', 'max_completion_tokens', 'max_tokens', 'stream', 'stream_options', 'include', 'tools', 'tool_choice', 'reasoning', 'instructions', 'input', 'messages', 'store', 'model', 'parallel_tool_calls', 'text', 'temperature', 'top_p'];
  const parameter = parameters.find(field => error.param === field || typeof error.param === 'string' && (error.param.startsWith(`${field}.`) || error.param.startsWith(`${field}[`)));
  const diagnostic = [Number.isInteger(status) && status >= 100 && status <= 599 ? `HTTP ${status}` : '',
    event === 'response.failed' || event === 'error' ? `事件 ${event}` : root.status === 'failed' ? '响应状态 failed' : '',
    upstreamCode, parameter ? `参数 ${parameter}` : ''].filter(Boolean).join('；');
  const fail = (code: string, message: string, localStatus = 400) => new ModelError(code, `${message}${diagnostic ? `（${diagnostic}）` : ''}`, localStatus);
  if (status === 401 || status === 403 || /invalid_api_key|authentication_error|permission_denied/.test(hint)) return fail('MODEL_AUTH_FAILED', '模型服务鉴权失败或没有访问权限，请检查 API Key、账号权限和模型名称');
  if (status === 429 || /rate_limit_exceeded|insufficient_quota/.test(hint)) return fail('MODEL_RATE_LIMITED', '模型服务限流或额度不足，请稍后重试并检查服务额度', 429);
  if (status >= 500 || /server_error|service_unavailable|overloaded_error/.test(hint)) return fail('MODEL_SERVICE_UNAVAILABLE', '模型服务暂时异常，请稍后重试', 503);
  if (/model.{0,30}(not.?found|does not exist|permission)|model_not_found/.test(hint)) return fail('MODEL_NOT_FOUND', '模型不存在或账号无权使用，请核对手填的模型名称');
  if (status === 404) return fail('MODEL_ENDPOINT_NOT_FOUND', '模型或接口地址不存在，请检查最终请求地址、协议和模型名称');
  if (/invalid codex request/.test(hint)) return fail('MODEL_GATEWAY_REJECTED', '服务返回 invalid codex request，拒绝了当前 Responses 请求。该服务有额外的 Codex 请求校验，请确认它是否支持第三方应用调用');
  if (/stream_required|stream.{0,35}(must|require).{0,20}true|stream.{0,20}must be enabled/.test(hint)) return fail('MODEL_STREAM_REQUIRED', '服务要求流式请求，请启用流式输出、保存配置后重新验证');
  if (/(image|vision|tool|function|stream)/.test(hint) && /(not.support|unsupported|invalid|unknown|not.allow)/.test(hint)) {
    if (/tool|function/.test(hint)) return fail('MODEL_TOOLS_UNSUPPORTED', '服务不支持此次工具调用，可使用文字整理的固定流程');
    if (/image|vision/.test(hint)) return fail('MODEL_VISION_UNSUPPORTED', '服务不支持此次图片理解，可继续使用已有文字和用户图注');
    if (/stream/.test(hint)) return fail('MODEL_STREAM_UNSUPPORTED', '服务不支持此次流式输出，可使用普通响应');
  }
  if (parameter && /unsupported|not.support|unknown parameter|unrecognized|not.allow/.test(hint)) return fail('MODEL_PARAMETER_UNSUPPORTED', `服务不接受 ${parameter} 参数，请核对该兼容接口的参数要求`);
  if (status >= 200 && status < 300) return fail('MODEL_GENERATION_FAILED', '模型服务已建立连接，但在生成期间返回错误，未能完成本次生成；请稍后重试，持续失败时检查模型服务状态', 502);
  return fail('MODEL_REQUEST_REJECTED', '模型服务未接受请求，请检查所选兼容协议、模型与输出长度限制');
}

/** Bound both JSON and SSE responses. Never include upstream response bodies in diagnostics. */
async function textBody(response: Response, max = 8 * 1024 * 1024): Promise<string> {
  if (!response.body) throw invalidResponse();
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  let result = ''; let size = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.length;
      if (size > max) { await reader.cancel(); throw invalidResponse('模型响应超过本应用的大小上限，请减少输出长度'); }
      result += decoder.decode(next.value, { stream: true });
    }
    return result + decoder.decode();
  } finally { reader.releaseLock(); }
}
export async function readJson(response: Response) {
  try { return JSON.parse(await textBody(response)); } catch (error) { if (error instanceof AppError) throw error; throw invalidResponse(); }
}

export async function modelHttp<T>(profile: ModelProfile, key: string | null, body: unknown | undefined, signal: AbortSignal | undefined, reader: (response: Response) => Promise<T>, url = profile.endpointUrl): Promise<T> {
  const timeout = AbortSignal.timeout(profile.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: combined,
      headers: { Accept: body && object(body).stream ? 'text/event-stream' : 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      let errorBody: unknown; try { errorBody = JSON.parse(await textBody(response, 512000)); } catch { /* Only a fixed error category is returned. */ }
      throw withModelUsage(serviceError(response.status, errorBody), usage(object(errorBody).usage, profile.protocol === 'responses' ? 'responses' : 'chat'));
    }
    return await reader(response);
  } catch (error) {
    const tokenUsage = error instanceof ModelError ? error.usage : null;
    if (timeout.aborted && !signal?.aborted) throw new ModelError('MODEL_TIMEOUT', '模型请求超时，可以调整请求超时或减少本次素材后重试', 408, tokenUsage);
    if (signal?.aborted) throw new ModelError('MODEL_CANCELLED', '模型请求已取消', 409, tokenUsage);
    if (error instanceof AppError) throw error;
    throw new ModelError('MODEL_NETWORK_ERROR', '无法连接模型服务，请检查地址、网络或本地模型服务是否已启动', 503);
  }
}

/** SSE framing supports UTF-8 fragments, CRLF, multiline data, comments and terminal markers. */
export async function readSse(response: Response, onEvent: (data: unknown, event: string) => void | boolean): Promise<void> {
  if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) throw new ModelError('MODEL_CAPABILITY_UNSUPPORTED', '服务没有返回有效的 SSE 流式响应', 400);
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  let buffer = ''; let size = 0;
  const consume = (frame: string): boolean => {
    const lines = frame.split(/\r?\n/);
    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) return true;
    const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim() ?? '';
    if (data === '[DONE]') { onEvent('[DONE]', event); return false; }
    let value: unknown; try { value = JSON.parse(data); } catch { throw invalidResponse('流式事件不是有效 JSON，无法确认生成已完成'); }
    return onEvent(value, event) !== false;
  };
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.length;
      if (size > 8 * 1024 * 1024) throw invalidResponse('流式响应超过大小上限');
      buffer += decoder.decode(next.value, { stream: true });
      let boundary: RegExpMatchArray | null;
      while ((boundary = buffer.match(/\r?\n\r?\n/))) {
        if (!consume(buffer.slice(0, boundary.index))) return;
        buffer = buffer.slice(boundary.index! + boundary[0].length);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) throw invalidResponse('流式连接在完整事件结束前中断，请重试');
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
