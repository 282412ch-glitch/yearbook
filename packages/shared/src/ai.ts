import { z } from 'zod';
import type { RecordInput, TaskItem, YearbookChapterKind } from './index.js';

const uuid = z.string().uuid('无效的编号');
const uniqueIds = z.array(uuid).max(2000).refine(ids => new Set(ids).size === ids.length, '编号不能重复');
export const aiTaskKindSchema = z.enum(['title', 'polish', 'questions', 'monthly', 'chapter', 'yearbook', 'agent']);
export type AiTaskKind = z.infer<typeof aiTaskKindSchema>;
export const aiTaskInputSchema = z.object({
  kind: aiTaskKindSchema,
  profileId: uuid.optional(),
  recordIds: uniqueIds.default([]),
  year: z.number().int().min(1).max(9999).optional(),
  month: z.number().int().min(1).max(12).optional(),
  instruction: z.string().trim().max(5000).default(''),
  yearbookId: uuid.optional(),
  selectedMediaIds: uniqueIds.default([]),
  useImages: z.boolean().default(false),
  maxDurationMs: z.number().int().min(1000).max(1800000).default(600000),
  maxToolCalls: z.number().int().min(1).max(40).default(16),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
}).strict().superRefine((input, ctx) => {
  if (!input.recordIds.length && !input.year) ctx.addIssue({ code: 'custom', path: ['recordIds'], message: '请选定记录或年份，明确本次可使用的素材范围' });
  if (['title', 'polish', 'questions'].includes(input.kind) && input.recordIds.length !== 1) ctx.addIssue({ code: 'custom', path: ['recordIds'], message: '此功能需要选定一条已保存的记录' });
  if (['monthly', 'yearbook'].includes(input.kind) && !input.year) ctx.addIssue({ code: 'custom', path: ['year'], message: '请选择年份' });
  if (input.kind === 'monthly' && !input.month) ctx.addIssue({ code: 'custom', path: ['month'], message: '请选择月份' });
  if (input.month && !input.year) ctx.addIssue({ code: 'custom', path: ['year'], message: '按月选择素材时需要年份' });
  if (input.kind === 'agent' && !input.instruction) ctx.addIssue({ code: 'custom', path: ['instruction'], message: '请写下希望助理完成的整理任务' });
});
export type AiTaskInput = z.infer<typeof aiTaskInputSchema>;

export const aiParagraphSchema = z.object({
  text: z.string().trim().min(1).max(30000),
  sourceRecordIds: uniqueIds.refine(ids => ids.length > 0, '每段内容必须关联原始记录'),
}).strict();
export type AiParagraph = z.infer<typeof aiParagraphSchema>;
export const aiPhotoSchema = z.object({
  mediaId: uuid,
  caption: z.string().max(2000).default(''),
  sourceRecordIds: uniqueIds.refine(ids => ids.length > 0, '照片必须关联原始记录'),
}).strict();
export type AiPhoto = z.infer<typeof aiPhotoSchema>;
export const aiChapterSchema = z.object({
  title: z.string().trim().min(1).max(300),
  kind: z.enum(['cover', 'opening', 'month', 'firsts', 'photos', 'letter', 'custom']).default('custom'),
  paragraphs: z.array(aiParagraphSchema).max(200).default([]),
  photos: z.array(aiPhotoSchema).max(100).default([]),
}).strict();
export type AiDraftChapter = z.infer<typeof aiChapterSchema> & { kind: YearbookChapterKind };
export const aiDraftContentSchema = z.object({
  title: z.string().trim().min(1).max(300),
  paragraphs: z.array(aiParagraphSchema).max(200).default([]),
  highlights: z.array(aiParagraphSchema).max(20).default([]),
  questions: z.array(z.string().trim().min(1).max(1000)).max(2).default([]),
  photos: z.array(aiPhotoSchema).max(100).default([]),
  chapters: z.array(aiChapterSchema).max(100).default([]),
}).strict();
export type AiDraftContent = z.infer<typeof aiDraftContentSchema>;
export const aiDraftUpdateSchema = z.object({ content: aiDraftContentSchema }).strict();
export const aiAdoptSchema = z.object({ yearbookId: uuid.nullable().optional() }).strict();

export type AiMode = 'tools' | 'fixed';
export type AiUsage = { inputTokens?: number; outputTokens?: number; totalTokens?: number };
export type AiSourceSnapshot = {
  id: string; title: string; body: string; occurredOn: string | null; people: string[]; location: string;
  tags: string[]; isFirst: boolean; updatedAt: string; reflections: { body: string; createdAt: string }[];
  media: { id: string; caption: string }[];
};
export type AiDraftItem = {
  id: string; taskId: string; kind: AiTaskKind; mode: AiMode; year: number | null; month: number | null;
  content: AiDraftContent; sourceRecordIds: string[]; scopeRecordIds: string[]; sourceSnapshots: AiSourceSnapshot[];
  versionNo: number; status: 'draft' | 'adopted'; adoptedYearbookId: string | null;
  warnings: string[]; createdAt: string; updatedAt: string;
};
export type AiDraftList = { items: AiDraftItem[]; total: number };
export type AiDraftVersion = { id: string; draftId: string; revision: number; source: 'generated' | 'manual'; content: AiDraftContent; createdAt: string };
export type AiTaskStage = { key: string; label: string; status: 'completed'; content: AiDraftContent; createdAt: string };
export type AiTaskDetail = { task: TaskItem; request: AiTaskInput; mode: AiMode; stages: AiTaskStage[]; usage: AiUsage | null; warnings: string[] };
export type AiTaskResult = { draftId?: string; mode: AiMode; usage: AiUsage | null; completedStages: number; warnings: string[] };
export type AiAdoptResult = { draft: AiDraftItem; yearbookId?: string; recordId?: string; recordProposal?: RecordInput; message: string };
