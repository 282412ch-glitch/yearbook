import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { modelCapabilitiesSchema, modelProfileInputSchema, normalizeModelUrl, unknownCapabilities, type CapabilityResult, type CredentialMode, type ModelCapability, type ModelProfile, type ModelProfileInput, type ModelProfileList, type ModelRequest, type ModelResult } from '@yearbook/shared';
import { idSchema } from '@yearbook/shared';
import type { DataStore } from '../db.js';
import { AppError } from '../errors.js';
import { CredentialVault } from './credentials.js';
import { generateChat } from './chat.js';
import { generateResponses } from './responses.js';
import { invalidResponse, modelHttp, ModelError, object, readJson } from './transport.js';

export type ProfileRow = {
  id: string; name: string; protocol: 'responses' | 'chat-completions'; base_url: string; model: string;
  timeout_ms: number; max_output_tokens: number; stream_enabled: number; credential_mode: CredentialMode;
  credential_ref: string | null; is_active: number; capabilities_json: string; created_at: string; updated_at: string;
};

export class ModelService {
  private controllers = new Set<AbortController>();
  private operations = new Set<Promise<unknown>>();
  private configTail: Promise<unknown> = Promise.resolve();
  private paused = false;
  constructor(private store: DataStore, readonly vault = new CredentialVault()) {}
  private tracked<T>(operation: () => Promise<T>): Promise<T> {
    if (this.paused) return Promise.reject(new AppError(503, 'MODELS_PAUSED', '正在恢复资料或关闭服务，请稍后再试'));
    const promise = Promise.resolve().then(operation);
    this.operations.add(promise);
    void promise.finally(() => this.operations.delete(promise)).catch(() => undefined);
    return promise;
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    return this.tracked(() => {
      const result = this.configTail.then(operation); this.configTail = result.catch(() => undefined); return result;
    });
  }
  private row(rawId?: string): Promise<ProfileRow> {
    const id = rawId ? idSchema.parse(rawId) : undefined;
    return this.store.write(() => {
      const row = this.store.db.prepare(id ? 'SELECT * FROM model_profiles WHERE id = ?' : 'SELECT * FROM model_profiles WHERE is_active = 1').get(...(id ? [id] : [])) as ProfileRow | undefined;
      if (!row) throw new AppError(404, 'MODEL_NOT_CONFIGURED', '尚未选择可用模型，请先到设置页保存并启用一套配置');
      return row;
    });
  }
  private async present(row: ProfileRow): Promise<ModelProfile> {
    const urls = normalizeModelUrl(row.base_url, row.protocol);
    let keyPresent = false;
    try { keyPresent = Boolean(await this.vault.read(row.credential_mode, row.credential_ref)); } catch { /* Settings must remain usable if the Windows store is unavailable. */ }
    return { id: row.id, name: row.name, protocol: row.protocol, ...urls, model: row.model, timeoutMs: row.timeout_ms, maxOutputTokens: row.max_output_tokens,
      streamEnabled: !!row.stream_enabled, credentialMode: row.credential_mode, keyPresent, isActive: !!row.is_active, capabilities: modelCapabilitiesSchema.parse(JSON.parse(row.capabilities_json)), createdAt: row.created_at, updatedAt: row.updated_at };
  }
  getProfile(id?: string): Promise<ModelProfile> { return this.tracked(async () => this.present(await this.row(id))); }
  list(): Promise<ModelProfileList> { return this.tracked(async () => { const rows = await this.store.write(() => this.store.db.prepare('SELECT * FROM model_profiles ORDER BY created_at, id').all() as ProfileRow[]); return { items: await Promise.all(rows.map(row => this.present(row))), activeId: rows.find(row => row.is_active)?.id ?? null }; }); }
  save(raw: ModelProfileInput, rawId?: string): Promise<ModelProfile> {
    const input = modelProfileInputSchema.parse(raw);
    return this.exclusive(async () => {
      const old = rawId ? await this.row(rawId) : null;
      const id = old?.id ?? randomUUID();
      const urls = normalizeModelUrl(input.baseUrl, input.protocol);
      let ref = old?.credential_ref ?? null;
      const replace = !!input.apiKey?.trim() || (old && input.credentialMode !== old.credential_mode);
      let freshRef: string | null = null;
      try {
        if (input.clearKey || input.credentialMode === 'none') ref = null;
        else if (replace) {
          const secret = input.apiKey?.trim() || (old ? await this.vault.read(old.credential_mode, old.credential_ref) : null);
          if (secret) { freshRef = `yearbook:${randomUUID()}`; await this.vault.write(input.credentialMode, freshRef, secret); ref = freshRef; }
          else ref = null;
        }
        const changed = !old || old.base_url !== urls.baseUrl || old.protocol !== input.protocol || old.model !== input.model || old.credential_ref !== ref || old.stream_enabled !== Number(input.streamEnabled) || old.max_output_tokens !== input.maxOutputTokens || old.timeout_ms !== input.timeoutMs;
        const now = new Date(Math.max(Date.now(), old ? Date.parse(old.updated_at) + 1 : 0)).toISOString();
        await this.store.write(() => this.store.db.transaction(() => {
          const active = old?.is_active ?? Number(!(this.store.db.prepare('SELECT id FROM model_profiles WHERE is_active = 1').get()));
          this.store.db.prepare(`INSERT INTO model_profiles (id,name,protocol,base_url,model,timeout_ms,max_output_tokens,stream_enabled,credential_mode,credential_ref,is_active,capabilities_json,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,protocol=excluded.protocol,base_url=excluded.base_url,model=excluded.model,timeout_ms=excluded.timeout_ms,max_output_tokens=excluded.max_output_tokens,stream_enabled=excluded.stream_enabled,credential_mode=excluded.credential_mode,credential_ref=excluded.credential_ref,capabilities_json=excluded.capabilities_json,updated_at=excluded.updated_at`)
            .run(id, input.name, input.protocol, urls.baseUrl, input.model, input.timeoutMs, input.maxOutputTokens, Number(input.streamEnabled), input.credentialMode, ref, active, changed ? JSON.stringify(unknownCapabilities()) : old.capabilities_json, old?.created_at ?? now, now);
        })());
      } catch (error) { if (freshRef) await this.vault.remove(input.credentialMode, freshRef).catch(() => undefined); throw error; }
      // A failed obsolete-reference cleanup cannot undo the newly saved usable configuration.
      if (old?.credential_ref && old.credential_ref !== ref) await this.vault.remove(old.credential_mode, old.credential_ref).catch(() => undefined);
      return this.present(await this.row(id));
    });
  }
  activate(rawId: string): Promise<ModelProfile> {
    return this.exclusive(async () => { const row = await this.row(rawId); await this.store.write(() => this.store.db.transaction(() => { this.store.db.prepare('UPDATE model_profiles SET is_active = 0').run(); this.store.db.prepare('UPDATE model_profiles SET is_active = 1 WHERE id = ?').run(row.id); })()); return this.present(await this.row(row.id)); });
  }
  remove(rawId: string): Promise<{ deleted: true }> {
    return this.exclusive(async () => {
      const row = await this.row(rawId);
      await this.vault.remove(row.credential_mode, row.credential_ref);
      await this.store.write(() => this.store.db.transaction(() => {
        this.store.db.prepare('DELETE FROM model_profiles WHERE id = ?').run(row.id);
        if (row.is_active) this.store.db.prepare('UPDATE model_profiles SET is_active = 1 WHERE id = (SELECT id FROM model_profiles ORDER BY created_at LIMIT 1)').run();
      })());
      return { deleted: true };
    });
  }
  private async invoke(row: ProfileRow, request: ModelRequest, signal?: AbortSignal): Promise<ModelResult> {
    const profile = await this.present(row);
    const key = await this.vault.read(row.credential_mode, row.credential_ref);
    if (this.paused) throw new AppError(503, 'MODELS_PAUSED', '正在恢复资料或关闭服务，请稍后再试');
    if (row.credential_mode !== 'none' && !key) throw new ModelError('MODEL_KEY_MISSING', '此配置的密钥尚未提供或会话已结束，请在设置页重新填写；无 Key 的服务请选择“不使用密钥”', 400);
    const controller = new AbortController(); this.controllers.add(controller);
    const signals = [controller.signal, signal, request.signal].filter((item): item is AbortSignal => !!item);
    try {
      const input = { ...request, signal: AbortSignal.any(signals) };
      return profile.protocol === 'responses' ? await generateResponses(profile, key, input) : await generateChat(profile, key, input);
    } finally { this.controllers.delete(controller); }
  }
  generate(profileId: string, request: ModelRequest, signal?: AbortSignal): Promise<ModelResult> {
    return this.tracked(async () => {
      const row = await this.row(profileId);
      if (request.expectedProfileUpdatedAt && row.updated_at !== request.expectedProfileUpdatedAt) throw new AppError(409, 'MODEL_CONFIG_CHANGED', '此任务使用的模型配置已改变。已完成阶段保留，请检查配置后重试');
      return this.invoke(row, request, signal);
    });
  }
  models(rawId: string): Promise<{ models: string[] }> {
    return this.tracked(async () => {
      const row = await this.row(rawId); const profile = await this.present(row); const key = await this.vault.read(row.credential_mode, row.credential_ref);
      if (this.paused) throw new AppError(503, 'MODELS_PAUSED', '正在恢复资料或关闭服务，请稍后再试');
      if (row.credential_mode !== 'none' && !key) throw new ModelError('MODEL_KEY_MISSING', '请先为此配置填写密钥，或选择不使用密钥', 400);
      const controller = new AbortController(); this.controllers.add(controller);
      try {
        const value = await modelHttp(profile, key, undefined, controller.signal, readJson, profile.modelsUrl);
        const data = object(value).data;
        if (!Array.isArray(data)) throw invalidResponse('服务不提供兼容的模型列表；仍然可以手动填写模型名称');
        return { models: [...new Set(data.map(item => object(item).id).filter((id): id is string => typeof id === 'string' && id.length <= 200))].slice(0, 1000) };
      } finally { this.controllers.delete(controller); }
    });
  }
  test(rawId: string, capability: ModelCapability, signal?: AbortSignal): Promise<{ profile: ModelProfile; capability: ModelCapability; result: CapabilityResult }> {
    return this.tracked(async () => {
      const row = await this.row(rawId);
      let result: CapabilityResult;
      try {
        if (capability === 'streaming' && !row.stream_enabled) throw new ModelError('STREAM_DISABLED', '请先启用流式输出并保存配置，再验证流式能力', 400);
        // A transport preference applies to every probe, while capability results stay independent.
        const request: ModelRequest = { system: '这是连接能力测试。请严格执行用户要求；不涉及个人生活资料。', messages: [], stream: !!row.stream_enabled };
        if (capability === 'text' || capability === 'streaming') request.messages = [{ role: 'user', text: '请只回复：连接成功' }];
        if (capability === 'vision') {
          // A fresh random colour is shown only in the image, never given away in the prompt.
          const colors = [{ css: '#ed2525', labels: /红|red/i }, { css: '#244ddd', labels: /蓝|blue/i }, { css: '#28b038', labels: /绿|green/i }];
          const color = colors[Math.floor(Math.random() * colors.length)];
          const image = await sharp({ create: { width: 96, height: 96, channels: 3, background: color.css } }).png().toBuffer();
          request.messages = [{ role: 'user', text: '识别图片中单一填充的颜色，只回答颜色名称，不要猜测。', images: [{ dataUrl: `data:image/png;base64,${image.toString('base64')}` }] }];
          const answer = await this.invoke(row, request, signal);
          if (!color.labels.test(answer.text)) throw new ModelError('VISION_NOT_CONFIRMED', '服务接受了图片请求，但回答未能确认图片理解能力；请检查模型后重新验证', 400);
        } else if (capability === 'tools') {
          const token = randomUUID();
          request.messages = [{ role: 'user', text: `请调用 yearbook_probe，参数 token 填写“${token}”；收到工具结果后只回复结果中的 receipt。` }];
          request.tools = [{ name: 'yearbook_probe', description: '验证一次本地工具往返', parameters: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'], additionalProperties: false } }];
          request.toolChoice = 'required';
          const answer = await this.invoke(row, request, signal);
          const call = answer.toolCalls.find(call => call.name === 'yearbook_probe');
          let argumentsValue: unknown; try { argumentsValue = JSON.parse(call?.arguments ?? 'null'); } catch { /* Must not infer tool support from plain text. */ }
          if (!call || answer.toolCalls.length !== 1 || object(argumentsValue).token !== token || Object.keys(object(argumentsValue)).length !== 1) throw new ModelError('MODEL_CAPABILITY_UNSUPPORTED', '模型未返回符合参数要求的工具调用，工具能力未确认', 400);
          const receipt = `probe-${randomUUID()}`;
          const second = await this.invoke(row, { ...request, toolChoice: 'auto', messages: [...request.messages, { role: 'assistant', text: answer.text, toolCalls: answer.toolCalls, providerItems: answer.providerItems }, { role: 'tool', callId: call.id, text: JSON.stringify({ receipt }) }] }, signal);
          if (!second.text.includes(receipt) || second.toolCalls.length) throw new ModelError('MODEL_CAPABILITY_UNSUPPORTED', '服务未完成工具结果往返，工具能力未确认', 400);
        } else {
          let deltas = 0;
          const answer = await this.invoke(row, { ...request, onDelta: () => { deltas++; } }, signal);
          if (!answer.text.trim()) throw invalidResponse();
          if (capability === 'streaming' && deltas === 0) throw new ModelError('MODEL_CAPABILITY_UNSUPPORTED', '未收到可用文字增量，流式能力未确认', 400);
        }
        result = { status: 'supported', checkedAt: new Date().toISOString(), message: capability === 'tools' ? '已完成真实工具调用与结果往返' : capability === 'vision' ? '已通过随机颜色图片识别探测' : capability === 'streaming' ? '已收到文字增量与完整结束事件' : '已收到有效文字响应' };
      } catch (error) {
        if (signal?.aborted) throw new ModelError('MODEL_CANCELLED', '验证已取消，原有能力结果保留', 409);
        const unsupported = error instanceof AppError && ['MODEL_CAPABILITY_UNSUPPORTED', 'MODEL_TOOLS_UNSUPPORTED', 'MODEL_VISION_UNSUPPORTED', 'MODEL_STREAM_UNSUPPORTED', 'VISION_NOT_CONFIRMED', 'STREAM_DISABLED'].includes(error.code);
        result = { status: unsupported ? 'unsupported' : 'error', checkedAt: new Date().toISOString(), message: error instanceof AppError ? error.message : '能力验证未完成，请检查配置后重试' };
      }
      // Reject stale results if the user changed the endpoint/model/key during this probe.
      await this.store.write(() => {
        const current = this.store.db.prepare('SELECT * FROM model_profiles WHERE id = ?').get(row.id) as ProfileRow | undefined;
        if (!current || current.updated_at !== row.updated_at) throw new AppError(409, 'MODEL_CONFIG_CHANGED', '配置已改变，本次验证结果没有写入，请验证新的配置');
        const capabilities = modelCapabilitiesSchema.parse(JSON.parse(current.capabilities_json)); capabilities[capability] = result;
        this.store.db.prepare('UPDATE model_profiles SET capabilities_json = ? WHERE id = ?').run(JSON.stringify(capabilities), row.id);
      });
      return { profile: await this.present(await this.row(row.id)), capability, result };
    });
  }
  async pause() { this.paused = true; for (const controller of this.controllers) controller.abort(); await Promise.allSettled([...this.operations]); }
  resume() { this.paused = false; }
  async shutdown() { await this.pause(); this.vault.clearSession(); }
}
