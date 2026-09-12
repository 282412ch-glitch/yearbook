import { z } from 'zod';
import { idSchema, type AiDraftContent, type ModelToolDefinition } from '@yearbook/shared';
import type { DataStore } from '../db.js';
import { AppError } from '../errors.js';
import { assertScopeAvailable, sourceEntries, validateAiContent, type TaskScope } from './store.js';

const idsJson = { type: 'array', items: { type: 'string' } };
const paragraphJson = { type: 'object', properties: { text: { type: 'string' }, sourceRecordIds: idsJson }, required: ['text', 'sourceRecordIds'], additionalProperties: false };
const photoJson = { type: 'object', properties: { mediaId: { type: 'string' }, caption: { type: 'string' }, sourceRecordIds: idsJson }, required: ['mediaId', 'caption', 'sourceRecordIds'], additionalProperties: false };
export const draftJsonSchema: Record<string, unknown> = {
  type: 'object', properties: {
    title: { type: 'string' }, paragraphs: { type: 'array', items: paragraphJson }, highlights: { type: 'array', items: paragraphJson },
    questions: { type: 'array', items: { type: 'string' }, maxItems: 2 }, photos: { type: 'array', items: photoJson },
    chapters: { type: 'array', items: { type: 'object', properties: {
      title: { type: 'string' }, kind: { type: 'string', enum: ['cover', 'opening', 'month', 'firsts', 'photos', 'letter', 'custom'] },
      paragraphs: { type: 'array', items: paragraphJson }, photos: { type: 'array', items: photoJson },
    }, required: ['title', 'kind', 'paragraphs', 'photos'], additionalProperties: false } },
  }, required: ['title', 'paragraphs', 'highlights', 'questions', 'photos', 'chapters'], additionalProperties: false,
};
const object = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
export const projectTools: ModelToolDefinition[] = [
  { name: 'search_records', description: '在用户本次已授权的记录范围内搜索；不会扩大范围或读取未来信。支持人物、日期、标签和中文关键词；先检索再写作。空筛选使用 null。', parameters: object({ q: { type: ['string', 'null'] }, year: { type: ['integer', 'null'] }, month: { type: ['integer', 'null'] }, person: { type: ['string', 'null'] }, tag: { type: ['string', 'null'] }, firstOnly: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 30 }, offset: { type: 'integer', minimum: 0 } }) },
  { name: 'get_records', description: '读取已授权记录的原文分段。每条返回最多 12000 字，hasMore 表示仍有正文；用 offset 继续读取。人物和地点只使用原文信息。', parameters: object({ recordIds: { ...idsJson, maxItems: 8 }, offset: { type: 'integer', minimum: 0 } }) },
  { name: 'get_selected_media', description: '读取本次素材关联照片的 ID、用户图注和来源。仅显式勾选且模型图片能力已验证时，程序才会另行附加图片；返回内容不含任意文件路径。', parameters: object({ mediaIds: { ...idsJson, maxItems: 20 } }) },
  { name: 'create_summary_draft', description: '保存经过来源校验的独立月报或章节草稿，不会修改原始记录和年册。每段来源必须是本次已经检索或读取的有效记录。成功后结束任务。', parameters: object({ content: draftJsonSchema }) },
  { name: 'create_yearbook_draft', description: '保存经过来源校验的独立年册草稿，章节分别组织。不直接修改年册；必须由用户明确采用。生活第一次只可使用用户已标记的素材。成功后结束任务。', parameters: object({ content: draftJsonSchema }) },
];

