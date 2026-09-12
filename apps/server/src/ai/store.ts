import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  aiDraftContentSchema, aiTaskInputSchema, idSchema, recordInputSchema, yearbookInputSchema,
  type AiAdoptResult, type AiDraftContent, type AiDraftItem, type AiDraftVersion, type AiMode,
  type AiPhoto, type AiSourceSnapshot, type AiTaskDetail, type AiTaskInput, type AiTaskResult, type AiUsage,
  type RecordItem, type YearbookInput,
} from '@yearbook/shared';
import type { DataStore } from '../db.js';
import { AppError } from '../errors.js';
import { getRecord } from '../records.js';
import { createTask, getTask } from '../tasks.js';
import { createYearbookVersion, getYearbook, saveYearbook } from '../yearbooks.js';

export type AiTaskRow = {
  task_id: string; request_json: string; scope_record_ids_json: string; scope_media_ids_json: string;
  source_snapshots_json: string; mode: AiMode; warnings_json: string; usage_json: string | null; scope_key: string; created_at: string;
};
type DraftRow = {
  id: string; task_id: string; kind: AiTaskInput['kind']; mode: AiMode; year: number | null; month: number | null;
  scope_key: string; version_no: number; content_json: string; status: 'draft' | 'adopted'; adopted_yearbook_id: string | null;
  warnings_json: string; created_at: string; updated_at: string;
};
export type TaskScope = { input: AiTaskInput; recordIds: string[]; mediaIds: string[]; snapshots: AiSourceSnapshot[]; row: AiTaskRow };
export function getAiScope(store: DataStore, taskId: string): TaskScope {
  const row = store.db.prepare('SELECT * FROM ai_task_inputs WHERE task_id = ?').get(idSchema.parse(taskId)) as AiTaskRow | undefined;
  if (!row) throw new AppError(404, 'AI_TASK_NOT_FOUND', '这个 AI 任务不存在');
  return { input: aiTaskInputSchema.parse(JSON.parse(row.request_json)), recordIds: JSON.parse(row.scope_record_ids_json), mediaIds: JSON.parse(row.scope_media_ids_json), snapshots: JSON.parse(row.source_snapshots_json), row };
}
function snapshot(record: RecordItem): AiSourceSnapshot {
  return { id: record.id, title: record.title, body: record.body, occurredOn: record.occurredOn, people: record.people,
    location: record.location, tags: record.tags, isFirst: record.isFirst, updatedAt: record.updatedAt,
    reflections: record.reflections.map(({ body, createdAt }) => ({ body, createdAt })),
    media: record.media.map(({ id, caption }) => ({ id, caption })) };
}
export function assertScopeAvailable(store: DataStore, scope: TaskScope, ids = scope.recordIds) {
  const allowed = new Set(scope.recordIds);
  for (const id of ids) {
    if (!allowed.has(id)) throw new AppError(400, 'AI_SOURCE_FORBIDDEN', '草稿引用了本次任务未授权的记录');
    const row = store.db.prepare('SELECT deleted_at FROM records WHERE id = ?').get(id) as { deleted_at: string | null } | undefined;
    if (!row || row.deleted_at) throw new AppError(409, 'AI_SOURCE_UNAVAILABLE', '本次素材中的记录已删除或不存在，请恢复记录或重新选择素材');
  }
}
export function prepareAiTask(store: DataStore, raw: unknown, mode: AiMode, warnings: string[] = []) {
  const input = aiTaskInputSchema.parse(raw);
  if (input.idempotencyKey) {
    const previous = store.db.prepare("SELECT id FROM tasks WHERE kind = 'ai' AND idempotency_key = ?").get(input.idempotencyKey) as { id: string } | undefined;
    if (previous) {
      const old = getAiScope(store, previous.id);
      if (JSON.stringify(old.input) !== JSON.stringify(input)) throw new AppError(409, 'IDEMPOTENCY_CONFLICT', '这个提交编号已用于另一项任务，请刷新后重试');
      return getTask(store, previous.id);
    }
  }
  let ids = input.recordIds;
  if (!ids.length) {
    const rows = store.db.prepare(`SELECT id FROM records WHERE deleted_at IS NULL AND include_in_yearbook = 1
      AND substr(occurred_on, 1, 4) = ? ${input.month ? 'AND substr(occurred_on, 6, 2) = ?' : ''}
      ORDER BY occurred_on, created_at, id LIMIT 2001`).all(...[String(input.year).padStart(4, '0'), ...(input.month ? [String(input.month).padStart(2, '0')] : [])]) as { id: string }[];
    ids = rows.map(row => row.id);
  }
  if (!ids.length) throw new AppError(400, 'AI_NO_MATERIAL', '这个范围还没有可整理的记录。先保存素材，或调整年份和月份');
  if (ids.length > 2000) throw new AppError(400, 'AI_TOO_MUCH_MATERIAL', '一次最多选择 2000 条记录，请缩小素材范围');
  const records = ids.map(id => getRecord(store, id));
  for (const record of records) {
    if (record.deletedAt) throw new AppError(409, 'AI_SOURCE_UNAVAILABLE', '请先恢复已删除的记录，再选择为素材');
    if (input.year && (!record.occurredOn || record.occurredOn.slice(0, 4) !== String(input.year).padStart(4, '0')) ||
      input.month && (!record.occurredOn || Number(record.occurredOn.slice(5, 7)) !== input.month)) throw new AppError(400, 'AI_SOURCE_OUTSIDE_DATE', '选中的记录不属于指定年份或月份');
  }
  if (input.yearbookId) getYearbook(store, input.yearbookId);
  const mediaIds = [...new Set(records.flatMap(record => record.media.map(media => media.id)))];
  if (input.selectedMediaIds.some(id => !mediaIds.includes(id))) throw new AppError(400, 'AI_MEDIA_FORBIDDEN', '只能选择本次记录关联的照片');
  const scopeKey = createHash('sha256').update(JSON.stringify({ kind: input.kind, year: input.year, month: input.month, ids: [...ids].sort() })).digest('hex');
  return store.db.transaction(() => {
    const task = createTask(store, { kind: 'ai', yearbookId: input.yearbookId, maxDurationMs: input.maxDurationMs, idempotencyKey: input.idempotencyKey });
    store.db.prepare(`INSERT INTO ai_task_inputs (task_id, request_json, scope_record_ids_json, scope_media_ids_json,
      source_snapshots_json, mode, warnings_json, scope_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(task.id, JSON.stringify(input), JSON.stringify(ids), JSON.stringify(mediaIds), JSON.stringify(records.map(snapshot)), mode, JSON.stringify(warnings), scopeKey, task.createdAt);
    return task;
  })();
}

export function sourceEntries(content: AiDraftContent) {
  const entries: { path: string; ids: string[]; photo?: AiPhoto; firsts?: boolean }[] = [];
  content.paragraphs.forEach((paragraph, i) => entries.push({ path: `paragraphs.${i}`, ids: paragraph.sourceRecordIds }));
  content.highlights.forEach((paragraph, i) => entries.push({ path: `highlights.${i}`, ids: paragraph.sourceRecordIds }));
  content.photos.forEach((photo, i) => entries.push({ path: `photos.${i}`, ids: photo.sourceRecordIds, photo }));
  content.chapters.forEach((chapter, c) => {
    chapter.paragraphs.forEach((paragraph, i) => entries.push({ path: `chapters.${c}.paragraphs.${i}`, ids: paragraph.sourceRecordIds, firsts: chapter.kind === 'firsts' }));
    chapter.photos.forEach((photo, i) => entries.push({ path: `chapters.${c}.photos.${i}`, ids: photo.sourceRecordIds, photo, firsts: chapter.kind === 'firsts' }));
  });
  return entries;
}
/** Validation is repeated at generation, edit and adoption; model output never grants a new permission. */
export function validateAiContent(store: DataStore, scope: TaskScope, raw: unknown, stageIds = scope.recordIds): AiDraftContent {
  let content: AiDraftContent;
  try { content = aiDraftContentSchema.parse(raw); }
  catch { throw new AppError(422, 'AI_RESPONSE_STRUCTURE', '模型返回的草稿结构或来源格式不符合要求，请重试或更换模型'); }
  const stageScope = { ...scope, recordIds: stageIds };
  assertScopeAvailable(store, scope, stageIds);
  const paragraphs = [...content.paragraphs, ...content.highlights, ...content.chapters.flatMap(chapter => chapter.paragraphs)];
  if (scope.input.kind === 'questions' && (content.questions.length < 1 || content.questions.length > 2)) throw new AppError(422, 'AI_RESPONSE_STRUCTURE', '补充问题应包含一到两个问题');
  if (!['title', 'questions'].includes(scope.input.kind) && !paragraphs.length) throw new AppError(422, 'AI_RESPONSE_STRUCTURE', '模型没有返回可编辑的正文及来源');
  for (const entry of sourceEntries(content)) {
    assertScopeAvailable(store, stageScope, entry.ids);
    if (entry.photo) {
      if (!scope.mediaIds.includes(entry.photo.mediaId)) throw new AppError(422, 'AI_MEDIA_FORBIDDEN', '模型选择了未授权的照片');
      for (const recordId of entry.ids) {
        const original = scope.snapshots.find(record => record.id === recordId);
        if (!original?.media.some(media => media.id === entry.photo!.mediaId) || !store.db.prepare('SELECT 1 FROM record_media WHERE record_id = ? AND media_id = ?').get(recordId, entry.photo.mediaId)) throw new AppError(422, 'AI_PHOTO_SOURCE_MISMATCH', '照片与所引用的原始记录不匹配');
      }
    }
    if (entry.firsts) for (const id of entry.ids) {
      const first = store.db.prepare('SELECT is_first FROM records WHERE id = ?').get(id) as { is_first: number };
      if (!scope.snapshots.find(record => record.id === id)?.isFirst || !first.is_first) throw new AppError(422, 'AI_FIRST_NOT_MARKED', '生活第一次只能使用由你主动标记的记录');
    }
  }
  return content;
}

function presentDraft(store: DataStore, row: DraftRow): AiDraftItem {
  const scope = getAiScope(store, row.task_id);
  const sourceRecordIds = (store.db.prepare('SELECT DISTINCT record_id FROM ai_draft_sources WHERE draft_id = ? ORDER BY record_id').all(row.id) as { record_id: string }[]).map(source => source.record_id);
  return { id: row.id, taskId: row.task_id, kind: row.kind, mode: row.mode, year: row.year, month: row.month,
    content: aiDraftContentSchema.parse(JSON.parse(row.content_json)), sourceRecordIds, scopeRecordIds: scope.recordIds,
    sourceSnapshots: scope.snapshots, versionNo: row.version_no, status: row.status, adoptedYearbookId: row.adopted_yearbook_id,
    warnings: JSON.parse(row.warnings_json), createdAt: row.created_at, updatedAt: row.updated_at };
}
export function getAiDraft(store: DataStore, id: string): AiDraftItem {
  const row = store.db.prepare('SELECT * FROM ai_drafts WHERE id = ?').get(idSchema.parse(id)) as DraftRow | undefined;
  if (!row) throw new AppError(404, 'AI_DRAFT_NOT_FOUND', '这份 AI 草稿不存在');
  return presentDraft(store, row);
}
export function findTaskDraft(store: DataStore, taskId: string) {
  const row = store.db.prepare('SELECT * FROM ai_drafts WHERE task_id = ?').get(taskId) as DraftRow | undefined;
  return row ? presentDraft(store, row) : null;
}
function saveSourceLinks(store: DataStore, draftId: string, content: AiDraftContent, scope: TaskScope) {
  store.db.prepare('DELETE FROM ai_draft_sources WHERE draft_id = ?').run(draftId);
  store.db.prepare('DELETE FROM ai_draft_media WHERE draft_id = ?').run(draftId);
  const entries = sourceEntries(content);
  // Keep the material permission set separate from the records actually cited in this draft.
  const cited = [...new Set(entries.flatMap(entry => entry.ids))];
  for (const id of cited.length ? cited : scope.recordIds) store.db.prepare('INSERT INTO ai_draft_sources(draft_id, source_path, record_id) VALUES (?, ?, ?)').run(draftId, 'scope', id);
  for (const entry of entries) {
    for (const id of entry.ids) store.db.prepare('INSERT INTO ai_draft_sources(draft_id, source_path, record_id) VALUES (?, ?, ?)').run(draftId, entry.path, id);
    if (entry.photo) store.db.prepare('INSERT OR IGNORE INTO ai_draft_media(draft_id, media_id) VALUES (?, ?)').run(draftId, entry.photo.mediaId);
  }
}
export function saveGeneratedDraft(store: DataStore, taskId: string, raw: unknown) {
  const existing = findTaskDraft(store, taskId);
  if (existing) return existing;
  const scope = getAiScope(store, taskId);
  const content = validateAiContent(store, scope, raw);
  const id = randomUUID(); const now = new Date().toISOString();
  store.db.transaction(() => {
    const versionNo = ((store.db.prepare('SELECT MAX(version_no) AS n FROM ai_drafts WHERE scope_key = ?').get(scope.row.scope_key) as { n: number | null }).n ?? 0) + 1;
    store.db.prepare(`INSERT INTO ai_drafts(id, task_id, kind, mode, year, month, scope_key, version_no, content_json, warnings_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, taskId, scope.input.kind, scope.row.mode, scope.input.year ?? null, scope.input.month ?? null, scope.row.scope_key, versionNo, JSON.stringify(content), scope.row.warnings_json, now, now);
    saveSourceLinks(store, id, content, scope);
    store.db.prepare('INSERT INTO ai_draft_versions(id, draft_id, revision, source, content_json, created_at) VALUES (?, ?, 1, ?, ?, ?)').run(randomUUID(), id, 'generated', JSON.stringify(content), now);
  })();
  return getAiDraft(store, id);
}
export function editAiDraft(store: DataStore, id: string, raw: unknown) {
  const old = getAiDraft(store, id); const scope = getAiScope(store, old.taskId);
  const content = validateAiContent(store, scope, raw); const now = new Date().toISOString();
  store.db.transaction(() => {
    store.db.prepare('UPDATE ai_drafts SET content_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(content), now, id);
    saveSourceLinks(store, id, content, scope);
    const revision = (store.db.prepare('SELECT MAX(revision) AS n FROM ai_draft_versions WHERE draft_id = ?').get(id) as { n: number }).n + 1;
    store.db.prepare('INSERT INTO ai_draft_versions(id, draft_id, revision, source, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(randomUUID(), id, revision, 'manual', JSON.stringify(content), now);
  })();
  return getAiDraft(store, id);
}
export function listAiDrafts(store: DataStore, raw: unknown = {}) {
  const query = z.object({ kind: z.enum(['title', 'polish', 'questions', 'monthly', 'chapter', 'yearbook', 'agent']).optional(), year: z.coerce.number().int().min(1).max(9999).optional(), month: z.coerce.number().int().min(1).max(12).optional(), recordId: idSchema.optional(), limit: z.coerce.number().int().min(1).max(100).default(30), offset: z.coerce.number().int().min(0).default(0) }).parse(raw);
  const clauses: string[] = []; const values: (string | number)[] = [];
  for (const key of ['kind', 'year', 'month'] as const) if (query[key] != null) { clauses.push(`d.${key} = ?`); values.push(query[key]!); }
  if (query.recordId) { clauses.push('EXISTS(SELECT 1 FROM ai_draft_sources s WHERE s.draft_id = d.id AND s.record_id = ?)'); values.push(query.recordId); }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const total = (store.db.prepare(`SELECT COUNT(*) AS n FROM ai_drafts d${where}`).get(...values) as { n: number }).n;
  const rows = store.db.prepare(`SELECT d.* FROM ai_drafts d${where} ORDER BY d.created_at DESC, d.id DESC LIMIT ? OFFSET ?`).all(...values, query.limit, query.offset) as DraftRow[];
  return { total, items: rows.map(row => presentDraft(store, row)) };
}
export function listAiDraftVersions(store: DataStore, id: string): AiDraftVersion[] {
  getAiDraft(store, id);
  return (store.db.prepare('SELECT * FROM ai_draft_versions WHERE draft_id = ? ORDER BY revision DESC').all(id) as { id: string; draft_id: string; revision: number; source: 'generated' | 'manual'; content_json: string; created_at: string }[])
    .map(row => ({ id: row.id, draftId: row.draft_id, revision: row.revision, source: row.source, content: JSON.parse(row.content_json), createdAt: row.created_at }));
}

export function getAiTaskDetail(store: DataStore, id: string): AiTaskDetail {
  const scope = getAiScope(store, id);
  const stages = (store.db.prepare('SELECT * FROM ai_task_stages WHERE task_id = ? ORDER BY stage_key').all(id) as { stage_key: string; label: string; content_json: string; created_at: string }[])
    .map(row => ({ key: row.stage_key, label: row.label, status: 'completed' as const, content: JSON.parse(row.content_json) as AiDraftContent, createdAt: row.created_at }));
  return { task: getTask(store, id), request: scope.input, mode: scope.row.mode, stages, usage: scope.row.usage_json ? JSON.parse(scope.row.usage_json) as AiUsage : null, warnings: JSON.parse(scope.row.warnings_json) };
}
export function taskResult(store: DataStore, taskId: string, draftId?: string): AiTaskResult {
  const detail = getAiTaskDetail(store, taskId);
  return { ...(draftId ? { draftId } : {}), mode: detail.mode, usage: detail.usage, completedStages: detail.stages.length, warnings: detail.warnings };
}
export function addUsage(store: DataStore, taskId: string, usage: AiUsage | undefined | null) {
  if (!usage) return;
  const old = getAiScope(store, taskId).row.usage_json;
  const previous: AiUsage = old ? JSON.parse(old) : {};
  for (const field of ['inputTokens', 'outputTokens', 'totalTokens'] as const) {
    const value = usage[field];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) previous[field] = (previous[field] ?? 0) + value;
  }
  if (Object.keys(previous).length) store.db.prepare('UPDATE ai_task_inputs SET usage_json = ? WHERE task_id = ?').run(JSON.stringify(previous), taskId);
}

function asYearbookContent(draft: AiDraftItem): YearbookInput['chapters'] {
  const convert = (title: string, kind: YearbookInput['chapters'][number]['kind'], paragraphs: AiDraftContent['paragraphs'], photos: AiPhoto[]) => ({
    kind, title, body: '', sourceRecordIds: [...new Set([...paragraphs.flatMap(p => p.sourceRecordIds), ...photos.flatMap(p => p.sourceRecordIds)])],
    blocks: [...paragraphs.map(paragraph => ({ type: 'paragraph' as const, body: paragraph.text, mediaId: null, recordId: paragraph.sourceRecordIds[0] ?? null, caption: '' })),
      ...photos.map(photo => ({ type: 'image' as const, body: '', mediaId: photo.mediaId, recordId: photo.sourceRecordIds[0] ?? null, caption: photo.caption }))],
  });
  const chapters = draft.content.chapters.map(chapter => convert(chapter.title, chapter.kind, chapter.paragraphs, chapter.photos));
  if (draft.content.paragraphs.length || draft.content.highlights.length || draft.content.photos.length) chapters.unshift(convert(draft.content.title, draft.kind === 'monthly' ? 'month' : 'custom', [...draft.content.highlights, ...draft.content.paragraphs], draft.content.photos));
  return chapters;
}
export function adoptAiDraft(store: DataStore, id: string, targetYearbookId?: string | null): AiAdoptResult {
  let draft = getAiDraft(store, id); const scope = getAiScope(store, draft.taskId);
  validateAiContent(store, scope, draft.content);
  if (['title', 'polish', 'questions'].includes(draft.kind)) {
    const record = getRecord(store, scope.recordIds[0]);
    if (draft.kind === 'questions') return { draft, recordId: record.id, message: '补充问题已保留在草稿中，请按自己的意愿回答；记录尚未修改' };
    const recordProposal = recordInputSchema.parse({ title: draft.kind === 'title' ? draft.content.title : record.title,
      body: draft.kind === 'polish' ? draft.content.paragraphs.map(p => p.text).join('\n\n') : record.body,
      occurredOn: record.occurredOn, people: record.people, tags: record.tags, location: record.location,
      isFirst: record.isFirst, includeInYearbook: record.includeInYearbook, media: record.media.map(({ id, caption }) => ({ id, caption })) });
    return { draft, recordId: record.id, recordProposal, message: '建议已准备好，请在记录编辑页确认后保存。原始素材快照仍保留在此草稿中' };
  }
  if (draft.status === 'adopted') {
    if (targetYearbookId && targetYearbookId !== draft.adoptedYearbookId) throw new AppError(409, 'AI_DRAFT_ALREADY_ADOPTED', '这份草稿已采用，重复点击不会再创建章节。请生成新版本后使用');
    return { draft, yearbookId: draft.adoptedYearbookId ?? undefined, message: '这份草稿已采用，可继续编辑对应年册' };
  }
  const target = targetYearbookId === null ? undefined : targetYearbookId ?? scope.input.yearbookId;
  const old = target ? getYearbook(store, target) : null;
  const year = draft.year ?? old?.year ?? Number(scope.snapshots.find(record => record.occurredOn)?.occurredOn?.slice(0, 4));
  if (!year || year < 1) throw new AppError(400, 'AI_YEAR_REQUIRED', '请先在年册中选定年份，再采用这份章节草稿');
  const additions = asYearbookContent(draft);
  const currentInput = old ? yearbookInputSchema.parse({ year: old.year, title: old.title, template: old.template, coverMediaId: old.coverMediaId, introBody: old.introBody,
    chapters: old.chapters.map(chapter => ({ id: chapter.id, kind: chapter.kind, title: chapter.title, body: chapter.body, sourceRecordIds: chapter.sourceRecordIds,
      blocks: chapter.blocks.map(block => ({ id: block.id, type: block.type, body: block.body, mediaId: block.mediaId, recordId: block.recordId, caption: block.caption })) })) }) : null;
  const input: YearbookInput = { year: draft.kind === 'yearbook' ? year : old?.year ?? year,
    title: draft.kind === 'yearbook' ? draft.content.title : old?.title ?? draft.content.title,
    template: old?.template ?? 'text', coverMediaId: old?.coverMediaId ?? draft.content.photos[0]?.mediaId ?? draft.content.chapters.flatMap(chapter => chapter.photos)[0]?.mediaId ?? null,
    introBody: draft.kind === 'yearbook' ? '' : old?.introBody ?? '', chapters: draft.kind === 'yearbook' ? additions : [...(currentInput?.chapters ?? []), ...additions] };
  const book = store.db.transaction(() => {
    if (currentInput && target) createYearbookVersion(store, target, currentInput, 'manual', '采用 AI 草稿前的编辑稿');
    const saved = saveYearbook(store, input, target, 'ai');
    store.db.prepare("UPDATE ai_drafts SET status = 'adopted', adopted_yearbook_id = ?, updated_at = ? WHERE id = ?").run(saved.id, new Date().toISOString(), id);
    return saved;
  })();
  draft = getAiDraft(store, id);
  return { draft, yearbookId: book.id, message: '草稿已采用，之前的年册编辑稿已保存在版本记录中' };
}
