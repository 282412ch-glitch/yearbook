import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  aiTaskInputSchema, type AiDraftContent, type AiDraftChapter, type AiPhoto, type AiSourceSnapshot, type AiTaskInput,
  type ModelImage, type ModelMessage, type ModelProfile, type ModelRequest, type ModelResult, type TaskItem,
} from '@yearbook/shared';
import type { DataStore } from '../db.js';
import { AppError } from '../errors.js';
import { mediaFiles } from '../media.js';
import type { MediaRow } from '../records.js';
import { cancelTask, failTask, finishTask, getTask, retryTask, startTask, updateTask } from '../tasks.js';
import {
  addUsage, assertScopeAvailable, findTaskDraft, getAiScope, getAiTaskDetail, prepareAiTask, saveGeneratedDraft,
  sourceEntries, taskResult, validateAiContent, type TaskScope,
} from './store.js';
import { combineDrafts, editorSystem, materialBatches, parseDraftText, userPrompt } from './prompts.js';
import { executeProjectTool, projectTools } from './tools.js';

export interface AiModelService {
  getProfile(id?: string): Promise<ModelProfile> | ModelProfile;
  generate(profileId: string, input: ModelRequest, signal?: AbortSignal): Promise<ModelResult>;
}
type Runtime = { token: symbol; epoch: number; controller: AbortController; promise: Promise<void>; modelRequests: number; disabledVision?: boolean; disabledStreaming?: boolean };
type Stage = { key: string; label: string; records: AiSourceSnapshot[] };

/** A task runner owns only its own requests. Network waits never occupy DataStore.write. */
export class AiRunner {
  private pending = new Set<string>();
  private running = new Map<string, Runtime>();
  private paused = false;
  private closed = false;
  private epoch = 0;
  private pausing: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  constructor(private store: DataStore, private models: AiModelService) {}

  private activeEpoch(expected = this.epoch) {
    if (this.closed || this.paused || this.stopping || expected !== this.epoch) throw new AppError(503, 'AI_PAUSED', '资料维护进行中，或这次操作已被服务暂停中断，请等待完成后重新提交');
    return expected;
  }