const searchSchema = z.object({
  q: z.string().max(500).nullish(), year: z.number().int().min(1).max(9999).nullish(), month: z.number().int().min(1).max(12).nullish(),
  person: z.string().max(80).nullish(), tag: z.string().max(80).nullish(), firstOnly: z.boolean().default(false),
  limit: z.number().int().min(1).max(30).default(20), offset: z.number().int().min(0).max(2000).default(0),
}).strict();
type ToolContext = { store: DataStore; scope: TaskScope; retrievedIds: Set<string>; save: (content: AiDraftContent) => string };
export type ProjectToolResult = { data: unknown; draftId?: string; content?: AiDraftContent; imageIds?: string[] };
/** These five names are the entire execution surface. No terminal, file path or external fetch tool exists. */
export function executeProjectTool(name: string, raw: unknown, context: ToolContext): ProjectToolResult {
  const { store, scope, retrievedIds } = context;
  if (name === 'search_records') {
    const query = searchSchema.parse(raw);
    const all = scope.snapshots.filter(record => {
      const available = store.db.prepare('SELECT 1 FROM records WHERE id = ? AND deleted_at IS NULL').get(record.id);
      const text = [record.title, record.body, record.location, ...record.people, ...record.tags, ...record.media.map(media => media.caption), ...record.reflections.map(reflection => reflection.body)].join('\n');
      return !!available && (!query.q?.trim() || text.includes(query.q.trim())) &&
        (!query.year || record.occurredOn?.slice(0, 4) === String(query.year).padStart(4, '0')) &&
        (!query.month || Number(record.occurredOn?.slice(5, 7)) === query.month) &&
        (!query.person || record.people.includes(query.person)) && (!query.tag || record.tags.includes(query.tag)) &&
        (!query.firstOnly || record.isFirst);
    });
    const records = all.slice(query.offset, query.offset + query.limit);
    records.forEach(record => retrievedIds.add(record.id));
    return { data: { total: all.length, offset: query.offset, records: records.map(record => ({ id: record.id, title: record.title, occurredOn: record.occurredOn, people: record.people, tags: record.tags, isFirst: record.isFirst, excerpt: record.body.slice(0, 400), hasMore: record.body.length > 400, photoCount: record.media.length })) } };
  }
  if (name === 'get_records') {
    const query = z.object({ recordIds: z.array(idSchema).min(1).max(8), offset: z.number().int().min(0).max(100000).default(0) }).strict().parse(raw);
    assertScopeAvailable(store, scope, query.recordIds);
    const records = query.recordIds.map(id => {
      retrievedIds.add(id);
      const record = scope.snapshots.find(record => record.id === id)!;
      return { ...record, body: record.body.slice(query.offset, query.offset + 12000), offset: query.offset,
        hasMore: record.body.length > query.offset + 12000,
        reflections: record.reflections.map(reflection => ({ ...reflection, body: reflection.body.slice(0, 2000), truncated: reflection.body.length > 2000 })),
        media: record.media.map(media => ({ ...media, caption: media.caption.slice(0, 1000) })) };
    });
    return { data: { records } };
  }
  if (name === 'get_selected_media') {
    const query = z.object({ mediaIds: z.array(idSchema).max(20) }).strict().parse(raw);
    if (query.mediaIds.some(id => !scope.mediaIds.includes(id))) throw new AppError(400, 'AI_MEDIA_FORBIDDEN', '只能读取本次任务授权素材关联的照片');
    const photos = query.mediaIds.map(id => {
      const sources = scope.snapshots.filter(record => record.media.some(media => media.id === id));
      assertScopeAvailable(store, scope, sources.map(source => source.id));
      sources.forEach(record => retrievedIds.add(record.id));
      return { mediaId: id, caption: sources[0]?.media.find(media => media.id === id)?.caption ?? '', sourceRecordIds: sources.map(source => source.id), imageTransmissionSelected: scope.input.useImages && scope.input.selectedMediaIds.includes(id) };
    });
    return { data: { photos }, imageIds: query.mediaIds };
  }
  if (name === 'create_summary_draft' || name === 'create_yearbook_draft') {
    const { content: rawContent } = z.object({ content: z.unknown() }).strict().parse(raw);
    const content = validateAiContent(store, scope, rawContent);
    for (const source of sourceEntries(content).flatMap(entry => entry.ids)) if (!retrievedIds.has(source)) throw new AppError(400, 'AI_SOURCE_NOT_RETRIEVED', '请先检索或读取来源记录，再保存相关段落');
    if (name === 'create_yearbook_draft' && !content.chapters.length) throw new AppError(400, 'AI_CHAPTERS_REQUIRED', '年册草稿需要包含可编辑章节');
    const draftId = context.save(content);
    return { data: { draftId, saved: true, message: '独立草稿已保存，需用户明确采用；原记录和年册未修改' }, draftId, content };
  }
  throw new AppError(400, 'AI_TOOL_NOT_ALLOWED', '此工具不在本项目允许的工具范围内');
}
