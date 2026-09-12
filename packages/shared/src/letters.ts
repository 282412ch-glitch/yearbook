import { z } from 'zod';
import { isLocalDate, type RecordMedia } from './index.js';

const letterDate = z.string().refine(value => isLocalDate(value), '请填写有效的查看日期');
const letterPhoto = z.object({ id: z.string().uuid('无效的照片编号'), caption: z.string().max(1000).default('') }).strict();

/** Drafts may be unfinished. Sealing has additional content/date checks on the server. */
export const letterInputSchema = z.object({
  title: z.string().trim().max(200).default(''),
  body: z.string().max(100000).default(''),
  unlockOn: letterDate.nullable().default(null),
  media: z.array(letterPhoto).max(100).default([]),
}).strict().superRefine((value, context) => {
  if (new Set(value.media.map(photo => photo.id)).size !== value.media.length) {
    context.addIssue({ code: 'custom', path: ['media'], message: '同一张照片不能重复添加' });
  }
});
export type LetterInput = z.infer<typeof letterInputSchema>;
export const letterStatusSchema = z.enum(['draft', 'sealed', 'due', 'read']);
export type LetterStatus = z.infer<typeof letterStatusSchema>;
export const letterQuerySchema = z.object({
  status: z.enum(['all', 'draft', 'sealed', 'due', 'read']).default('all'),
  deleted: z.enum(['true', 'false']).default('false'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
}).strict();
export type LetterQuery = { status?: 'all' | LetterStatus; deleted?: 'true' | 'false'; limit?: string; offset?: string };
export type LetterEnvelope = {
  id: string; title: string; unlockOn: string | null;
  createdAt: string; updatedAt: string; sealedAt: string | null; readAt: string | null; deletedAt: string | null;
  status: LetterStatus; photoCount: number; canRead: boolean;
};
/** Sealed, not-yet-due letters omit body and media entirely, including photo IDs and URLs. */
export type LetterDetail = LetterEnvelope & { body?: string; media?: RecordMedia[] };
export type LetterList = { items: LetterEnvelope[]; total: number; today: string };
export type LetterSummary = { today: string; dueUnread: number; totalDrafts: number; sealedCount: number; due: LetterEnvelope[] };
