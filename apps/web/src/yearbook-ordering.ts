import { z } from 'zod';
import {
  yearbookBlockInputSchema,
  yearbookChapterInputSchema,
  yearbookInputSchema,
  type YearbookChapterInput,
  type YearbookInput,
} from '@yearbook/shared';

/** Local drafts also retain unfinished photo and record blocks. Saving still uses
 * the complete shared schema, including its source and duplicate checks. */
const cachedChapterSchema = yearbookChapterInputSchema.innerType().extend({
  blocks: z.array(yearbookBlockInputSchema.innerType()).max(1000).default([]),
});
const cachedDraftSchema = yearbookInputSchema.innerType().extend({
  chapters: z.array(cachedChapterSchema).max(100).default([]),
});

export function withYearbookDraftIds(input: YearbookInput, makeId: () => string = () => crypto.randomUUID()): YearbookInput {
  return {
    ...input,
    chapters: input.chapters.map(chapter => ({
      ...chapter,
      id: chapter.id || makeId(),
      blocks: chapter.blocks.map(block => ({ ...block, id: block.id || makeId() })),
    })),
  };
}

export function parseYearbookDraft(value: unknown): YearbookInput {
  return withYearbookDraftIds(cachedDraftSchema.parse(value));
}

/** Return the same array for boundary/invalid moves and preserve each item intact. */
export function moveYearbookItem<T>(items: T[], from: number, to: number): T[] {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return items;
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export type SelectedYearbookPhoto = { mediaId: string; caption: string; sourceRecordIds: string[] };

/** Selection order becomes reading order. Already included photos are untouched,
 * so picking more photos never replaces an edited caption, ID, or source. */
export function appendYearbookPhotos(chapter: YearbookChapterInput, photos: SelectedYearbookPhoto[], makeId: () => string = () => crypto.randomUUID()): YearbookChapterInput {
  const included = new Set(chapter.blocks.filter(block => block.type === 'image').map(block => block.mediaId));
  const additions = photos.filter(photo => {
    if (included.has(photo.mediaId)) return false;
    included.add(photo.mediaId);
    return true;
  });
  if (!additions.length) return chapter;
  if (chapter.blocks.length + additions.length > 1000) throw new Error('每章最多保留 1000 个内容块，请减少选片数量或新建章节。');
  const sources = Array.from(new Set([...chapter.sourceRecordIds, ...additions.flatMap(photo => photo.sourceRecordIds)]));
  if (sources.length > 1000) throw new Error('每章最多关联 1000 条来源记录，请另建章节添加照片。');
  return {
    ...chapter,
    sourceRecordIds: sources,
    blocks: [...chapter.blocks, ...additions.map(photo => ({
      id: makeId(),
      type: 'image' as const,
      body: '',
      mediaId: photo.mediaId,
      recordId: null,
      caption: photo.caption,
    }))],
  };
}