  async create(raw: unknown): Promise<TaskItem> {
    const epoch = this.activeEpoch();
    const parsed = aiTaskInputSchema.parse(raw);
    const profile = await this.models.getProfile(parsed.profileId);
    const input = { ...parsed, profileId: profile.id };
    const mode = input.kind === 'agent' && profile.capabilities.tools.status === 'supported' ? 'tools' : 'fixed';
    const warnings: string[] = [];
    if (input.kind === 'agent' && mode === 'fixed') warnings.push('工具调用尚未验证或不可用，使用“程序筛选素材—模型生成草稿”的固定流程。');
    if (input.useImages && profile.capabilities.vision.status !== 'supported') warnings.push('图片理解尚未验证或不可用，本次只使用用户图注，不发送照片。');
    if (input.useImages && !input.selectedMediaIds.length) warnings.push('本次没有选中供模型读取的照片，只使用用户图注。');
    if (profile.streamEnabled && profile.capabilities.streaming.status !== 'supported') warnings.push('流式能力尚未独立验证，本次使用普通响应。');
    const task = await this.store.write(() => {
      this.activeEpoch(epoch);
      return prepareAiTask(this.store, input, mode, warnings);
    });
    this.activeEpoch(epoch);
    if (task.status === 'pending') this.enqueue(task.id);
    return task;
  }
  enqueue(id: string) {
    if (this.closed || this.paused || this.running.has(id)) return;
    this.pending.add(id);
    queueMicrotask(() => this.pump());
  }
  private pump() {
    if (this.closed || this.paused || this.running.size || !this.pending.size) return;
    const id = this.pending.values().next().value!; this.pending.delete(id);
    const runtime: Runtime = { token: Symbol(id), epoch: this.epoch, controller: new AbortController(), promise: Promise.resolve(), modelRequests: 0 };
    this.running.set(id, runtime);
    runtime.promise = this.run(id, runtime).finally(() => {
      if (this.running.get(id)?.token === runtime.token) this.running.delete(id);
      this.pump();
    });
  }
  private current(id: string, runtime: Runtime) { return this.running.get(id)?.token === runtime.token && runtime.epoch === this.epoch && !this.closed; }
  private check(id: string, runtime: Runtime) {
    if (!this.current(id, runtime) || runtime.controller.signal.aborted) throw runtime.controller.signal.reason ?? new AppError(409, 'AI_TASK_CANCELLED', '任务已中止');
    const task = getTask(this.store, id);
    if (task.deletedAt || task.status === 'cancelled' || task.cancelRequested) throw new AppError(409, 'AI_TASK_CANCELLED', '任务已取消');
    return task;
  }
  private async write<T>(id: string, runtime: Runtime, operation: () => T): Promise<T> {
    return this.store.write(() => { this.check(id, runtime); return operation(); });
  }
  async cancel(id: string) {
    const epoch = this.activeEpoch();
    this.pending.delete(id);
    const { task, active } = await this.store.write(() => {
      this.activeEpoch(epoch);
      return { task: cancelTask(this.store, id), active: this.running.get(id) };
    });
    this.activeEpoch(epoch);
    active?.controller.abort(new AppError(409, 'AI_TASK_CANCELLED', '任务已取消'));
    if (active) await active.promise;
    return task;
  }
  async retry(id: string) {
    const epoch = this.activeEpoch();
    const { task: current, active } = await this.store.write(() => {
      this.activeEpoch(epoch);
      return { task: getTask(this.store, id), active: this.running.get(id) };
    });
    if (current.deletedAt) throw new AppError(409, 'TASK_IN_TRASH', '任务已移入回收站，请先恢复再重试');
    if (!['failed', 'cancelled'].includes(current.status)) throw new AppError(409, 'TASK_NOT_RETRYABLE', '只有失败或已取消的任务可以重试');
    if (active) { active.controller.abort(new AppError(409, 'AI_ATTEMPT_REPLACED', '正在结束上一次执行')); await active.promise; }
    this.activeEpoch(epoch);
    const task = await this.store.write(() => {
      this.activeEpoch(epoch);
      getAiScope(this.store, id);
      const next = retryTask(this.store, id);
      this.store.db.prepare('UPDATE tasks SET tool_calls = 0, started_at = NULL WHERE id = ?').run(id);
      return { ...next, toolCalls: 0, startedAt: null };
    });
    this.activeEpoch(epoch);
    this.enqueue(id);
    return task;
  }
  async recover() {
    await this.store.write(() => {
      const now = new Date().toISOString();
      this.store.db.prepare(`UPDATE tasks SET status = 'failed', message = '应用重启，任务未完成',
        error_message = '应用关闭时此任务尚未完成。已完成的分月阶段已保留，点击重试可继续。', finished_at = ?, updated_at = ?
        WHERE kind = 'ai' AND deleted_at IS NULL AND status IN ('pending', 'running')`).run(now, now);
    });
  }
  pause(): Promise<void> {
    if (this.pausing) return this.pausing;
    if (this.closed) return Promise.resolve();
    this.paused = true; this.epoch++; this.pending.clear();
    const active = [...this.running.values()];
    active.forEach(runtime => runtime.controller.abort(new AppError(409, 'AI_APP_PAUSED', '应用暂停了 AI 任务，已完成阶段已保留，可稍后重试')));
    this.pausing = (async () => {
      await Promise.allSettled(active.map(runtime => runtime.promise));
      await this.recover();
    })().finally(() => { this.pausing = null; });
    return this.pausing;
  }
  resume() {
    if (this.closed || this.stopping) return;
    if (this.pausing) throw new AppError(409, 'AI_PAUSE_PENDING', '请等待 AI 任务停止后再恢复运行');
    this.paused = false; this.pump();
  }
  shutdown(): Promise<void> {
    return this.stopping ??= this.pause().then(() => { this.closed = true; });
  }
  async idle() { while (this.running.size || this.pending.size) await Promise.allSettled([...this.running.values()].map(runtime => runtime.promise)); }

