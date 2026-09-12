import { randomUUID } from 'node:crypto';
import type { YearbookBlock, YearbookChapter, YearbookInput, YearbookItem, YearbookList, YearbookVersion } from '@yearbook/shared';
import { idSchema, yearbookInputSchema } from '@yearbook/shared';
import type { DataStore } from './db.js';
import { AppError } from './errors.js';
import { getRecord } from './records.js';

type BookRow = { id: string; year: number; title: string; template: 'photo' | 'text'; cover_media_id: string | null; intro_body: string; created_at: string; updated_at: string; deleted_at: string | null };
type ChapterRow = { id: string; yearbook_id: string; kind: YearbookChapter['kind']; title: string; body: string; position: number; created_at: string; updated_at: string };
type BlockRow = { id: string; chapter_id: string; type: YearbookBlock['type']; body: string; media_id: string | null; record_id: string | null; caption: string; position: number; created_at: string; updated_at: string };

function validateSources(store: DataStore, input: YearbookInput) {
  if (input.coverMediaId && !store.db.prepare('SELECT id FROM media WHERE id = ?').get(input.coverMediaId)) throw new AppError(400, 'MEDIA_NOT_FOUND', '封面照片不存在');
  for (const chapter of input.chapters) {
    for (const source of chapter.sourceRecordIds) {
      const record = store.db.prepare('SELECT id, deleted_at FROM records WHERE id = ?').get(source) as { id: string; deleted_at: string | null } | undefined;
      if (!record || record.deleted_at) throw new AppError(400, 'RECORD_NOT_AVAILABLE', '来源记录不存在或已删除');
    }
    for (const block of chapter.blocks) {
      if (block.mediaId && !store.db.prepare('SELECT id FROM media WHERE id = ?').get(block.mediaId)) throw new AppError(400, 'MEDIA_NOT_FOUND', '章节中的照片不存在');
      if (block.recordId) {
        const record = store.db.prepare('SELECT id, deleted_at FROM records WHERE id = ?').get(block.recordId) as { id: string; deleted_at: string | null } | undefined;
        if (!record || record.deleted_at) throw new AppError(400, 'RECORD_NOT_AVAILABLE', '章节关联的记录不存在或已删除');
      }
    }
  }
}

function presentBlock(row: BlockRow): YearbookBlock {
  return { id: row.id, type: row.type, body: row.body, mediaId: row.media_id, recordId: row.record_id, caption: row.caption, position: row.position, createdAt: row.created_at, updatedAt: row.updated_at };
}

function presentChapter(store: DataStore, row: ChapterRow): YearbookChapter {
  const blocks = (store.db.prepare('SELECT * FROM yearbook_blocks WHERE chapter_id = ? ORDER BY position, id').all(row.id) as BlockRow[]).map(presentBlock);
  const sourceRecordIds = (store.db.prepare('SELECT record_id FROM yearbook_sources WHERE chapter_id = ? ORDER BY record_id').all(row.id) as { record_id: string }[]).map(item => item.record_id);
  return { id: row.id, kind: row.kind, title: row.title, body: row.body, position: row.position, blocks, sourceRecordIds, createdAt: row.created_at, updatedAt: row.updated_at };
}

export function getYearbook(store: DataStore, rawId: string): YearbookItem {
  const id = idSchema.parse(rawId);
  const row = store.db.prepare('SELECT * FROM yearbooks WHERE id = ?').get(id) as BookRow | undefined;
  if (!row || row.deleted_at) throw new AppError(404, 'NOT_FOUND', '这本年册不存在');
  const chapters = (store.db.prepare('SELECT * FROM yearbook_chapters WHERE yearbook_id = ? ORDER BY position, id').all(id) as ChapterRow[]).map(chapter => presentChapter(store, chapter));
  return { id: row.id, year: row.year, title: row.title, template: row.template, coverMediaId: row.cover_media_id, introBody: row.intro_body, chapters, createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at };
}

