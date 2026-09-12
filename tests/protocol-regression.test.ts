/** Local wire-level regressions. No database, files, credentials, or external model service. */
import { randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeModelUrl, unknownCapabilities, type ModelProfile, type ModelProtocol, type ModelRequest } from '@yearbook/shared';
import { generateChat } from '../apps/server/src/models/chat.js';
import { generateResponses } from '../apps/server/src/models/responses.js';

const text = '本机协议回归：文字已经完整生成。';
const partialText = '这段尚未完成的文字不能作为成功结果交给草稿保存。';
const expectedUsage = { inputTokens: 11, outputTokens: 7, totalTokens: 18 };
const responsesUsage = { input_tokens: 11, output_tokens: 7, total_tokens: 18 };
const request: ModelRequest = { system: '只用于本机回归测试', messages: [{ role: 'user', text: '回复测试文字。' }] };
const sse = (type: string, value: unknown) => `event: ${type}\r\ndata: ${JSON.stringify(value)}\r\n\r\n`;
const responseValue = (status = 'completed', body = text, extra: Record<string, unknown> = {}) => ({
  id: `resp_${randomUUID()}`, object: 'response', status,
  output: [{ type: 'message', role: 'assistant', status: status === 'completed' ? 'completed' : 'incomplete', content: [{ type: 'output_text', text: body, annotations: [] }] }],
  usage: responsesUsage, ...extra,
});
const sendJson = (response: ServerResponse, value: unknown) => {
  response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
};
const sendSse = (response: ServerResponse, frames: string, keepOpen = false) => {
  response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
  response.write(frames);
  if (!keepOpen) response.end();
};