  private async run(id: string, runtime: Runtime) {
    let timer: NodeJS.Timeout | undefined;
    try {
      const initial = await this.store.write(() => {
        if (!this.current(id, runtime) || runtime.controller.signal.aborted || this.paused) return null;
        const task = getTask(this.store, id);
        if (task.status !== 'pending') return null;
        startTask(this.store, id, '正在读取本次授权素材');
        return getAiScope(this.store, id);
      });
      if (!initial) return;
      timer = setTimeout(() => runtime.controller.abort(new AppError(408, 'AI_TASK_TIMEOUT', '任务超过最大执行时长。已完成阶段已保留，可重试或缩小素材范围')), initial.input.maxDurationMs);
      const profile = await this.abortable(runtime, Promise.resolve(this.models.getProfile(initial.input.profileId)));
      await this.write(id, runtime, () => assertScopeAvailable(this.store, initial));
      const existing = await this.write(id, runtime, () => findTaskDraft(this.store, id));
      if (existing) {
        await this.write(id, runtime, () => finishTask(this.store, id, taskResult(this.store, id, existing.id), null, '已继续完成，保留原草稿'));
        return;
      }
      let content: AiDraftContent;
      if (initial.row.mode === 'tools') {
        if (profile.capabilities.tools.status !== 'supported') {
          await this.downgrade(id, runtime, '工具能力已变更，本次改用程序筛选素材的固定流程。');
          content = await this.runFixed(id, runtime, getAiScope(this.store, id), profile);
        } else {
          try { content = await this.runAgent(id, runtime, initial, profile); }
          catch (error) {
            const code = (error as { code?: string }).code ?? '';
            if (/TOOL.*UNSUPPORTED|UNSUPPORTED.*TOOL/.test(code) || code === 'MODEL_CAPABILITY_UNSUPPORTED') {
              await this.downgrade(id, runtime, '服务实际不支持工具调用，本次改用程序筛选素材的固定流程。');
              content = await this.runFixed(id, runtime, getAiScope(this.store, id), profile);
            } else throw error;
          }
        }
      } else content = await this.runFixed(id, runtime, initial, profile);
      await this.write(id, runtime, () => this.store.db.transaction(() => {
        const draft = saveGeneratedDraft(this.store, id, content);
        finishTask(this.store, id, taskResult(this.store, id, draft.id), null, '独立草稿已生成，请查看并决定是否采用');
      })());
    } catch (error) {
      if (this.current(id, runtime)) await this.store.write(() => {
        const current = getTask(this.store, id);
        if (current.status === 'cancelled' || current.cancelRequested) return;
        const reason = runtime.controller.signal.aborted ? runtime.controller.signal.reason : error;
        const message = reason instanceof AppError ? reason.message : reason instanceof z.ZodError ? '整理结果超过结构限制，请缩小素材范围或减少输出长度后重试' : '模型整理未完成，请检查接口配置后重试。原始记录和手动编辑稿未改变';
        failTask(this.store, id, message);
        updateTask(this.store, id, { result: taskResult(this.store, id) });
      });
    } finally { if (timer) clearTimeout(timer); }
  }
  private async abortable<T>(runtime: Runtime, promise: Promise<T>): Promise<T> {
    const signal = runtime.controller.signal;
    let listener: () => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      listener = () => reject(signal.reason ?? new AppError(409, 'AI_TASK_CANCELLED', '任务已中止'));
      if (signal.aborted) listener(); else signal.addEventListener('abort', listener, { once: true });
    });
    try { return await Promise.race([promise, aborted]); }
    finally { signal.removeEventListener('abort', listener); }
  }
  private async downgrade(id: string, runtime: Runtime, message: string) {
    await this.write(id, runtime, () => {
      const scope = getAiScope(this.store, id); const warnings: string[] = JSON.parse(scope.row.warnings_json);
      if (!warnings.includes(message)) warnings.push(message);
      this.store.db.prepare("UPDATE ai_task_inputs SET mode = 'fixed', warnings_json = ? WHERE task_id = ?").run(JSON.stringify(warnings), id);
    });
  }
  private async warning(id: string, runtime: Runtime, message: string) {
    await this.write(id, runtime, () => {
      const scope = getAiScope(this.store, id); const warnings: string[] = JSON.parse(scope.row.warnings_json);
      if (!warnings.includes(message)) warnings.push(message);
      this.store.db.prepare('UPDATE ai_task_inputs SET warnings_json = ? WHERE task_id = ?').run(JSON.stringify(warnings), id);
    });
  }
  private async reportedUsage(id: string, runtime: Runtime, usage: ModelResult['usage'] | undefined) {
    if (!usage || !this.current(id, runtime)) return;
    // A cancelled attempt can still report already billed usage. It may update its own counters,
    // but a restore/close or a replacement attempt invalidates this generation before any write.
    await this.store.write(() => {
      if (!this.current(id, runtime)) return;
      addUsage(this.store, id, usage);
      updateTask(this.store, id, { result: taskResult(this.store, id) });
    });
  }
  private async model(id: string, runtime: Runtime, profile: ModelProfile, input: ModelRequest, scope: TaskScope, recordIds = scope.recordIds): Promise<ModelResult> {
    await this.write(id, runtime, () => {
      assertScopeAvailable(this.store, scope, recordIds);
      if (++runtime.modelRequests > 60) throw new AppError(400, 'AI_REQUEST_LIMIT', '本次任务超过 60 次模型请求上限，请缩小素材范围后重新创建任务');
    });
    const signal = runtime.controller.signal;
    let listener: () => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      listener = () => reject(signal.reason ?? new AppError(409, 'AI_TASK_CANCELLED', '任务已中止'));
      if (signal.aborted) listener(); else signal.addEventListener('abort', listener, { once: true });
    });
    const request: ModelRequest = { ...input,
      messages: runtime.disabledVision ? input.messages.map(message => ({ ...message, images: [] })) : input.messages,
      stream: !runtime.disabledStreaming && profile.streamEnabled && profile.capabilities.streaming.status === 'supported',
      expectedProfileUpdatedAt: profile.updatedAt };
    try {
      const result = await Promise.race([this.models.generate(profile.id, request, signal), aborted]);
      await this.reportedUsage(id, runtime, result.usage);
      await this.write(id, runtime, () => undefined);
      return result;
    } catch (error) {
      await this.reportedUsage(id, runtime, (error as { usage?: ModelResult['usage'] }).usage);
      if (signal.aborted) throw error;
      const code = (error as { code?: string }).code ?? '';
      const ambiguous = code === 'MODEL_CAPABILITY_UNSUPPORTED';
      if (request.messages.some(message => message.images?.length) && (ambiguous || /VISION.*UNSUPPORTED|IMAGE.*UNSUPPORTED/.test(code))) {
        runtime.disabledVision = true;
        await this.warning(id, runtime, '服务未接受含图片的请求，本次改用用户图注继续整理，不再发送照片。');
        return this.model(id, runtime, profile, input, scope, recordIds);
      }
      if (request.stream && (ambiguous || /STREAM.*UNSUPPORTED/.test(code))) {
        runtime.disabledStreaming = true;
        await this.warning(id, runtime, '服务未接受流式请求，本次改用普通响应继续整理。');
        return this.model(id, runtime, profile, input, scope, recordIds);
      }
      throw error;
    } finally { signal.removeEventListener('abort', listener); }
  }
  private async images(id: string, runtime: Runtime, scope: TaskScope, profile: ModelProfile, mediaIds: string[]): Promise<ModelImage[]> {
    if (!scope.input.useImages || runtime.disabledVision || profile.capabilities.vision.status !== 'supported') return [];
    const selected = [...new Set(mediaIds)].filter(mediaId => scope.input.selectedMediaIds.includes(mediaId));
    const images: ModelImage[] = [];
    // A single request gets a bounded number of images; remaining selections are still available by caption.
    if (selected.length > 6) await this.warning(id, runtime, '每次请求最多发送 6 张照片，其余选中照片使用用户图注。');
    for (const mediaId of selected.slice(0, 6)) {
      const path = await this.write(id, runtime, () => {
        const sources = scope.snapshots.filter(record => record.media.some(media => media.id === mediaId)).map(record => record.id);
        assertScopeAvailable(this.store, scope, sources);
        if (!scope.mediaIds.includes(mediaId) || !sources.length) throw new AppError(400, 'AI_MEDIA_FORBIDDEN', '不能读取未授权的照片');
        const row = this.store.db.prepare('SELECT * FROM media WHERE id = ?').get(mediaId) as MediaRow | undefined;
        if (!row) throw new AppError(400, 'AI_MEDIA_UNAVAILABLE', '选中的照片已不可用');
        return join(this.store.dataDir, mediaFiles(row).thumbnail);
      });
      let buffer: Buffer;
      try { buffer = await readFile(path); }
      catch { throw new AppError(400, 'AI_MEDIA_UNAVAILABLE', '无法读取选中的照片，请检查数据目录或重新导入'); }
      images.push({ mediaId, dataUrl: `data:image/jpeg;base64,${buffer.toString('base64')}` });
    }
    return images;
  }
  private defaultPhotos(scope: TaskScope, records: AiSourceSnapshot[]): AiPhoto[] {
    const ids = [...new Set(records.flatMap(record => record.media.map(media => media.id)))];
    return ids.slice(0, 6).filter(id => scope.mediaIds.includes(id)).map(mediaId => {
      const source = records.find(record => record.media.some(media => media.id === mediaId))!;
      return { mediaId, caption: source.media.find(media => media.id === mediaId)!.caption, sourceRecordIds: [source.id] };
    });
  }
  private async stage(id: string, runtime: Runtime, scope: TaskScope, profile: ModelProfile, stage: Stage, index: number, total: number) {
    const ids = [...new Set(stage.records.map(record => record.id))];
    const saved = await this.write(id, runtime, () => {
      const row = this.store.db.prepare('SELECT content_json FROM ai_task_stages WHERE task_id = ? AND stage_key = ?').get(id, stage.key) as { content_json: string } | undefined;
      return row ? validateAiContent(this.store, scope, JSON.parse(row.content_json), ids) : null;
    });
    if (saved) return saved;
    await this.write(id, runtime, () => updateTask(this.store, id, { progress: Math.min(90, 5 + Math.floor(index / total * 80)), message: `正在整理 ${stage.label}（${index + 1}/${total}）` }));
    const images = await this.images(id, runtime, scope, profile, stage.records.flatMap(record => record.media.map(media => media.id)));
    const result = await this.model(id, runtime, profile, {
      system: editorSystem,
      messages: [{ role: 'user', text: userPrompt(scope.input, stage.records, stage.label, images.length ? `本次附加的图片按顺序对应：${images.map(image => image.mediaId).join('、')}` : '只使用已提供的文字和图片说明。'), images }],
    }, scope, ids);
    if (result.toolCalls.length) throw new AppError(422, 'AI_UNEXPECTED_TOOL_CALL', '当前为固定流程，模型返回了未请求的工具调用，请检查模型兼容性');
    const content = parseDraftText(result.text);
    if (!['title', 'questions', 'polish'].includes(scope.input.kind)) {
      if (!content.photos.length && !content.chapters.some(chapter => chapter.photos.length)) content.photos = this.defaultPhotos(scope, stage.records);
      if (scope.input.kind === 'monthly' && !content.highlights.length) content.highlights = content.paragraphs.slice(0, 3);
    }
    await this.write(id, runtime, () => {
      validateAiContent(this.store, scope, content, ids);
      this.store.db.prepare('INSERT OR IGNORE INTO ai_task_stages(task_id, stage_key, label, content_json, created_at) VALUES (?, ?, ?, ?, ?)').run(id, stage.key, stage.label, JSON.stringify(content), new Date().toISOString());
      updateTask(this.store, id, { result: taskResult(this.store, id), message: `已保存 ${stage.label} 的阶段草稿` });
    });
    return content;
  }
  private async runFixed(id: string, runtime: Runtime, scope: TaskScope, profile: ModelProfile): Promise<AiDraftContent> {
    const stages: Stage[] = [];
    if (scope.input.kind === 'yearbook') {
      for (let month = 1; month <= 12; month++) {
        const records = scope.snapshots.filter(record => Number(record.occurredOn?.slice(5, 7)) === month);
        materialBatches(records).forEach((batch, part) => stages.push({ key: `month-${String(month).padStart(2, '0')}-part-${String(part + 1).padStart(3, '0')}`, label: `${month} 月${part ? ` · 第 ${part + 1} 部分` : ''}`, records: batch }));
      }
    } else materialBatches(scope.snapshots).forEach((batch, index) => stages.push({ key: `part-${String(index + 1).padStart(3, '0')}`, label: `${scope.input.year ?? ''}${scope.input.month ? ` 年 ${scope.input.month} 月` : ''}素材${index ? ` · 第 ${index + 1} 部分` : ''}`, records: batch }));
    const contents: AiDraftContent[] = [];
    for (const [index, stage] of stages.entries()) contents.push(await this.stage(id, runtime, scope, profile, stage, index, stages.length));
    if (scope.input.kind !== 'yearbook') return combineDrafts(contents);
    const chapters: AiDraftChapter[] = [{ title: `${scope.input.year} · 一年一册`, kind: 'cover', paragraphs: [], photos: [] }];
    const monthlyChapters: AiDraftChapter[] = [];
    for (let month = 1; month <= 12; month++) {
      const monthContents = contents.filter((_content, index) => stages[index].key.startsWith(`month-${String(month).padStart(2, '0')}-`));
      if (!monthContents.length) continue;
      const monthContent = combineDrafts(monthContents);
      monthlyChapters.push({ title: `${month} 月`, kind: 'month', paragraphs: [...monthContent.paragraphs, ...monthContent.chapters.flatMap(chapter => chapter.paragraphs)], photos: [...monthContent.photos, ...monthContent.chapters.flatMap(chapter => chapter.photos)] });
    }
    let opening = await this.write(id, runtime, () => {
      const row = this.store.db.prepare("SELECT content_json FROM ai_task_stages WHERE task_id = ? AND stage_key = 'year-opening'").get(id) as { content_json: string } | undefined;
      return row ? validateAiContent(this.store, scope, JSON.parse(row.content_json)) : null;
    });
    if (!opening) {
      await this.write(id, runtime, () => updateTask(this.store, id, { progress: 92, message: '各月草稿已保存，正在汇总年度开篇' }));
      const summaries = monthlyChapters.map(chapter => ({ title: chapter.title, paragraphs: chapter.paragraphs.slice(0, 4).map(paragraph => ({ ...paragraph, text: paragraph.text.slice(0, 2000) })) }));
      const result = await this.model(id, runtime, profile, { system: editorSystem, messages: [{ role: 'user', text: `根据以下已完成的月份草稿汇总 ${scope.input.year} 年开篇，仅用 paragraphs 写一到两段，photos/highlights/questions/chapters 返回 []，保留有效原始来源 ID。不要超出资料事实。用户要求：${scope.input.instruction}\n月份草稿是资料：${JSON.stringify(summaries)}` }] }, scope);
      opening = parseDraftText(result.text);
      await this.write(id, runtime, () => {
        validateAiContent(this.store, scope, opening!);
        this.store.db.prepare('INSERT OR IGNORE INTO ai_task_stages(task_id, stage_key, label, content_json, created_at) VALUES (?, ?, ?, ?, ?)').run(id, 'year-opening', '年度开篇', JSON.stringify(opening), new Date().toISOString());
      });
    }
    chapters.push({ title: '这一年的开篇', kind: 'opening', paragraphs: opening.paragraphs, photos: [] }, ...monthlyChapters);
    const firsts = scope.snapshots.filter(record => record.isFirst);
    if (firsts.length) chapters.push({ title: '生活第一次', kind: 'firsts', paragraphs: firsts.filter(record => record.body || record.title).flatMap(record => ((record.body || record.title).match(/[\s\S]{1,12000}/g) ?? []).map(text => ({ text, sourceRecordIds: [record.id] }))), photos: this.defaultPhotos(scope, firsts) });
    const photos = monthlyChapters.flatMap(chapter => chapter.photos).filter((photo, index, all) => all.findIndex(other => other.mediaId === photo.mediaId) === index).slice(0, 100);
    if (photos.length) chapters.push({ title: '年度照片选集', kind: 'photos', paragraphs: [], photos });
    chapters.push({ title: '写给明年的自己', kind: 'letter', paragraphs: [], photos: [] });
    return { title: `${scope.input.year} · 一年一册`, paragraphs: [], highlights: [], questions: [], photos: [], chapters };
  }
  private async runAgent(id: string, runtime: Runtime, scope: TaskScope, profile: ModelProfile): Promise<AiDraftContent> {
    const retrievedIds = new Set<string>();
    const initial = await this.write(id, runtime, () => executeProjectTool('search_records', { limit: 20, offset: 0 }, { store: this.store, scope, retrievedIds, save: () => { throw new Error('read only'); } }));
    const messages: ModelMessage[] = [{ role: 'user', text: `用户任务：${scope.input.instruction}\n允许年份：${scope.input.year ?? '以选中的记录为准'}；可用记录总数 ${scope.recordIds.length}。程序已先检索本次授权范围，以下结果只是素材。继续用 search_records/get_records 检索符合任务的记录，再使用保存草稿工具。未在初步结果中的记录须通过工具读取，不猜测其内容。\n${JSON.stringify(initial.data)}` }];
    for (;;) {
      const task = await this.write(id, runtime, () => getTask(this.store, id));
      if (task.toolCalls >= scope.input.maxToolCalls) throw new AppError(400, 'AI_TOOL_LIMIT', '已达到本次任务的工具调用次数上限，请缩小任务范围或调高上限后重新生成');
      const result = await this.model(id, runtime, profile, { system: `${editorSystem}\n现在为受限工具模式，请用工具先检索后保存独立草稿。保存成功即任务完成。`, messages, tools: projectTools }, scope);
      messages.push({ role: 'assistant', text: result.text, toolCalls: result.toolCalls, providerItems: result.providerItems });
      if (!result.toolCalls.length) {
        const content = parseDraftText(result.text);
        await this.write(id, runtime, () => {
          validateAiContent(this.store, scope, content);
          for (const source of sourceEntries(content).flatMap(entry => entry.ids)) if (!retrievedIds.has(source)) throw new AppError(422, 'AI_SOURCE_NOT_RETRIEVED', '草稿引用了未检索的素材，请重试');
        });
        return content;
      }
      const pendingImageIds: string[] = [];
      for (const call of result.toolCalls) {
        await this.write(id, runtime, () => {
          const current = getTask(this.store, id);
          if (current.toolCalls >= scope.input.maxToolCalls) throw new AppError(400, 'AI_TOOL_LIMIT', '已达到本次任务的工具调用次数上限，未保存不完整草稿');
          updateTask(this.store, id, { toolCalls: current.toolCalls + 1, message: `助理正在检索和整理素材（工具 ${current.toolCalls + 1}/${scope.input.maxToolCalls}）`, progress: Math.min(90, 10 + current.toolCalls * 4) });
        });
        try {
          if (call.arguments.length > 1000000) throw new AppError(400, 'AI_TOOL_ARGUMENTS', '工具参数超过长度上限');
          const raw = JSON.parse(call.arguments);
          const output = await this.write(id, runtime, () => executeProjectTool(call.name, raw, { store: this.store, scope, retrievedIds, save: content => saveGeneratedDraft(this.store, id, content).id }));
          messages.push({ role: 'tool', callId: call.id, text: JSON.stringify(output.data) });
          if (output.draftId && output.content) return output.content;
          if (output.imageIds?.length) pendingImageIds.push(...output.imageIds);
        } catch (error) {
          if (runtime.controller.signal.aborted) throw error;
          const message = error instanceof AppError ? error.message : '工具参数或来源格式不正确，请按工具定义修正';
          messages.push({ role: 'tool', callId: call.id, text: JSON.stringify({ error: { code: error instanceof AppError ? error.code : 'AI_TOOL_ARGUMENTS', message } }) });
        }
      }
      // All sibling tool outputs must precede any new user message in both protocols.
      if (pendingImageIds.length) {
        const images = await this.images(id, runtime, scope, profile, pendingImageIds);
        if (images.length) messages.push({ role: 'user', text: `本次获准发送的照片按顺序对应：${images.map(image => image.mediaId).join('、')}。只描述确实可见的内容，不能推断人物身份、日期或地点。`, images });
      }
      if (JSON.stringify(messages).length > 350000) throw new AppError(400, 'AI_CONTEXT_LIMIT', '本次 Agent 对话超过可处理长度，请缩小素材范围后重试');
    }
  }
}