export function listYearbooks(store: DataStore, raw: { year?: string; deleted?: string; limit?: string; offset?: string } = {}): YearbookList {
  const year = raw.year == null || raw.year === '' ? undefined : Number(raw.year);
  if (year !== undefined && (!Number.isInteger(year) || year < 1 || year > 9999)) throw new AppError(400, 'VALIDATION_ERROR', '年份无效');
  const deleted = raw.deleted === 'true';
  const limit = raw.limit == null ? 100 : Number(raw.limit); const offset = raw.offset == null ? 0 : Number(raw.offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500 || !Number.isInteger(offset) || offset < 0) throw new AppError(400, 'VALIDATION_ERROR', '分页参数无效');
  const clauses = ['deleted_at IS ' + (deleted ? 'NOT NULL' : 'NULL')]; const values: (string | number)[] = [];
  if (year !== undefined) { clauses.push('year = ?'); values.push(year); }
  const where = clauses.join(' AND ');
  const total = (store.db.prepare(`SELECT COUNT(*) AS count FROM yearbooks WHERE ${where}`).get(...values) as { count: number }).count;
  const rows = store.db.prepare(`SELECT * FROM yearbooks WHERE ${where} ORDER BY year DESC, updated_at DESC, id LIMIT ? OFFSET ?`).all(...values, limit, offset) as BookRow[];
  return { total, items: rows.map(row => getYearbookAllowDeleted(store, row.id)) };
}

function snapshotInput(book: YearbookItem): YearbookInput {
  return {
    year: book.year, title: book.title, template: book.template, coverMediaId: book.coverMediaId, introBody: book.introBody,
    chapters: book.chapters.map(chapter => ({ id: chapter.id, kind: chapter.kind, title: chapter.title, body: chapter.body, blocks: chapter.blocks.map(block => ({ id: block.id, type: block.type, body: block.body, mediaId: block.mediaId, recordId: block.recordId, caption: block.caption })), sourceRecordIds: chapter.sourceRecordIds })),
  };
}

