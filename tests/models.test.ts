import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  modelProfileInputSchema, normalizeModelUrl, type AiAdoptResult, type AiDraftItem, type AiDraftList,
  type ModelCapability, type ModelProfile, type ModelProfileInput, type ModelProfileList, type ModelProtocol,
  type ModelRequest, type RecordItem, type TaskItem, type YearbookItem, type YearbookVersion,
} from '@yearbook/shared';
import { DataStore, DATABASE_NAME } from '../apps/server/src/db.js';
import { createBackup } from '../apps/server/src/backups.js';
import { createApp } from '../apps/server/src/app.js';
import { CredentialVault, type CredentialDriver } from '../apps/server/src/models/credentials.js';
import { ModelService } from '../apps/server/src/models/service.js';
import { serviceError } from '../apps/server/src/models/transport.js';
import { startMockModel } from './mock-model.js';
import { backup, json, photo, record, restore, upload } from './helpers.js';

class FakeCredentials implements CredentialDriver {
  values = new Map<string, string>();
  failWrite = false;
  async read(ref: string) { return this.values.get(ref) ?? null; }
  async write(ref: string, secret: string) { if (this.failWrite) throw new Error('Synthetic credential driver failure'); this.values.set(ref, secret); }
  async remove(ref: string) { this.values.delete(ref); }
}
const plainRequest: ModelRequest = { system: '仅本机模拟接口测试', messages: [{ role: 'user', text: '请只回复：连接成功' }] };
const toInput = (profile: ModelProfile, overrides: Partial<ModelProfileInput> = {}) => modelProfileInputSchema.parse({
  name: profile.name, protocol: profile.protocol, baseUrl: profile.baseUrl, model: profile.model, timeoutMs: profile.timeoutMs,
  maxOutputTokens: profile.maxOutputTokens, streamEnabled: profile.streamEnabled, credentialMode: profile.credentialMode, ...overrides,
});
async function completed(app: FastifyInstance, id: string) {
  const started = Date.now(); let task: TaskItem;
  do {
    task = await json<TaskItem>(app, 'GET', `/api/tasks/${id}`);
    if (['completed', 'failed', 'cancelled'].includes(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() - started < 5000);
  throw new Error('本机模拟 AI 任务未在 5 秒内结束');
}

describe('双协议本机 HTTP 模拟与模型配置', () => {
  let root: string; let store: DataStore; let service: ModelService; let driver: FakeCredentials; let vault: CredentialVault;
  let mock: Awaited<ReturnType<typeof startMockModel>>; let apps: FastifyInstance[];
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), '一年一册 模型 HTTP ')); store = new DataStore(join(root, '模型 测试'));
    mock = await startMockModel(); driver = new FakeCredentials(); vault = new CredentialVault(driver); service = new ModelService(store, vault); apps = [];
  });
  afterEach(async () => { for (const app of apps) await app.close(); await service.shutdown(); await store.close(); await mock.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }); });
  const createProfile = (protocol: ModelProtocol, model = 'mock-all', overrides: Partial<ModelProfileInput> = {}) => service.save(modelProfileInputSchema.parse({ name: `模拟 ${protocol} ${model}`, protocol, baseUrl: mock.url, model, ...overrides }));
  async function openApp(name: string) { const app = await createApp({ dataDir: join(root, name), credentialVault: new CredentialVault(new FakeCredentials()) }); apps.push(app); await app.ready(); return app; }

  it('地址前缀、完整接口与服务根路径规范化可重复执行，不自动拼重复 /v1', () => {
    for (const [raw, protocol, expected] of [
      ['http://localhost:1234/proxy/v1/responses/', 'responses', 'http://localhost:1234/proxy/v1/responses'],
      ['http://localhost:1234/proxy/v1/chat/completions', 'responses', 'http://localhost:1234/proxy/v1/responses'],
      ['http://localhost:1234/proxy/v1/responses', 'chat-completions', 'http://localhost:1234/proxy/v1/chat/completions'],
      ['http://localhost:1234/responses', 'responses', 'http://localhost:1234/responses'],
      ['http://localhost:1234/', 'chat-completions', 'http://localhost:1234/chat/completions'],
      ['http://localhost:1234/v1', 'responses', 'http://localhost:1234/v1/responses'],
    ] as const) {
      const normalized = normalizeModelUrl(raw, protocol); expect(normalized.endpointUrl).toBe(expected);
      expect(normalizeModelUrl(normalized.baseUrl, protocol)).toEqual(normalized);
      expect(normalizeModelUrl(normalized.endpointUrl, protocol)).toEqual(normalized);
    }
    for (const raw of ['garbage', 'file:///C:/secret', 'http://user:password@localhost/v1', 'http://localhost/v1?key=secret', 'http://localhost/v1#key', 'http://localhost/responses/responses']) expect(() => normalizeModelUrl(raw, 'responses')).toThrow();
  });

  for (const protocol of ['responses', 'chat-completions'] as const) {
    it(`${protocol} 按前缀与所选模型路由；文本成功不推断其他能力`, async () => {
      const profile = await createProfile(protocol, 'mock-all', { baseUrl: `${mock.url}/${protocol === 'responses' ? 'responses' : 'chat/completions'}`, maxOutputTokens: 1536 });
      const result = await service.test(profile.id, 'text');
      expect(result.result.status).toBe('supported');
      expect(result.result.checkedAt).toMatch(/^\d{4}-/);
      for (const capability of ['vision', 'tools', 'streaming'] as const) expect(result.profile.capabilities[capability].status).toBe('unknown');
      const sent = mock.requests.at(-1)!;
      expect(sent.path).toBe(`/prefix/v1/${protocol === 'responses' ? 'responses' : 'chat/completions'}`);
      expect(sent.body.model).toBe('mock-all'); expect(sent.body.store).toBe(false);
      if (protocol === 'responses') { expect(sent.body.max_output_tokens).toBe(1536); expect(sent.body.max_completion_tokens).toBeUndefined(); expect(sent.body.instructions).toContain('连接能力测试'); expect(sent.body.include).toBeUndefined(); }
      else { expect(sent.body.max_completion_tokens).toBe(1536); expect(sent.body.max_output_tokens).toBeUndefined(); expect(sent.body.messages[0].role).toBe('system'); }
    });

    it(`${protocol} 配置变更后拒绝旧任务版本，不发送请求或把内部版本字段交给模型`, async () => {
      const original = await createProfile(protocol);
      const changed = await service.save(toInput(original, { model: 'no-tools', baseUrl: `${mock.url}/changed` }), original.id);
      expect(Date.parse(changed.updatedAt)).toBeGreaterThan(Date.parse(original.updatedAt));
      const count = mock.requests.length;
      await expect(service.generate(original.id, { ...plainRequest, expectedProfileUpdatedAt: original.updatedAt })).rejects.toMatchObject({ code: 'MODEL_CONFIG_CHANGED' });
      expect(mock.requests).toHaveLength(count);
      const result = await service.generate(changed.id, { ...plainRequest, expectedProfileUpdatedAt: changed.updatedAt });
      expect(result.text).toBe('连接成功');
      const sent = mock.requests.at(-1)!;
      expect(sent.path).toBe(`/prefix/v1/changed/${protocol === 'responses' ? 'responses' : 'chat/completions'}`);
      expect(sent.body.model).toBe('no-tools'); expect(sent.body.expectedProfileUpdatedAt).toBeUndefined();
      expect(JSON.stringify(sent.body)).not.toContain(changed.updatedAt);
    });

    it(`${protocol} 随机颜色图片与工具调用分别验证，并完成真实工具结果往返`, async () => {
      const profile = await createProfile(protocol);
      const vision = await service.test(profile.id, 'vision'); expect(vision.result.status).toBe('supported');
      expect(vision.profile.capabilities.tools.status).toBe('unknown'); expect(vision.profile.capabilities.text.status).toBe('unknown');
      const tools = await service.test(profile.id, 'tools'); expect(tools.result.status).toBe('supported');
      expect(tools.profile.capabilities.vision.status).toBe('supported');
      const toolRequests = mock.requests.filter(request => request.body.tools);
      expect(toolRequests).toHaveLength(2);
      const first = toolRequests[0].body; const second = toolRequests[1].body;
      if (protocol === 'responses') {
        expect(first.tools[0].name).toBe('yearbook_probe'); expect(first.tools[0].function).toBeUndefined();
        const call = second.input.find((item: any) => item.type === 'function_call');
        const returned = second.input.find((item: any) => item.type === 'function_call_output');
        expect(call.call_id).toBe(returned.call_id); expect(JSON.parse(returned.output).receipt).toMatch(/^probe-/);
        expect(second.input.find((item: any) => item.type === 'reasoning').encrypted_content).toBe('mock-encrypted-reasoning-state');
      } else {
        expect(first.tools[0].function.name).toBe('yearbook_probe');
        const assistant = second.messages.find((message: any) => message.tool_calls?.length);
        const returned = second.messages.find((message: any) => message.role === 'tool');
        expect(assistant.tool_calls[0].id).toBe(returned.tool_call_id); expect(JSON.parse(returned.content).receipt).toMatch(/^probe-/);
      }
    });

    it(`${protocol} 流式增量、完整结束、工具参数片段和实际用量解析正确`, async () => {
      const profile = await createProfile(protocol, 'mock-all', { streamEnabled: true });
      const checked = await service.test(profile.id, 'streaming'); expect(checked.result.status).toBe('supported');
      const deltas: string[] = []; const result = await service.generate(profile.id, { ...plainRequest, stream: true, onDelta: text => deltas.push(text) });
      expect(deltas.join('')).toBe('连接成功'); expect(deltas.length).toBeGreaterThan(1); expect(result.text).toBe('连接成功');
      expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 7, totalTokens: 18 });
      const token = randomUUID();
      const tool = await service.generate(profile.id, { system: '本机模拟流式工具测试', stream: true,
        messages: [{ role: 'user', text: `请调用 yearbook_probe，token 为 ${token}` }], tools: [{ name: 'yearbook_probe', description: '本机探测', parameters: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'], additionalProperties: false } }] });
      expect(tool.toolCalls).toHaveLength(1); expect(JSON.parse(tool.toolCalls[0].arguments)).toEqual({ token });
      if (protocol === 'chat-completions') expect(mock.requests.at(-1)?.body.stream_options.include_usage).toBe(true);
    });

    it(`${protocol} 缺少能力或假接受图片/工具时不误报支持`, async () => {
      for (const [model, capability] of [['no-tools', 'tools'], ['ignore-tools', 'tools'], ['broken-tool-roundtrip', 'tools'], ['no-vision', 'vision'], ['wrong-vision', 'vision'], ['no-stream', 'streaming']] as const) {
        let profile = await createProfile(protocol, model, { streamEnabled: capability !== 'streaming' });
        const text = await service.test(profile.id, 'text'); expect(text.result.status).toBe('supported');
        if (capability === 'streaming') profile = await service.save(toInput(profile, { streamEnabled: true }), profile.id);
        const checked = await service.test(profile.id, capability); expect(checked.result.status, `${model} ${capability}`).toBe('unsupported');
        expect(checked.profile.capabilities.text.status).toBe(capability === 'streaming' ? 'unknown' : 'supported');
        for (const unrelated of ['vision', 'tools', 'streaming'] as const) if (unrelated !== capability) expect(checked.profile.capabilities[unrelated].status).toBe('unknown');
      }
    });

    it(`${protocol} 流式服务的文本、图片和工具验证沿用已保存设置，各项结果仍独立`, async () => {
      const original = await createProfile(protocol, 'stream-only');
      const rejected = await service.test(original.id, 'text');
      expect(rejected.result.status).toBe('error'); expect(rejected.result.message).toContain('服务要求流式请求');
      const profile = await service.save(toInput(original, { streamEnabled: true }), original.id);
      const start = mock.requests.length;
      for (const capability of ['text', 'vision', 'tools'] as const) {
        const checked = await service.test(profile.id, capability);
        expect(checked.result.status).toBe('supported');
        expect(checked.profile.capabilities.streaming.status).toBe('unknown');
        if (capability === 'text') { expect(checked.profile.capabilities.vision.status).toBe('unknown'); expect(checked.profile.capabilities.tools.status).toBe('unknown'); }
      }
      expect(mock.requests.slice(start)).toHaveLength(4);
      expect(mock.requests.slice(start).every(request => request.body.stream === true)).toBe(true);
    });

    it(`${protocol} 鉴权、模型不存在、限流、服务故障与畸形结构有清楚分类且不泄漏密钥`, async () => {
      const fakeKey = `ONLY-TEST-NOT-REAL-${randomUUID()}`;
      const expected = { unauthorized: 'MODEL_AUTH_FAILED', absent: 'MODEL_NOT_FOUND', limited: 'MODEL_RATE_LIMITED', unavailable: 'MODEL_SERVICE_UNAVAILABLE', malformed: 'MODEL_RESPONSE_INVALID', truncated: 'MODEL_OUTPUT_TRUNCATED' };
      for (const [model, code] of Object.entries(expected)) {
        const profile = await createProfile(protocol, model, { credentialMode: 'session', apiKey: fakeKey });
        let failure: any;
        try { await service.generate(profile.id, plainRequest); } catch (error) { failure = error; }
        expect(failure?.code, model).toBe(code); expect(failure?.message.length).toBeGreaterThan(5); expect(failure?.message).not.toContain(fakeKey);
        expect(mock.requests.at(-1)?.headers.authorization).toBe(`Bearer ${fakeKey}`);
      }
    });

    it(`${protocol} 网络超时会中止请求，流式缺少结束与无用量均如实处理`, async () => {
      const slow = await createProfile(protocol, 'timeout', { timeoutMs: 1000 });
      await expect(service.generate(slow.id, plainRequest)).rejects.toMatchObject({ code: 'MODEL_TIMEOUT' });
      const cutoff = await createProfile(protocol, 'stream-cutoff');
      await expect(service.generate(cutoff.id, { ...plainRequest, stream: true })).rejects.toMatchObject({ code: 'MODEL_RESPONSE_INVALID', usage: null });
      const noUsage = await createProfile(protocol, 'no-usage');
      expect((await service.generate(noUsage.id, plainRequest)).usage).toBeNull();
      expect((await service.generate(noUsage.id, { ...plainRequest, stream: true })).usage).toBeNull();
    });

    it(`${protocol} 普通与流式响应达到输出限制时，错误保留服务实际报告的用量`, async () => {
      const profile = await createProfile(protocol, 'truncated');
      for (const stream of [false, true]) {
        await expect(service.generate(profile.id, { ...plainRequest, stream })).rejects.toMatchObject({
          code: 'MODEL_OUTPUT_TRUNCATED', usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
        });
      }
    });
  }

  it('网关拒绝保留安全状态与错误分类，不把客户端请求限制误报成密钥失效', async () => {
    const profile = await createProfile('responses', 'codex-only');
    const checked = await service.test(profile.id, 'text');
    expect(checked.result.status).toBe('error');
    expect(checked.result.message).toContain('HTTP 400');
    expect(checked.result.message).toContain('invalid_responses_request');
    expect(checked.result.message).toContain('invalid codex request');
    expect(checked.profile.capabilities.tools.status).toBe('unknown');
    const secret = `PRIVATE-TEST-SECRET-${randomUUID()}`;
    const failure = serviceError(400, { error: { code: 'unsupported_parameter', message: `Unsupported parameter ${secret}`, param: `max_output_tokens.${secret}`, extra: { authorization: secret } } });
    expect(failure.code).toBe('MODEL_PARAMETER_UNSUPPORTED'); expect(failure.message).toContain('max_output_tokens');
    expect(JSON.stringify(failure)).not.toContain(secret); expect(failure.message).not.toContain(secret);
    const unknown = serviceError(400, { error: { code: secret, type: secret, message: secret, param: secret } });
    expect(unknown.message).toContain('HTTP 400'); expect(unknown.message).not.toContain(secret);
  });

  it('输出上限或超时变化后重新验证，避免把旧请求条件的结果当作当前能力', async () => {
    let profile = await createProfile('responses');
    await service.test(profile.id, 'text');
    profile = await service.save(toInput(profile, { maxOutputTokens: 1024 }), profile.id);
    expect(profile.capabilities.text.status).toBe('unknown');
    await service.test(profile.id, 'text');
    profile = await service.save(toInput(profile, { timeoutMs: 90000 }), profile.id);
    expect(profile.capabilities.text.status).toBe('unknown');
  });

  it('凭据只留引用，编辑留空保留密钥，失败写入不损坏配置，备份没有密钥', async () => {
    const secret = `FAKE-WINDOWS-SECRET-${randomUUID()}`;
    const first = await createProfile('responses', 'mock-all', { credentialMode: 'windows', apiKey: secret });
    expect(first.keyPresent).toBe(true); expect(JSON.stringify(first)).not.toContain(secret); expect((first as any).apiKey).toBeUndefined();
    const row = store.db.prepare('SELECT * FROM model_profiles WHERE id = ?').get(first.id) as { credential_ref: string };
    expect(row.credential_ref).toMatch(/^yearbook:/); expect(JSON.stringify(row)).not.toContain(secret);
    expect(driver.values.get(row.credential_ref)).toBe(secret);
    const renamed = await service.save(toInput(first, { name: '重命名而不改密钥', apiKey: '' }), first.id);
    expect(renamed.keyPresent).toBe(true); await service.generate(first.id, plainRequest);
    expect(mock.requests.at(-1)?.headers.authorization).toBe(`Bearer ${secret}`);
    driver.failWrite = true;
    await expect(service.save(toInput(renamed, { apiKey: 'FAKE-NEW-KEY', model: 'no-tools' }), first.id)).rejects.toThrow('Synthetic');
    driver.failWrite = false; expect((await service.getProfile(first.id)).model).toBe('mock-all');
    const archive = await store.write(() => createBackup(store));
    const zip = new AdmZip(await readFile(join(store.dataDir, 'backups', archive.filename)));
    for (const entry of zip.getEntries()) expect(entry.getData().includes(Buffer.from(secret)), entry.entryName).toBe(false);
    expect(zip.getEntries().map(entry => entry.entryName)).not.toContain('credentials.json');
    expect((await readFile(join(store.dataDir, DATABASE_NAME))).includes(Buffer.from(secret))).toBe(false);
    await service.save(toInput(renamed, { clearKey: true }), first.id);
    expect((await service.getProfile(first.id)).keyPresent).toBe(false); expect(driver.values.has(row.credential_ref)).toBe(false);
  });

  it('系统凭据不可用时明确会话后备，服务关闭即丢弃会话密钥', async () => {
    const unavailable = new CredentialVault({ read: async () => { throw new Error('Unavailable'); }, write: async () => { throw new Error('Unavailable'); }, remove: async () => undefined });
    expect(await unavailable.status()).toMatchObject({ windowsAvailable: false, defaultMode: 'session' });
    const profile = await createProfile('responses', 'mock-all', { credentialMode: 'session', apiKey: 'FAKE-SESSION-KEY' });
    expect(profile.keyPresent).toBe(true); expect(driver.values.size).toBe(0);
    await service.shutdown(); service = new ModelService(store, new CredentialVault(driver));
    expect((await service.getProfile(profile.id)).keyPresent).toBe(false);
    await expect(service.generate(profile.id, plainRequest)).rejects.toMatchObject({ code: 'MODEL_KEY_MISSING' });
  });

  it('备份清除凭据引用和验证结果；恢复伪造引用也不能把已有系统密钥绑定到新地址', async () => {
    const secret = `FAKE-CREDENTIAL-REBIND-TEST-${randomUUID()}`;
    const original = await createProfile('responses', 'mock-all', { credentialMode: 'windows', apiKey: secret });
    const checked = await service.test(original.id, 'text'); expect(checked.result.status).toBe('supported');
    const live = store.db.prepare('SELECT credential_ref FROM model_profiles WHERE id = ?').get(original.id) as { credential_ref: string };
    const archive = await store.write(() => createBackup(store));
    const zip = new AdmZip(await readFile(join(store.dataDir, 'backups', archive.filename)));
    const stagingFile = join(root, '篡改测试 暂存.sqlite');
    await writeFile(stagingFile, zip.getEntry(DATABASE_NAME)!.getData());
    const snapshot = new Database(stagingFile);
    try {
      const clean = snapshot.prepare('SELECT credential_ref, capabilities_json FROM model_profiles WHERE id = ?').get(original.id) as { credential_ref: string | null; capabilities_json: string };
      expect(clean.credential_ref).toBeNull();
      for (const capability of Object.values(JSON.parse(clean.capabilities_json)) as { status: string }[]) expect(capability.status).toBe('unknown');
      const forgedCapabilities = Object.fromEntries(['text', 'vision', 'tools', 'streaming'].map(capability => [capability, checked.result]));
      snapshot.prepare('UPDATE model_profiles SET credential_ref = ?, base_url = ?, capabilities_json = ? WHERE id = ?')
        .run(live.credential_ref, `${mock.url}/forged`, JSON.stringify(forgedCapabilities), original.id);
    } finally { snapshot.close(); }
    // Recompute the manifest so this exercises credential isolation after a structurally valid restore.
    const modified = await readFile(stagingFile); zip.updateFile(DATABASE_NAME, modified);
    const manifest = JSON.parse(zip.getEntry('manifest.json')!.getData().toString('utf8')) as { files: { path: string; size: number; sha256: string }[] };
    const databaseFile = manifest.files.find(file => file.path === DATABASE_NAME)!;
    databaseFile.size = modified.length; databaseFile.sha256 = createHash('sha256').update(modified).digest('hex');
    zip.updateFile('manifest.json', Buffer.from(JSON.stringify(manifest), 'utf8'));

    const fresh = await createApp({ dataDir: join(root, '恢复同一用户 空格目录'), credentialVault: new CredentialVault(driver) });
    apps.push(fresh); await fresh.ready();
    await restore(fresh, zip.toBuffer());
    const profiles = await json<ModelProfileList>(fresh, 'GET', '/api/model-profiles');
    const restored = profiles.items.find(profile => profile.id === original.id)!;
    expect(restored.baseUrl).toBe(`${mock.url}/forged`); expect(restored.keyPresent).toBe(false);
    for (const capability of Object.values(restored.capabilities)) expect(capability.status).toBe('unknown');
    const requestsBefore = mock.requests.length;
    const attempted = await json<{ result: { status: string; message: string } }>(fresh, 'POST', `/api/model-profiles/${original.id}/test`, { capability: 'text' });
    expect(attempted.result.status).toBe('error'); expect(attempted.result.message).toContain('密钥');
    expect(mock.requests).toHaveLength(requestsBefore);
    expect(driver.values.get(live.credential_ref)).toBe(secret);
    const unchanged = await service.getProfile(original.id);
    expect(unchanged.keyPresent).toBe(true); expect(unchanged.capabilities.text.status).toBe('supported');
    expect(unchanged.baseUrl).toBe(mock.url);
  });

  it('模型列表失败不妨碍手填模型；仅改显示名保留验证，改模型重置独立能力', async () => {
    const first = await createProfile('responses');
    expect((await service.models(first.id)).models).toContain('mock-all');
    await service.test(first.id, 'text');
    const rename = await service.save(toInput(first, { name: '换个配置名' }), first.id);
    expect(rename.capabilities.text.status).toBe('supported');
    const changed = await service.save(toInput(rename, { model: 'no-tools' }), first.id);
    for (const status of Object.values(changed.capabilities)) expect(status.status).toBe('unknown');
    const noList = await createProfile('responses', 'manually-named-model', { baseUrl: `${mock.url}/no-models` });
    await expect(service.models(noList.id)).rejects.toMatchObject({ code: 'MODEL_ENDPOINT_NOT_FOUND' });
    expect((await service.generate(noList.id, plainRequest)).text).toBe('连接成功');
  });

  it('HTTP 配置保存、地址预览、独立测试、切换、删除不会向前端返回密钥', async () => {
    const app = await openApp('接口 配置');
    const preview = await json<{ endpointUrl: string }>(app, 'POST', '/api/model-profiles/normalize', { protocol: 'responses', baseUrl: `${mock.url}/responses` });
    expect(preview.endpointUrl).toBe(`${mock.url}/responses`);
    const one = await json<ModelProfile>(app, 'POST', '/api/model-profiles', { name: '配置一', protocol: 'responses', baseUrl: mock.url, model: 'mock-all', credentialMode: 'session', apiKey: 'FAKE-API-KEY-NOT-REAL' }, 201);
    const two = await json<ModelProfile>(app, 'POST', '/api/model-profiles', { name: '配置二', protocol: 'chat-completions', baseUrl: mock.url, model: 'mock-all' }, 201);
    expect(one.isActive).toBe(true); expect(two.isActive).toBe(false); expect((one as any).apiKey).toBeUndefined();
    const list = await json<ModelProfileList>(app, 'GET', '/api/model-profiles'); expect(JSON.stringify(list)).not.toContain('FAKE-API-KEY-NOT-REAL');
    await json(app, 'POST', `/api/model-profiles/${two.id}/activate`);
    expect((await json<ModelProfileList>(app, 'GET', '/api/model-profiles')).activeId).toBe(two.id);
    await json(app, 'PUT', `/api/model-profiles/${one.id}`, { name: '配置一修改', protocol: 'responses', baseUrl: mock.url, model: 'mock-all', credentialMode: 'session', apiKey: '' });
    const tested = await json<{ profile: ModelProfile }>(app, 'POST', `/api/model-profiles/${one.id}/test`, { capability: 'text' });
    expect(tested.profile.keyPresent).toBe(true); expect(tested.profile.capabilities.tools.status).toBe('unknown');
    expect(mock.requests.at(-1)?.headers.authorization).toBe('Bearer FAKE-API-KEY-NOT-REAL');
    await json(app, 'DELETE', `/api/model-profiles/${two.id}`);
    expect((await json<ModelProfileList>(app, 'GET', '/api/model-profiles')).activeId).toBe(one.id);
    const invalid = await app.inject({ method: 'POST', url: '/api/model-profiles/normalize', payload: { protocol: 'responses', baseUrl: 'http://user:key@localhost/v1' } });
    expect(invalid.statusCode).toBe(400);
  });

  it('HTTP 月报含照片与逐段来源，采用不伤手动稿，重生保护，整库可在新中文目录恢复', async () => {
    const app = await openApp('原始 应用');
    const imported = await upload(app, [{ buffer: await photo({ width: 72, height: 120, orientation: 6 }), filename: '家人 河边.jpg' }]);
    const entry = await record(app, { title: '家人河边散步', body: '这是我希望保留的原话。', occurredOn: '2024-03-12', people: ['家人'], isFirst: true, media: [{ id: imported.items[0].id, caption: '家人站在河边' }] });
    const book = await json<YearbookItem>(app, 'POST', '/api/yearbooks', { year: 2024, title: '手动年册', chapters: [{ title: '手工页', kind: 'custom', body: '人工写下的文字不覆盖', blocks: [], sourceRecordIds: [entry.id] }] }, 201);
    const profile = await json<ModelProfile>(app, 'POST', '/api/model-profiles', { name: '本机模拟（非真实智能）', protocol: 'responses', baseUrl: mock.url, model: 'mock-all' }, 201);
    const request = { kind: 'monthly', year: 2024, month: 3, recordIds: [entry.id], profileId: profile.id };
    const started = await json<TaskItem>(app, 'POST', '/api/ai/tasks', request, 202);
    const task = await completed(app, started.id); expect(task.status, task.errorMessage ?? '').toBe('completed');
    const first = await json<AiDraftItem>(app, 'GET', `/api/ai/drafts/${(task.result as any).draftId}`);
    expect(first.content.title).toBe('本机模拟整理'); expect(first.content.highlights.length).toBeGreaterThan(0);
    expect(first.content.photos[0].mediaId).toBe(imported.items[0].id); expect(first.content.paragraphs[0].sourceRecordIds).toEqual([entry.id]);
    const changed = { ...first.content, paragraphs: [{ text: '手动改过的月报文字', sourceRecordIds: [entry.id] }] };
    await json(app, 'PUT', `/api/ai/drafts/${first.id}`, { content: changed });
    const regeneration = await json<TaskItem>(app, 'POST', '/api/ai/tasks', request, 202);
    expect((await completed(app, regeneration.id)).status).toBe('completed');
    expect((await json<AiDraftItem>(app, 'GET', `/api/ai/drafts/${first.id}`)).content.paragraphs[0].text).toBe('手动改过的月报文字');
    const adopted = await json<AiAdoptResult>(app, 'POST', `/api/ai/drafts/${first.id}/adopt`, { yearbookId: book.id });
    expect(adopted.yearbookId).toBe(book.id);
    const updatedBook = await json<YearbookItem>(app, 'GET', `/api/yearbooks/${book.id}`); expect(updatedBook.chapters[0].body).toBe('人工写下的文字不覆盖');
    expect(updatedBook.chapters.at(-1)?.blocks.some(block => block.mediaId === imported.items[0].id)).toBe(true);
    expect((await json<YearbookVersion[]>(app, 'GET', `/api/yearbooks/${book.id}/versions`)).some(version => version.label === '采用 AI 草稿前的编辑稿')).toBe(true);
    expect((await json<RecordItem>(app, 'GET', `/api/records/${entry.id}`)).body).toBe(entry.body);
    const archive = await backup(app); const fresh = await openApp('新 中文 空格 目录');
    await restore(fresh, archive.buffer);
    expect((await json<RecordItem>(fresh, 'GET', `/api/records/${entry.id}`)).media[0].id).toBe(imported.items[0].id);
    expect((await json<AiDraftList>(fresh, 'GET', '/api/ai/drafts')).total).toBe(2);
    expect((await json<AiDraftItem>(fresh, 'GET', `/api/ai/drafts/${first.id}`)).content.paragraphs[0].text).toBe('手动改过的月报文字');
    expect((await json<YearbookItem>(fresh, 'GET', `/api/yearbooks/${book.id}`)).chapters).toEqual(updatedBook.chapters);
    expect((await fresh.inject({ method: 'GET', url: `/api/media/${imported.items[0].id}/display` })).statusCode).toBe(200);
  });

  it('HTTP Chat Agent 调用本地项目工具后生稿；不能看到没有选择的私人记录', async () => {
    const app = await openApp('Agent 真接口');
    const allowed = await record(app, { title: '授权给助理的家庭记录', body: '和家人散步的原话。', occurredOn: '2024-04-01', people: ['家人'] });
    const hidden = await record(app, { title: '不得发送', body: 'HTTP_TEST_PRIVATE_NOT_SELECTED', occurredOn: '2024-04-01' });
    const profile = await json<ModelProfile>(app, 'POST', '/api/model-profiles', { name: 'Chat 模拟 Agent', protocol: 'chat-completions', baseUrl: mock.url, model: 'mock-all', streamEnabled: true }, 201);
    for (const capability of ['tools', 'streaming'] as ModelCapability[]) await json(app, 'POST', `/api/model-profiles/${profile.id}/test`, { capability });
    mock.requests.length = 0;
    const task = await json<TaskItem>(app, 'POST', '/api/ai/tasks', { kind: 'agent', recordIds: [allowed.id], instruction: '把与家人有关的记录整理成章节，保留原话。', profileId: profile.id }, 202);
    const finished = await completed(app, task.id); expect(finished.status, finished.errorMessage ?? '').toBe('completed'); expect(finished.toolCalls).toBe(3);
    const created = await json<AiDraftItem>(app, 'GET', `/api/ai/drafts/${(finished.result as any).draftId}`);
    expect(created.mode).toBe('tools'); expect(created.sourceRecordIds).toEqual([allowed.id]);
    expect(JSON.stringify(mock.requests)).not.toContain(hidden.body); expect(JSON.stringify(mock.requests)).not.toContain(hidden.id);
    expect(mock.requests.some(request => request.body.messages?.some((message: any) => message.role === 'tool'))).toBe(true);
  });
});
