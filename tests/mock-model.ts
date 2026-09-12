/** Deterministic LOCAL TEST SERVER. It does not perform real model inference. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

type Json = Record<string, any>;
type WireCall = { id: string; name: string; arguments: string };
export type MockModelRequest = { method: string; path: string; headers: IncomingMessage['headers']; body: Json };
const obj = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const parse = (value: unknown): any => { try { return JSON.parse(String(value)); } catch { return null; } };
const writeJson = (res: ServerResponse, value: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };

function normalizeRequest(body: Json, responses: boolean) {
  const input: Json[] = responses ? body.input ?? [] : body.messages ?? [];
  const messages = input.map(item => {
    if (item.type === 'function_call_output') return { role: 'tool', text: String(item.output), callId: item.call_id, images: [] as string[] };
    const content = item.content;
    return { role: item.role, text: typeof content === 'string' ? content : Array.isArray(content) ? content.filter(part => ['input_text', 'text', 'output_text'].includes(part.type)).map(part => part.text).join('') : '',
      images: Array.isArray(content) ? content.flatMap(part => part.type === 'input_image' ? [part.image_url] : part.type === 'image_url' ? [part.image_url?.url] : []).filter((url): url is string => typeof url === 'string') : [],
      callId: item.tool_call_id };
  });
  const calls: WireCall[] = responses ? input.filter(item => item.type === 'function_call').map(item => ({ id: item.call_id, name: item.name, arguments: item.arguments })) : input.flatMap(item => item.tool_calls ?? []).map(call => ({ id: call.id, name: call.function?.name, arguments: call.function?.arguments }));
  const toolNames: string[] = (body.tools ?? []).map((tool: Json) => responses ? tool.name : tool.function?.name);
  const toolResults = messages.filter(message => message.role === 'tool').map(message => ({ ...message, name: calls.find(call => call.id === message.callId)?.name, data: parse(message.text) }));
  return { input, messages, calls, toolNames, toolResults };
}
function trailingJson(text: string): any {
  // Production prompts append a JSON material array; parse only complete JSON suffixes.
  for (let i = 0, tries = 0; i < text.length && tries < 300; i++) if (text[i] === '[' || text[i] === '{') {
    tries++; const value = parse(text.slice(i)); if (value) return value;
  }
  return null;
}
function materialFrom(body: ReturnType<typeof normalizeRequest>) {
  const records: Json[] = [];
  for (const message of body.messages) {
    const parsed = trailingJson(message.text);
    if (Array.isArray(parsed)) records.push(...parsed);
    else if (Array.isArray(parsed?.records)) records.push(...parsed.records);
  }
  for (const result of body.toolResults) if (result.name === 'get_records' && Array.isArray(result.data?.records)) records.push(...result.data.records);
  return records;
}
function draftFor(records: Json[], prompt: string): Json {
  const found = records.filter(record => typeof record.id === 'string');
  const sourceParagraphs = records.flatMap(record => Array.isArray(record.paragraphs) ? record.paragraphs : []);
  const paragraphs = found.length ? found.slice(0, 10).map(record => ({ text: record.body || record.title || record.media?.[0]?.caption || '这次留下了一张照片。', sourceRecordIds: [record.id] })) : sourceParagraphs.slice(0, 2);
  const photos = found.flatMap(record => (record.media ?? []).map((photo: Json) => ({ mediaId: photo.id, caption: photo.caption ?? '', sourceRecordIds: [record.id] }))).filter((photo, i, all) => all.findIndex(other => other.mediaId === photo.mediaId) === i).slice(0, 8);
  const onlyTitle = prompt.includes('仅填写 title');
  const questions = prompt.includes('给出一到两个') ? ['还有哪一句原话想留下？', '当时的场景有没有想补记的细节？'] : [];
  return { title: '本机模拟整理', paragraphs: onlyTitle || questions.length ? [] : paragraphs, highlights: prompt.includes('highlights 写几件') ? paragraphs.slice(0, 3) : [], questions,
    photos: onlyTitle || questions.length || prompt.includes('完整保留原意') ? [] : photos, chapters: [] };
}
function error(res: ServerResponse, status: number, code: string, message: string, param?: string) { writeJson(res, { error: { code, message, type: code, ...(param ? { param } : {}) } }, status); }
function wireResult(text: string, calls: WireCall[], responses: boolean, model: string) {
  if (responses) return { id: `resp_${randomUUID()}`, status: model === 'truncated' ? 'incomplete' : 'completed',
    output: calls.length ? [{ type: 'reasoning', id: 'rs_mock', summary: [], encrypted_content: 'mock-encrypted-reasoning-state' }, ...calls.map(call => ({ type: 'function_call', id: `fc_${call.id}`, call_id: call.id, name: call.name, arguments: call.arguments, status: 'completed' }))] : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }],
    ...(model === 'no-usage' ? {} : { usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 } }) };
  return { id: `chatcmpl_${randomUUID()}`, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: text || null,
    ...(calls.length ? { tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) } : {}) }, finish_reason: model === 'truncated' ? 'length' : calls.length ? 'tool_calls' : 'stop' }],
    ...(model === 'no-usage' ? {} : { usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } }) };
}
async function streamResult(res: ServerResponse, text: string, calls: WireCall[], responses: boolean, model: string) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
  const frames: string[] = [': local mock stream\r\n\r\n'];
  const event = (name: string, value: unknown) => frames.push(`event: ${name}\r\ndata: ${JSON.stringify(value)}\r\n\r\n`);
  if (responses) {
    if (text) for (const delta of [text.slice(0, 1), text.slice(1)]) event('response.output_text.delta', { type: 'response.output_text.delta', delta });
    calls.forEach((call, index) => {
      event('response.output_item.added', { type: 'response.output_item.added', output_index: index + 1, item: { type: 'function_call', call_id: call.id, name: call.name, arguments: '' } });
      event('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', output_index: index + 1, delta: call.arguments });
    });
    if (model !== 'stream-cutoff') event(model === 'truncated' ? 'response.incomplete' : 'response.completed', { type: model === 'truncated' ? 'response.incomplete' : 'response.completed', response: wireResult(text, calls, true, model) });
  } else {
    if (text) for (const delta of [text.slice(0, 1), text.slice(1)]) event('message', { choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] });
    calls.forEach((call, index) => {
      const split = Math.max(1, Math.floor(call.arguments.length / 2));
      event('message', { choices: [{ index: 0, delta: { tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments.slice(0, split) } }] }, finish_reason: null }] });
      event('message', { choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: call.arguments.slice(split) } }] }, finish_reason: null }] });
    });
    if (model !== 'stream-cutoff') {
      event('message', { choices: [{ index: 0, delta: {}, finish_reason: model === 'truncated' ? 'length' : calls.length ? 'tool_calls' : 'stop' }] });
      if (model !== 'no-usage') event('message', { choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } });
      frames.push('data: [DONE]\r\n\r\n');
    }
  }
  const bytes = Buffer.from(frames.join(''), 'utf8');
  // Split an arbitrary UTF-8 byte boundary as well as SSE framing boundaries.
  for (const [start, end] of [[0, 13], [13, 83], [83, 84], [84, bytes.length]]) {
    if (res.destroyed) return; res.write(bytes.subarray(start, end));
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  res.end();
}

export async function startMockModel() {
  const requests: MockModelRequest[] = []; const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    void (async () => {
      let payload = ''; for await (const bytes of req) { payload += bytes; if (payload.length > 5 * 1024 * 1024) return error(res, 413, 'too_large', 'Mock request too large'); }
      const body = obj(parse(payload)); const path = req.url?.split('?')[0] ?? '/';
      requests.push({ method: req.method ?? '', path, headers: { ...req.headers }, body });
      if (req.method === 'GET' && path.endsWith('/models')) {
        if (path.includes('no-models')) return error(res, 404, 'not_supported', 'Model listing not supported');
        return writeJson(res, { data: ['mock-all', 'no-tools', 'no-vision', 'no-stream', 'unauthorized', 'absent', 'limited', 'unavailable', 'malformed', 'timeout'].map(id => ({ id, object: 'model' })) });
      }
      if (req.method !== 'POST' || !/\/(responses|chat\/completions)$/.test(path)) return error(res, 404, 'not_found', 'Unknown mock route');
      const responses = path.endsWith('/responses'); const model = String(body.model ?? '');
      if (model === 'unauthorized') return error(res, 401, 'invalid_api_key', `Authorization echoed only by test server: ${req.headers.authorization ?? 'none'}`);
      if (model === 'absent') return error(res, 404, 'model_not_found', 'Model does not exist or permission denied');
      if (model === 'limited') return error(res, 429, 'rate_limit_exceeded', 'Too many requests');
      if (model === 'unavailable') return error(res, 503, 'server_error', 'Temporarily unavailable');
      if (model === 'malformed') return writeJson(res, { not_a_supported_response: true });
      if (model === 'timeout') { res.writeHead(200, { 'Content-Type': 'application/json' }); return; }
      const normalized = normalizeRequest(body, responses); const imageUrls = normalized.messages.flatMap(message => message.images);
      if (model === 'no-tools' && normalized.toolNames.length) return error(res, 400, 'unsupported_parameter', 'Tools are not supported', 'tools');
      if (model === 'no-vision' && imageUrls.length) return error(res, 400, 'unsupported_parameter', 'Image input is unsupported', 'input_image');
      if (model === 'no-stream' && body.stream) return error(res, 400, 'unsupported_parameter', 'Stream is unsupported', 'stream');
      let text = '连接成功'; let calls: WireCall[] = [];
      const prompt = normalized.messages.filter(message => message.role === 'user').map(message => message.text).join('\n');
      if (normalized.toolNames.includes('yearbook_probe') && model !== 'ignore-tools') {
        const returned = normalized.toolResults.find(result => result.data?.receipt);
        if (returned) {
          if (responses && !normalized.input.some(item => item.type === 'reasoning' && item.encrypted_content === 'mock-encrypted-reasoning-state')) return error(res, 400, 'missing_reasoning', 'Missing reasoning continuation');
          text = model === 'broken-tool-roundtrip' ? 'wrong receipt' : returned.data.receipt;
        } else {
          const token = prompt.match(/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}/i)?.[0] ?? '';
          calls = [{ id: `call_${randomUUID()}`, name: 'yearbook_probe', arguments: JSON.stringify({ token }) }]; text = '';
        }
      } else if (normalized.toolNames.includes('search_records')) {
        const latest = normalized.toolResults.at(-1);
        const make = (name: string, args: unknown) => { calls = [{ id: `call_${randomUUID()}`, name, arguments: JSON.stringify(args) }]; text = ''; };
        if (!latest) make('search_records', { q: null, year: null, month: null, person: null, tag: null, firstOnly: false, limit: 20, offset: 0 });
        else if (latest.name === 'search_records' && latest.data?.records?.length) make('get_records', { recordIds: latest.data.records.slice(0, 8).map((record: Json) => record.id), offset: 0 });
        else if (latest.name === 'get_records' && latest.data?.records?.some((record: Json) => record.media?.length)) make('get_selected_media', { mediaIds: latest.data.records.flatMap((record: Json) => record.media.map((media: Json) => media.id)).slice(0, 20) });
        else make('create_summary_draft', { content: draftFor(materialFrom(normalized), prompt) });
      } else if (imageUrls.length && prompt.includes('单一填充的颜色')) {
        if (model === 'wrong-vision') text = '紫色';
        else {
          const bytes = Buffer.from(imageUrls[0].split(',')[1], 'base64');
          const { data } = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
          text = data[0] > data[1] && data[0] > data[2] ? '红色' : data[1] > data[2] ? '绿色' : '蓝色';
        }
      } else {
        const material = materialFrom(normalized);
        if (material.length) text = JSON.stringify(draftFor(material, prompt));
      }
      if (body.stream) await streamResult(res, text, calls, responses, model);
      else writeJson(res, wireResult(text, calls, responses, model));
    })().catch(() => { if (!res.headersSent) error(res, 500, 'mock_error', 'Local mock could not parse this request'); else res.destroy(); });
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Mock server address unavailable');
  const url = `http://127.0.0.1:${address.port}/prefix/v1`;
  return { url, requests, async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const mock = await startMockModel();
  process.stdout.write(JSON.stringify({ url: mock.url }) + '\n');
  const stop = () => { void mock.close().finally(() => process.exit(0)); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
