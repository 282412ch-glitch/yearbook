import type Database from 'better-sqlite3';
import { z } from 'zod';
import { aiDraftContentSchema, aiTaskInputSchema, dateSchema, idSchema, modelCapabilitiesSchema, modelProfileInputSchema, type AiDraftContent } from '@yearbook/shared';
import { credentialReferencePattern } from './models/credentials.js';
import type { ProfileRow } from './models/service.js';
import { sourceEntries } from './ai/store.js';

const idsSchema = z.array(idSchema).max(2000).refine(ids => new Set(ids).size === ids.length);
const photoSnapshot = z.object({ id: idSchema, caption: z.string().max(1000) }).strict();
const snapshotSchema = z.object({
  id: idSchema, title: z.string().max(200), body: z.string().max(100000), occurredOn: dateSchema.nullable(),
  people: z.array(z.string().min(1).max(80)).max(30), location: z.string().max(300), tags: z.array(z.string().min(1).max(80)).max(30),
  isFirst: z.boolean(), updatedAt: z.string().datetime(),
  reflections: z.array(z.object({ body: z.string().min(1).max(20000), createdAt: z.string().datetime() }).strict()),
  media: z.array(photoSnapshot).max(100),
}).strict();
const snapshotsSchema = z.array(snapshotSchema).max(2000);
const warningsSchema = z.array(z.string().max(2000)).max(100);
const usageSchema = z.object({ inputTokens: z.number().int().nonnegative().optional(), outputTokens: z.number().int().nonnegative().optional(), totalTokens: z.number().int().nonnegative().optional() }).strict();
const equal = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/** Historical source snapshots remain valid even when the live record is soft-deleted or edited. */
export function validateAiBackupData(db: Database.Database, version: number) {
  if (version < 3) return;
  for (const row of db.prepare('SELECT * FROM model_profiles').all() as ProfileRow[]) {
    idSchema.parse(row.id);
    modelProfileInputSchema.parse({ name: row.name, protocol: row.protocol, baseUrl: row.base_url, model: row.model, timeoutMs: row.timeout_ms,
      maxOutputTokens: row.max_output_tokens, streamEnabled: !!row.stream_enabled, credentialMode: row.credential_mode });
    if (row.credential_ref !== null && !credentialReferencePattern.test(row.credential_ref)) throw new Error('模型凭据引用无效');
    if (row.credential_mode === 'none' && row.credential_ref) throw new Error('无密钥模式不应持有凭据引用');
    z.string().datetime().parse(row.created_at); z.string().datetime().parse(row.updated_at);
    modelCapabilitiesSchema.parse(JSON.parse(row.capabilities_json));
  }
  if (version < 4) return;
  type Scope = { ids: string[]; media: string[]; snapshots: z.infer<typeof snapshotsSchema> };
  const scopes = new Map<string, Scope>();
  const exists = (table: 'records' | 'media', id: string) => !!db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id);
  for (const row of db.prepare('SELECT * FROM ai_task_inputs').all() as Record<string, any>[]) {
    idSchema.parse(row.task_id); const input = aiTaskInputSchema.parse(JSON.parse(row.request_json));
    const ids = idsSchema.parse(JSON.parse(row.scope_record_ids_json));
    const media = z.array(idSchema).max(200000).refine(ids => new Set(ids).size === ids.length).parse(JSON.parse(row.scope_media_ids_json));
    const snapshots = snapshotsSchema.parse(JSON.parse(row.source_snapshots_json));
    if (!ids.length || !equal(ids, snapshots.map(record => record.id)) || ids.some(id => !exists('records', id))) throw new Error('AI 任务来源范围无效');
    if (input.recordIds.some(id => !ids.includes(id)) || input.selectedMediaIds.some(id => !media.includes(id))) throw new Error('AI 任务请求与授权范围不一致');
    if (!equal(media, [...new Set(snapshots.flatMap(record => record.media.map(photo => photo.id)))])) throw new Error('AI 素材快照中的照片范围不完整');
    if (media.some(id => !exists('media', id))) throw new Error('AI 素材引用不存在的照片');
    warningsSchema.parse(JSON.parse(row.warnings_json)); if (row.usage_json) usageSchema.parse(JSON.parse(row.usage_json));
    if ((db.prepare('SELECT kind FROM tasks WHERE id = ?').get(row.task_id) as { kind: string })?.kind !== 'ai') throw new Error('AI 任务类型不匹配');
    scopes.set(row.task_id, { ids, media, snapshots });
  }
  const validateContent = (raw: string, scope: Scope): AiDraftContent => {
    const content = aiDraftContentSchema.parse(JSON.parse(raw));
    for (const entry of sourceEntries(content)) {
      if (entry.ids.some(id => !scope.ids.includes(id))) throw new Error('AI 草稿含范围外来源');
      if (entry.photo && (!scope.media.includes(entry.photo.mediaId) || entry.ids.some(id => !scope.snapshots.find(record => record.id === id)?.media.some(photo => photo.id === entry.photo!.mediaId)))) throw new Error('AI 草稿照片与来源快照不一致');
      if (entry.firsts && entry.ids.some(id => !scope.snapshots.find(record => record.id === id)?.isFirst)) throw new Error('AI 第一次章节缺少用户原始标记');
    }
    return content;
  };
  for (const row of db.prepare('SELECT * FROM ai_task_stages').all() as Record<string, any>[]) {
    const scope = scopes.get(row.task_id); if (!scope) throw new Error('AI 阶段缺少任务范围');
    z.string().min(1).max(200).parse(row.stage_key); z.string().max(300).parse(row.label); z.string().datetime().parse(row.created_at);
    validateContent(row.content_json, scope);
  }
  for (const row of db.prepare('SELECT * FROM ai_drafts').all() as Record<string, any>[]) {
    idSchema.parse(row.id); const scope = scopes.get(row.task_id); if (!scope) throw new Error('AI 草稿缺少任务范围');
    const content = validateContent(row.content_json, scope);
    const cited = [...new Set(sourceEntries(content).flatMap(entry => entry.ids))];
    const pairs = [...(cited.length ? cited : scope.ids).map(id => `scope:${id}`), ...sourceEntries(content).flatMap(entry => entry.ids.map(id => `${entry.path}:${id}`))];
    const links = db.prepare('SELECT source_path,record_id FROM ai_draft_sources WHERE draft_id = ?').all(row.id) as { source_path: string; record_id: string }[];
    if (!equal(pairs, links.map(link => `${link.source_path}:${link.record_id}`))) throw new Error('AI 草稿逐段来源关联不完整');
    const images = [...new Set(sourceEntries(content).flatMap(entry => entry.photo ? [entry.photo.mediaId] : []))];
    const imageLinks = db.prepare('SELECT media_id FROM ai_draft_media WHERE draft_id = ?').all(row.id) as { media_id: string }[];
    if (!equal(images, imageLinks.map(link => link.media_id))) throw new Error('AI 草稿照片关联不完整');
    warningsSchema.parse(JSON.parse(row.warnings_json)); z.string().datetime().parse(row.created_at); z.string().datetime().parse(row.updated_at);
    const versions = db.prepare('SELECT * FROM ai_draft_versions WHERE draft_id = ? ORDER BY revision').all(row.id) as Record<string, any>[];
    if (!versions.length) throw new Error('AI 草稿缺少原始版本');
    versions.forEach((revision, index) => { if (revision.revision !== index + 1) throw new Error('AI 草稿版本不连续'); idSchema.parse(revision.id); z.string().datetime().parse(revision.created_at); validateContent(revision.content_json, scope); });
  }
}