describe('模型协议完成与错误边界回归', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });

  async function fixture(handler: (response: ServerResponse) => void) {
    const sockets = new Set<Socket>();
    const requests: { path: string; body: Record<string, unknown> }[] = [];
    const server = createServer((incoming, outgoing) => {
      void (async () => {
        let payload = '';
        for await (const bytes of incoming) payload += bytes;
        requests.push({ path: incoming.url ?? '', body: JSON.parse(payload) as Record<string, unknown> });
        handler(outgoing);
      })().catch(error => outgoing.destroy(error instanceof Error ? error : undefined));
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    cleanups.push(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('测试服务未获得本机端口');
    const baseUrl = `http://127.0.0.1:${address.port}/regression/v1`;
    const profile = (protocol: ModelProtocol): ModelProfile => ({
      id: randomUUID(), name: '仅内存中的协议测试配置', protocol, ...normalizeModelUrl(baseUrl, protocol), model: 'protocol-regression',
      timeoutMs: 1000, maxOutputTokens: 4096, streamEnabled: true, credentialMode: 'none', keyPresent: false, isActive: true,
      capabilities: unknownCapabilities(), createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    });
    return { profile, requests };
  }

  for (const protocol of ['responses', 'chat-completions'] as const) {
    it(`${protocol} 收到完成标记即成功并关闭读取，不等待网关结束 HTTP 连接`, async () => {
      let outgoing: ServerResponse | undefined;
      const server = await fixture(response => {
        outgoing = response;
        const frames = protocol === 'responses'
          ? sse('response.output_text.delta', { type: 'response.output_text.delta', delta: text })
            + sse('response.output_text.done', { type: 'response.output_text.done', text })
            + sse('response.completed', { type: 'response.completed', response: responseValue() })
          : sse('message', { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })
            + sse('message', { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
            // Usage arrives after finish_reason, so stopping at that earlier event would lose it.
            + sse('message', { choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } })
            + 'data: [DONE]\r\n\r\n';
        sendSse(response, frames, true);
      });
      const deltas: string[] = [];
      const generate = protocol === 'responses' ? generateResponses : generateChat;
      const result = await generate(server.profile(protocol), null, { ...request, stream: true, onDelta: delta => deltas.push(delta) });
      expect(result.text).toBe(text); expect(deltas.join('')).toBe(text); expect(result.toolCalls).toEqual([]);
      expect(result.usage).toEqual(expectedUsage);
      expect(server.requests).toHaveLength(1); expect(server.requests[0].body.stream).toBe(true);
      expect(server.requests[0].path).toBe(`/regression/v1/${protocol === 'responses' ? 'responses' : 'chat/completions'}`);
      expect(outgoing?.writableEnded).toBe(false);
      await expect.poll(() => outgoing?.destroyed, { timeout: 1000 }).toBe(true);
    });

    it(`${protocol} 有文字但缺少协议完成标记时，连接关闭也不能作为成功`, async () => {
      const server = await fixture(response => sendSse(response, protocol === 'responses'
        ? sse('response.output_text.delta', { type: 'response.output_text.delta', delta: partialText })
        : sse('message', { choices: [{ index: 0, delta: { content: partialText }, finish_reason: null }] })
          + sse('message', { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })));
      const generate = protocol === 'responses' ? generateResponses : generateChat;
      await expect(generate(server.profile(protocol), null, { ...request, stream: true })).rejects.toMatchObject({ code: 'MODEL_RESPONSE_INVALID', usage: null });
    });
  }

  it('Responses 顶层 SSE error 的限流码有明确分类，不依赖不存在的 error 包装', async () => {
    const server = await fixture(response => sendSse(response, sse('error', {
      type: 'error', code: 'rate_limit_exceeded', param: null, message: 'Synthetic rate limit from local regression server',
    })));
    await expect(generateResponses(server.profile('responses'), null, { ...request, stream: true })).rejects.toMatchObject({ code: 'MODEL_RATE_LIMITED', usage: null });
  });

  it('HTTP 200 中未分类的 SSE error 明确为生成失败，保留事件类型且不回显上游内容', async () => {
    const privateMessage = `DO-NOT-ECHO-${randomUUID()}`;
    const server = await fixture(response => sendSse(response, sse('error', { type: 'error', code: privateMessage, message: privateMessage })));
    const failure = await generateResponses(server.profile('responses'), null, { ...request, stream: true }).then(
      () => { throw new Error('明确的错误事件不能作为生成成功'); }, error => error as { code: string; message: string },
    );
    expect(failure.code).toBe('MODEL_GENERATION_FAILED');
    expect(failure.message).toContain('HTTP 200'); expect(failure.message).toContain('事件 error');
    expect(failure.message).not.toContain('检查所选兼容协议'); expect(failure.message).not.toContain(privateMessage);
  });

  for (const stream of [false, true]) {
    const mode = stream ? '流式' : '普通';

    for (const [label, error] of [['空对象', {}], ['错误字段为 null', { code: null, message: null }]] as const) {
      it(`Responses ${mode} completed 带${label} error 时仍返回完整文字和实际用量`, async () => {
        const value = responseValue('completed', text, { error });
        const server = await fixture(response => stream
          ? sendSse(response, sse('response.completed', { type: 'response.completed', response: value }))
          : sendJson(response, value));
        const result = await generateResponses(server.profile('responses'), null, { ...request, stream });
        expect(result.text).toBe(text); expect(result.toolCalls).toEqual([]); expect(result.usage).toEqual(expectedUsage);
        expect(server.requests).toHaveLength(1);
      });

      it(`Responses ${mode} 明确 failed 即使 error 为${label}也必须拒绝`, async () => {
        const value = responseValue('failed', partialText, { error });
        const server = await fixture(response => stream
          ? sendSse(response, sse('response.failed', { type: 'response.failed', response: value }))
          : sendJson(response, value));
        await expect(generateResponses(server.profile('responses'), null, { ...request, stream })).rejects.toMatchObject({
          code: expect.stringMatching(/^MODEL_/), usage: expectedUsage,
        });
      });
    }

    it(`Responses ${mode} completed 带明确非空 error 时不能因存在文字而成功`, async () => {
      const value = responseValue('completed', partialText, {
        error: { code: 'unsupported_parameter', message: 'Unsupported parameter max_output_tokens', param: 'max_output_tokens' },
      });
      const server = await fixture(response => stream
        ? sendSse(response, sse('response.completed', { type: 'response.completed', response: value }))
        : sendJson(response, value));
      await expect(generateResponses(server.profile('responses'), null, { ...request, stream })).rejects.toMatchObject({ code: 'MODEL_PARAMETER_UNSUPPORTED', usage: expectedUsage });
    });

    it(`Responses HTTP 200 ${mode} failed/server_error 归为服务故障并保留实际用量`, async () => {
      const value = responseValue('failed', partialText, { error: { code: 'server_error', message: 'Synthetic service failure' } });
      const server = await fixture(response => stream
        ? sendSse(response, sse('response.failed', { type: 'response.failed', response: value }))
        : sendJson(response, value));
      await expect(generateResponses(server.profile('responses'), null, { ...request, stream })).rejects.toMatchObject({ code: 'MODEL_SERVICE_UNAVAILABLE', usage: expectedUsage });
    });

    for (const [status, code] of [['cancelled', 'MODEL_CANCELLED'], ['in_progress', 'MODEL_RESPONSE_INVALID']] as const) {
      it(`Responses ${mode} ${status} 的部分文字不能返回成功结果供草稿保存`, async () => {
        const value = responseValue(status, partialText);
        const server = await fixture(response => stream
          // Even a gateway-labelled completion must not override the response object's unfinished status.
          ? sendSse(response, sse('response.completed', { type: 'response.completed', response: value }))
          : sendJson(response, value));
        await expect(generateResponses(server.profile('responses'), null, { ...request, stream })).rejects.toMatchObject({ code, usage: expectedUsage });
      });
    }

    it(`Responses ${mode} incomplete/content_filter 明确拒绝，不误导用户增加输出长度`, async () => {
      const value = responseValue('incomplete', partialText, { incomplete_details: { reason: 'content_filter' } });
      const server = await fixture(response => stream
        ? sendSse(response, sse('response.incomplete', { type: 'response.incomplete', response: value }))
        : sendJson(response, value));
      const failure = await generateResponses(server.profile('responses'), null, { ...request, stream }).then(
        () => { throw new Error('过滤导致未完成的响应不应成功'); }, error => error as { code: string; message: string; usage: unknown },
      );
      expect(failure).toMatchObject({ code: 'MODEL_REFUSED', usage: expectedUsage });
      expect(failure.message).not.toMatch(/提高|增加|长度限制/); expect(failure.message).not.toContain(partialText);
    });
  }

  it('Responses 明确 response.failed 事件不能被嵌套 completed 与空 error 覆盖', async () => {
    const value = responseValue('completed', partialText, { error: {} });
    const server = await fixture(response => sendSse(response, sse('response.failed', { type: 'response.failed', response: value })));
    await expect(generateResponses(server.profile('responses'), null, { ...request, stream: true })).rejects.toMatchObject({
      code: expect.stringMatching(/^MODEL_/), usage: expectedUsage,
    });
  });
});