export function saveYearbook(store: DataStore, rawInput: unknown, existingId?: string, source: 'manual' | 'ai' = 'manual'): YearbookItem {
  let input = yearbookInputSchema.parse(rawInput);
  if (!existingId && input.chapters.length === 0) input = defaultYearbookInput(store, input);
  validateSources(store, input);
  const id = existingId ? idSchema.parse(existingId) : randomUUID();
  const existing = existingId ? store.db.prepare('SELECT id, deleted_at FROM yearbooks WHERE id = ?').get(id) as { id: string; deleted_at: string | null } | undefined : undefined;
  if (existingId && (!existing || existing.deleted_at)) throw new AppError(404, 'NOT_FOUND', '这本年册不存在');
  const reusableChapters = new Set(existingId ? (store.db.prepare('SELECT id FROM yearbook_chapters WHERE yearbook_id = ?').all(id) as { id: string }[]).map(row => row.id) : []);
  const reusableBlocks = new Set(existingId ? (store.db.prepare('SELECT b.id FROM yearbook_blocks b JOIN yearbook_chapters c ON c.id = b.chapter_id WHERE c.yearbook_id = ?').all(id) as { id: string }[]).map(row => row.id) : []);
  const usedChapterIds = new Set<string>(); const usedBlockIds = new Set<string>();
  const now = new Date().toISOString();
  store.db.transaction(() => {
    if (existingId) store.db.prepare('UPDATE yearbooks SET year = ?, title = ?, template = ?, cover_media_id = ?, intro_body = ?, updated_at = ? WHERE id = ?').run(input.year, input.title, input.template, input.coverMediaId, input.introBody, now, id);
    else store.db.prepare('INSERT INTO yearbooks (id, year, title, template, cover_media_id, intro_body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, input.year, input.title, input.template, input.coverMediaId, input.introBody, now, now);
    store.db.prepare('DELETE FROM yearbook_chapters WHERE yearbook_id = ?').run(id);
    input.chapters.forEach((chapter, position) => {
      const chapterId = chapter.id && reusableChapters.has(chapter.id) && !usedChapterIds.has(chapter.id) ? chapter.id : randomUUID();
      usedChapterIds.add(chapterId);
      store.db.prepare('INSERT INTO yearbook_chapters (id, yearbook_id, kind, title, body, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(chapterId, id, chapter.kind, chapter.title, chapter.body, position, now, now);
      chapter.blocks.forEach((block, blockPosition) => {
        const blockId = block.id && reusableBlocks.has(block.id) && !usedBlockIds.has(block.id) ? block.id : randomUUID();
        usedBlockIds.add(blockId);
        store.db.prepare('INSERT INTO yearbook_blocks (id, chapter_id, type, body, media_id, record_id, caption, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(blockId, chapterId, block.type, block.body, block.mediaId, block.recordId, block.caption, blockPosition, now, now);
      });
      for (const recordId of chapter.sourceRecordIds) store.db.prepare('INSERT INTO yearbook_sources (chapter_id, record_id) VALUES (?, ?)').run(chapterId, recordId);
    });
    const versionNo = ((store.db.prepare('SELECT MAX(version_no) AS max FROM yearbook_versions WHERE yearbook_id = ?').get(id) as { max: number | null }).max ?? 0) + 1;
    const snapshot = { ...input, chapters: input.chapters.map(chapter => ({ ...chapter, id: chapter.id ?? undefined, blocks: chapter.blocks.map(block => ({ ...block, id: block.id ?? undefined })) })) };
    store.db.prepare('INSERT INTO yearbook_versions (id, yearbook_id, version_no, source, label, snapshot_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), id, versionNo, source, source === 'ai' ? 'AI 草稿' : '手动保存', JSON.stringify(snapshot), now);
  })();
  return getYearbook(store, id);
}

function defaultYearbookInput(store: DataStore, input: YearbookInput): YearbookInput {
  const rows = store.db.prepare(`SELECT id, occurred_on, is_first FROM records
    WHERE deleted_at IS NULL AND include_in_yearbook = 1 AND occurred_on IS NOT NULL AND substr(occurred_on, 1, 4) = ?
    ORDER BY occurred_on, created_at, id`).all(String(input.year)) as { id: string; occurred_on: string; is_first: number }[];
  const chapters: YearbookInput['chapters'] = [
    { kind: 'cover', title: `${input.year} · 一年一册`, body: '', blocks: [], sourceRecordIds: [] },
    { kind: 'opening', title: '这一年的开篇', body: '', blocks: [], sourceRecordIds: [] },
  ];
  for (let month = 1; month <= 12; month++) {
    const monthRows = rows.filter(row => Number(row.occurred_on.slice(5, 7)) === month);
    if (!monthRows.length) continue;
    chapters.push({ kind: 'month', title: `${month} 月`, body: '', blocks: monthRows.map(row => ({ type: 'record', body: '', mediaId: null, recordId: row.id, caption: '' })), sourceRecordIds: monthRows.map(row => row.id) });
  }
  const firstRows = rows.filter(row => row.is_first);
  chapters.push({ kind: 'firsts', title: '生活第一次', body: '', blocks: firstRows.map(row => ({ type: 'record', body: '', mediaId: null, recordId: row.id, caption: '' })), sourceRecordIds: firstRows.map(row => row.id) });
  chapters.push({ kind: 'photos', title: '年度照片选集', body: '', blocks: [], sourceRecordIds: [] });
  chapters.push({ kind: 'letter', title: '写给明年的自己', body: '', blocks: [], sourceRecordIds: [] });
  return { ...input, chapters };
}

export function deleteYearbook(store: DataStore, rawId: string, restore = false) {
  const id = idSchema.parse(rawId);
  const row = store.db.prepare('SELECT id, deleted_at FROM yearbooks WHERE id = ?').get(id) as { id: string; deleted_at: string | null } | undefined;
  if (!row) throw new AppError(404, 'NOT_FOUND', '这本年册不存在');
  const now = new Date().toISOString();
  store.db.prepare('UPDATE yearbooks SET deleted_at = ?, updated_at = ? WHERE id = ?').run(restore ? null : now, now, id);
  return restore ? getYearbook(store, id) : { ...getYearbookAllowDeleted(store, id) };
}

function getYearbookAllowDeleted(store: DataStore, id: string): YearbookItem {
  const row = store.db.prepare('SELECT * FROM yearbooks WHERE id = ?').get(id) as BookRow | undefined;
  if (!row) throw new AppError(404, 'NOT_FOUND', '这本年册不存在');
  const chapters = (store.db.prepare('SELECT * FROM yearbook_chapters WHERE yearbook_id = ? ORDER BY position, id').all(id) as ChapterRow[]).map(chapter => presentChapter(store, chapter));
  return { id: row.id, year: row.year, title: row.title, template: row.template, coverMediaId: row.cover_media_id, introBody: row.intro_body, chapters, createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at };
}

export function listYearbookVersions(store: DataStore, rawId: string): YearbookVersion[] {
  const id = idSchema.parse(rawId); getYearbook(store, id);
  return (store.db.prepare('SELECT * FROM yearbook_versions WHERE yearbook_id = ? ORDER BY version_no DESC').all(id) as { id: string; yearbook_id: string; version_no: number; source: 'manual' | 'ai'; label: string; snapshot_json: string; created_at: string }[]).map(row => ({ id: row.id, yearbookId: row.yearbook_id, versionNo: row.version_no, source: row.source, label: row.label, snapshot: JSON.parse(row.snapshot_json) as YearbookInput, createdAt: row.created_at }));
}

/** Store an AI/manual proposal without replacing the currently edited book. */
export function createYearbookVersion(store: DataStore, rawBookId: string, rawSnapshot: unknown, source: 'manual' | 'ai' = 'ai', label?: string) {
  const yearbookId = idSchema.parse(rawBookId);
  getYearbook(store, yearbookId);
  const snapshot = yearbookInputSchema.parse(rawSnapshot);
  validateSources(store, snapshot);
  const now = new Date().toISOString();
  const versionNo = ((store.db.prepare('SELECT MAX(version_no) AS max FROM yearbook_versions WHERE yearbook_id = ?').get(yearbookId) as { max: number | null }).max ?? 0) + 1;
  const versionId = randomUUID();
  store.db.prepare('INSERT INTO yearbook_versions (id, yearbook_id, version_no, source, label, snapshot_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(versionId, yearbookId, versionNo, source, label ?? (source === 'ai' ? 'AI 草稿' : '手动快照'), JSON.stringify(snapshot), now);
  return getYearbookVersion(store, yearbookId, versionId);
}

export function getYearbookVersion(store: DataStore, rawBookId: string, rawVersionId: string): YearbookVersion {
  const bookId = idSchema.parse(rawBookId); const versionId = idSchema.parse(rawVersionId); getYearbook(store, bookId);
  const row = store.db.prepare('SELECT * FROM yearbook_versions WHERE id = ? AND yearbook_id = ?').get(versionId, bookId) as { id: string; yearbook_id: string; version_no: number; source: 'manual' | 'ai'; label: string; snapshot_json: string; created_at: string } | undefined;
  if (!row) throw new AppError(404, 'NOT_FOUND', '这个年册版本不存在');
  return { id: row.id, yearbookId: row.yearbook_id, versionNo: row.version_no, source: row.source, label: row.label, snapshot: yearbookInputSchema.parse(JSON.parse(row.snapshot_json)), createdAt: row.created_at };
}

export function applyYearbookVersion(store: DataStore, rawBookId: string, rawVersionId: string) {
  const version = getYearbookVersion(store, rawBookId, rawVersionId);
  return saveYearbook(store, version.snapshot, version.yearbookId, 'manual');
}

/** Build a self-contained HTML document. Images are embedded as data URLs for offline reading. */
export async function renderYearbookHtml(store: DataStore, rawId: string): Promise<string> {
  const book = getYearbook(store, rawId);
  const mediaCache = new Map<string, string>();
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { mediaFiles } = await import('./media.js');
  const image = async (mediaId: string | null) => {
    if (!mediaId) return '';
    if (mediaCache.has(mediaId)) return mediaCache.get(mediaId)!;
    const row = store.db.prepare('SELECT * FROM media WHERE id = ?').get(mediaId) as import('./records.js').MediaRow | undefined;
    if (!row) return '';
    try { const data = await readFile(join(store.dataDir, mediaFiles(row).display)); const url = `data:image/jpeg;base64,${data.toString('base64')}`; mediaCache.set(mediaId, url); return url; } catch { return ''; }
  };
  const esc = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
  const blocks = async (chapter: YearbookChapter) => (await Promise.all(chapter.blocks.map(async block => {
    if (block.type === 'image') { const src = await image(block.mediaId); return src ? `<figure><img src="${src}" alt="${esc(block.caption || '年册照片')}"><figcaption>${esc(block.caption)}</figcaption></figure>` : ''; }
    if (block.type === 'quote') return `<blockquote>${esc(block.body).replaceAll('\n', '<br>')}</blockquote>`;
    if (block.type === 'record') { const record = block.recordId ? getRecord(store, block.recordId) : null; return record ? `<article class="record"><h3>${esc(record.title || '未命名记录')}</h3><p>${esc(record.body).replaceAll('\n', '<br>')}</p><small>${esc(record.occurredOn ?? '日期待补')}</small></article>` : ''; }
    return block.body ? `<p>${esc(block.body).replaceAll('\n', '<br>')}</p>` : '';
  }))).join('');
  const chapterHtml = (await Promise.all(book.chapters.map(async chapter => `<section class="chapter"><h2>${esc(chapter.title || '未命名章节')}</h2>${chapter.body ? `<div class="chapter-body">${esc(chapter.body).replaceAll('\n', '<br>')}</div>` : ''}${await blocks(chapter)}</section>`))).join('');
  const cover = await image(book.coverMediaId);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(book.title || `${book.year} 年册`)}</title><style>@font-face{font-family:YearbookSans;src:local("Noto Sans SC")}*{box-sizing:border-box}body{margin:0;background:#f6f2e9;color:#2f302d;font-family:YearbookSans,"Microsoft YaHei",sans-serif;line-height:1.8}.page{max-width:900px;margin:0 auto;padding:42px 56px;background:#fffdf8;min-height:100vh}.cover{text-align:center;display:flex;flex-direction:column;justify-content:center;min-height:80vh;border-bottom:1px solid #d8d0c0}.cover img{max-width:100%;max-height:440px;object-fit:contain;margin:0 auto 28px}.cover h1{font-size:42px;font-weight:500;margin:0}.cover p{color:#777;margin:8px}.chapter{break-inside:avoid;page-break-inside:avoid;padding:34px 0;border-bottom:1px solid #e5dfd3}.chapter h2{font-size:28px;font-weight:500;margin:0 0 12px}.chapter-body{margin-bottom:18px;white-space:normal}.record{border-left:3px solid #b78f72;padding-left:18px;margin:22px 0}.record h3{margin:0;font-size:19px}.record p{margin:6px 0}.record small{color:#777}figure{margin:22px 0;text-align:center;break-inside:avoid}figure img{max-width:100%;max-height:650px;object-fit:contain}figcaption{color:#777;font-size:14px}blockquote{margin:22px 0;padding:14px 20px;background:#f4eee4;border-left:4px solid #b78f72;font-style:italic}@media print{body{background:#fff}.page{padding:0;max-width:none}.chapter{break-inside:avoid}}@media(max-width:600px){.page{padding:24px}.cover h1{font-size:32px}}</style></head><body><main class="page"><section class="cover">${cover ? `<img src="${cover}" alt="封面照片">` : ''}<h1>${esc(book.title || `${book.year} 年册`)}</h1><p>${book.year}</p>${book.introBody ? `<p>${esc(book.introBody).replaceAll('\n', '<br>')}</p>` : ''}</section>${chapterHtml}</main></body></html>`;
}

export function getYearbookForExport(store: DataStore, rawId: string) {
  return getYearbook(store, rawId);
}
