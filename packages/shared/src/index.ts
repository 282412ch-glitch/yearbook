import { z } from 'zod';
export * from './models.js';
export * from './ai.js';
export * from './letters.js';

/** Calendar dates are local civil dates, never converted through UTC. */
export function localDate(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function isLocalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}
export const dateSchema = z.string().refine(isLocalDate, '请填写有效日期');
export const idSchema = z.string().uuid('无效的编号');
const namesSchema = z.array(z.string().trim().min(1).max(80)).max(30).transform(items => [...new Set(items)]);
export const mediaSelectionSchema = z.object({ id: idSchema, caption: z.string().max(1000).default('') });
export const recordInputSchema = z.object({
  title: z.string().trim().max(200).default(''),
  body: z.string().max(100000).default(''),
  occurredOn: dateSchema.nullable().default(null),
  people: namesSchema.default([]),
  location: z.string().trim().max(300).default(''),
  tags: namesSchema.default([]),
  isFirst: z.boolean().default(false),
  includeInYearbook: z.boolean().default(true),
  media: z.array(mediaSelectionSchema).max(100).default([]),
}).strict().superRefine((value, ctx) => {
  if (!value.body.trim() && !value.title.trim() && !value.media.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['body'], message: '写下一句话，或添加一张照片再保存' });
  if (new Set(value.media.map(m => m.id)).size !== value.media.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['media'], message: '同一张照片不能重复添加' });
});
export type RecordInput = z.infer<typeof recordInputSchema>;
export const reflectionSchema = z.object({ body: z.string().trim().min(1, '请写下回顾内容').max(20000) }).strict();
export type MediaItem = {
  id: string; filename: string; mime: string; size: number; width: number; height: number;
  originalUrl: string; displayUrl: string; thumbnailUrl: string; suggestedDate: string | null; createdAt: string;
};
export type RecordMedia = MediaItem & { caption: string };
export type Reflection = { id: string; body: string; createdAt: string };
export type RecordItem = Omit<RecordInput, 'media'> & {
  id: string; createdAt: string; updatedAt: string; deletedAt: string | null;
  media: RecordMedia[]; reflections: Reflection[];
};
export type RecordList = { items: RecordItem[]; total: number };
export type RecordQuery = { q?: string; year?: string; month?: string; person?: string; tag?: string; first?: string; deleted?: string; limit?: string; offset?: string };
export type Metadata = { people: string[]; tags: string[]; years: number[] };
export type AppStats = { records: number; photos: number; firsts: number; years: number[]; lastBackupAt: string | null; dataDir: string };
export type CalendarData = { month: string; days: { date: string; count: number }[]; undated: number };
export type BackupInfo = { id: string; filename: string; createdAt: string; size: number };
export type ApiError = { error: { code: string; message: string; details?: unknown } };

export const yearbookTemplateSchema = z.enum(['photo', 'text']);
export type YearbookTemplate = z.infer<typeof yearbookTemplateSchema>;
export const yearbookChapterKindSchema = z.enum(['cover', 'opening', 'month', 'firsts', 'photos', 'letter', 'custom']);
export type YearbookChapterKind = z.infer<typeof yearbookChapterKindSchema>;
export const yearbookBlockTypeSchema = z.enum(['paragraph', 'image', 'quote', 'record']);
export type YearbookBlockType = z.infer<typeof yearbookBlockTypeSchema>;

const optionalId = idSchema.optional();
export const yearbookBlockInputSchema = z.object({
  id: optionalId,
  type: yearbookBlockTypeSchema,
  body: z.string().max(100000).default(''),
  mediaId: idSchema.nullable().default(null),
  recordId: idSchema.nullable().default(null),
  caption: z.string().max(2000).default(''),
}).strict().superRefine((value, ctx) => {
  if (value.type === 'image' && !value.mediaId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['mediaId'], message: '图片块需要选择照片' });
  if (value.type === 'record' && !value.recordId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['recordId'], message: '记录块需要关联原始记录' });
});
export type YearbookBlockInput = z.infer<typeof yearbookBlockInputSchema>;

export const yearbookChapterInputSchema = z.object({
  id: optionalId,
  kind: yearbookChapterKindSchema.default('custom'),
  title: z.string().trim().max(300).default(''),
  body: z.string().max(100000).default(''),
  blocks: z.array(yearbookBlockInputSchema).max(1000).default([]),
  sourceRecordIds: z.array(idSchema).max(1000).default([]),
}).strict().superRefine((value, ctx) => {
  const blockIds = value.blocks.map(block => block.id).filter(Boolean);
  if (new Set(blockIds).size !== blockIds.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['blocks'], message: '章节中不能重复使用同一个内容块编号' });
  if (new Set(value.sourceRecordIds).size !== value.sourceRecordIds.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sourceRecordIds'], message: '来源记录不能重复' });
});
export type YearbookChapterInput = z.infer<typeof yearbookChapterInputSchema>;

export const yearbookInputSchema = z.object({
  year: z.coerce.number().int().min(1).max(9999),
  title: z.string().trim().max(300).default(''),
  template: yearbookTemplateSchema.default('photo'),
  coverMediaId: idSchema.nullable().default(null),
  introBody: z.string().max(100000).default(''),
  chapters: z.array(yearbookChapterInputSchema).max(100).default([]),
}).strict().superRefine((value, ctx) => {
  const ids = value.chapters.map(chapter => chapter.id).filter(Boolean);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['chapters'], message: '章节编号不能重复' });
});
export type YearbookInput = z.infer<typeof yearbookInputSchema>;

export type YearbookBlock = Omit<YearbookBlockInput, 'id'> & { id: string; position: number; createdAt: string; updatedAt: string };
export type YearbookChapter = Omit<YearbookChapterInput, 'id' | 'blocks'> & { id: string; position: number; blocks: YearbookBlock[]; createdAt: string; updatedAt: string };
export type YearbookItem = Omit<YearbookInput, 'chapters'> & { id: string; chapters: YearbookChapter[]; createdAt: string; updatedAt: string; deletedAt: string | null };
export type YearbookList = { items: YearbookItem[]; total: number };
export type YearbookVersion = { id: string; yearbookId: string; versionNo: number; source: 'manual' | 'ai'; label: string; snapshot: YearbookInput; createdAt: string };
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type TaskKind = 'yearbook-html' | 'yearbook-pdf' | 'ai' | string;
export type TaskItem = { id: string; kind: TaskKind; yearbookId: string | null; status: TaskStatus; progress: number; message: string; result: unknown; outputPath: string | null; errorMessage: string | null; maxDurationMs: number; toolCalls: number; cancelRequested: boolean; attempts: number; createdAt: string; startedAt: string | null; finishedAt: string | null; updatedAt: string };
