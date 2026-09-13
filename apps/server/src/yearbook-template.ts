import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RecordItem, YearbookBlock, YearbookChapter, YearbookItem } from '@yearbook/shared';
import type { DataStore } from './db.js';
import { AppError } from './errors.js';
import { embeddedExportFonts } from './export-fonts.js';
import { mediaFiles } from './media.js';
import { getRecord, type MediaRow } from './records.js';
import { yearbookCss } from './yearbook-print-style.js';

export type YearbookRenderSnapshot = {
  book: YearbookItem;
  records: Map<string, RecordItem>;
  media: Map<string, MediaRow>;
  dataDir: string;
};

/** Take the saved book and its source records together, before any file or browser waits. */
export function captureYearbookRenderSnapshot(store: DataStore, book: YearbookItem): YearbookRenderSnapshot {
  const recordIds = new Set<string>();
  const mediaIds = new Set<string>();
  if (book.coverMediaId) mediaIds.add(book.coverMediaId);
  for (const chapter of book.chapters) {
    chapter.sourceRecordIds.forEach(id => recordIds.add(id));
    for (const block of chapter.blocks) {
      if (block.recordId) recordIds.add(block.recordId);
      if (block.mediaId) mediaIds.add(block.mediaId);
    }
  }
  const records = new Map<string, RecordItem>();
  for (const id of recordIds) {
    const record = getRecord(store, id);
    records.set(id, record);
    record.media.forEach(item => mediaIds.add(item.id));
  }
  const media = new Map<string, MediaRow>();
  for (const id of mediaIds) {
    const row = store.db.prepare('SELECT * FROM media WHERE id = ?').get(id) as MediaRow | undefined;
    if (!row) throw new AppError(409, 'EXPORT_MEDIA_MISSING', '年册中的照片资料缺失，请恢复备份或重新选择照片后导出');
    media.set(id, row);
  }
  return { book, records, media, dataDir: store.dataDir };
}

const escapeHtml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const hasText = (value: string) => Boolean(value.trim());
const paragraphs = (value: string) => value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split(/\n{2,}/).filter(hasText).map(part => `<p>${escapeHtml(part)}</p>`).join('');
const recordTitle = (record: RecordItem) => record.title || (record.body.trim() ? '记下的这一天' : '照片里的这一天');
const recordLabel = (record: RecordItem) => `${record.occurredOn ?? '日期待补'} · ${recordTitle(record)}`;
const chapterLabels: Record<YearbookChapter['kind'], string> = { cover: '封面附记', opening: '年度开篇', month: '按月回顾', firsts: '生活第一次', photos: '年度照片选集', letter: '写给明年的自己', custom: '我的章节' };

/** Both preview and exports use this document; it contains no network URLs or runtime scripts. */
export async function renderYearbookSnapshot(snapshot: YearbookRenderSnapshot, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const { book, records, media, dataDir } = snapshot;
  const imageData = new Map<string, string>();
  await Promise.all([...media.values()].map(async row => {
    try {
      const bytes = await readFile(join(dataDir, mediaFiles(row).display), { signal });
      if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new Error('invalid jpeg');
      imageData.set(row.id, `data:image/jpeg;base64,${bytes.toString('base64')}`);
    } catch {
      signal?.throwIfAborted();
      throw new AppError(409, 'EXPORT_MEDIA_MISSING', `照片“${row.filename.slice(0, 120)}”的本地文件缺失或损坏，请从备份恢复后重试`);
    }
  }));
  function picture(mediaId: string, caption: string, cover = false) {
    const item = media.get(mediaId)!;
    const src = imageData.get(mediaId)!;
    const orientation = item.height > item.width ? 'portrait' : 'landscape';
    const longCaption = caption.length > 320 ? ' long-caption' : '';
    return `<figure class="${cover ? 'cover-photo' : 'photo'} ${orientation}${longCaption}" data-media-id="${mediaId}"><img src="${src}" width="${item.width}" height="${item.height}" alt="${escapeHtml(caption || (cover ? '封面照片' : '年册照片'))}" decoding="sync">${caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ''}</figure>`;
  }
  const linkedRecords = new Set<string>();
  function renderRecord(record: RecordItem, sourceOnly = false) {
    const anchor = linkedRecords.has(record.id) ? '' : ` id="source-${record.id}"`;
    linkedRecords.add(record.id);
    const prose = record.body ? `<div class="prose record-body">${paragraphs(record.body)}</div>` : '';
    const photos = record.media.map(item => picture(item.id, item.caption)).join('');
    const content = book.template === 'photo' && !sourceOnly ? photos + prose : prose + photos;
    const heading = `<header class="record-heading"><p class="record-date">${escapeHtml(record.occurredOn ?? '日期待补')}</p><h3>${escapeHtml(recordTitle(record))}</h3></header>`;
    return `<article class="record${sourceOnly ? ' source-record' : ''}"${anchor} data-record-id="${record.id}">${heading}${sourceOnly ? `<details class="source-details"><summary>展开原始素材</summary>${content}</details>` : content}</article>`;
  }
  function sourceLink(recordId: string) {
    const record = records.get(recordId)!;
    return `<a href="#source-${recordId}">${escapeHtml(recordLabel(record))}</a>`;
  }
  function renderBlock(block: YearbookBlock) {
    if (block.type === 'image') return block.mediaId ? picture(block.mediaId, block.caption) : '';
    if (block.type === 'record') return block.recordId ? renderRecord(records.get(block.recordId)!) : '';
    if (!hasText(block.body)) return '';
    const source = block.recordId ? `<p class="block-source">素材：${sourceLink(block.recordId)}</p>` : '';
    return block.type === 'quote'
      ? `<blockquote class="prose">${paragraphs(block.body)}</blockquote>${source}`
      : `<div class="prose paragraph-block">${paragraphs(block.body)}</div>${source}`;
  }
  const firstOpening = book.chapters.find(chapter => chapter.kind === 'opening')?.id;
  const renderedChapters: { id: string; title: string; html: string }[] = [];
  const chapterHeading = (title: string, label: string, number: string) => `<header class="chapter-heading"><p class="chapter-kicker"><span>${escapeHtml(label)}</span><span class="chapter-number">${number}</span></p><h2>${escapeHtml(title)}</h2></header>`;
  if (hasText(book.introBody) && !firstOpening) {
    renderedChapters.push({ id: 'annual-opening', title: '年度开篇', html: `<section class="chapter opening" id="annual-opening">${chapterHeading('年度开篇', '写在前面', '01')}<div class="prose chapter-body">${paragraphs(book.introBody)}</div></section>` });
  }
  for (const chapter of book.chapters) {
    const intro = chapter.id === firstOpening ? book.introBody : '';
    const content = (hasText(intro) ? `<div class="prose chapter-body">${paragraphs(intro)}</div>` : '')
      + (hasText(chapter.body) ? `<div class="prose chapter-body">${paragraphs(chapter.body)}</div>` : '')
      + chapter.blocks.map(renderBlock).join('');
    // A newly created book has empty structural chapters. Do not print empty months or a second blank cover.
    if (!content && !(chapter.kind === 'custom' && hasText(chapter.title))) continue;
    const title = chapter.title || chapterLabels[chapter.kind];
    const id = `chapter-${chapter.id}`;
    const sources = chapter.sourceRecordIds.length ? `<footer class="sources"><p>素材来源</p><ul>${chapter.sourceRecordIds.map(recordId => `<li>${sourceLink(recordId)}</li>`).join('')}</ul></footer>` : '';
    const keepPhotoLead = chapter.blocks[0]?.type === 'image' && intro.length + chapter.body.length <= 240 ? ' keep-photo-lead' : '';
    renderedChapters.push({ id, title, html: `<section class="chapter kind-${chapter.kind}${keepPhotoLead}" id="${id}" data-kind="${chapter.kind}">${chapterHeading(title, chapterLabels[chapter.kind], String(renderedChapters.length + 1).padStart(2, '0'))}${content}${sources}</section>` });
  }
  const unshownSources = [...records.values()].filter(record => !linkedRecords.has(record.id));
  const sourceAppendix = unshownSources.length ? `<section class="chapter source-appendix" id="source-appendix">${chapterHeading('原始素材索引', '回到那些日子', '附')}${unshownSources.map(record => renderRecord(record, true)).join('')}</section>` : '';
  const title = book.title || `${book.year} 年册`;
  const contents = renderedChapters.length > 1 ? `<nav class="contents" id="contents" aria-label="年册目录"><div class="contents-heading"><div><p class="book-eyebrow">翻阅章节</p><h2>这一册的日子</h2></div><span>${renderedChapters.length} 个章节</span></div><ol>${renderedChapters.map((chapter, index) => `<li><a href="#${chapter.id}"><span class="contents-number">${String(index + 1).padStart(2, '0')}</span><span>${escapeHtml(chapter.title)}</span></a></li>`).join('')}${sourceAppendix ? '<li><a href="#source-appendix"><span class="contents-number">附</span><span>原始素材索引</span></a></li>' : ''}</ol><p class="contents-note">从任意一页，重回这一年。</p></nav>` : '';
  const cover = `<section class="cover${book.coverMediaId ? ' has-photo' : ' no-photo'}${title.length > 80 ? ' long-title' : ''}" id="cover" aria-label="封面"><div class="cover-topline"><span>一年一册</span><span>生活的年度存档</span></div><div class="cover-heading"><p class="cover-year">${book.year}</p><h1>${escapeHtml(title)}</h1></div>${book.coverMediaId ? picture(book.coverMediaId, '', true) : '<div class="cover-window" aria-hidden="true"><i></i><i></i><i></i><i></i></div>'}<div class="cover-bottom"><p class="imprint">记下平常，留给以后。</p><span>${book.year} · 生活手记</span></div></section>`;
  const body = `<main class="page">${cover}${contents}${renderedChapters.map(chapter => chapter.html).join('')}${sourceAppendix}</main>`;
  const visibleText = [title, '一年一册 翻阅章节 原始素材索引 展开原始素材 素材来源 素材： 日期待补 年度开篇 照片里的这一天 记下的这一天 0123456789 · 写在前面 回到那些日子 附 这一册的日子 个章节 从任意一页，重回这一年。 生活的年度存档 记下平常，留给以后。 生活手记', ...Object.values(chapterLabels), book.introBody,
    ...book.chapters.flatMap(chapter => [chapter.title, chapter.body, ...chapter.blocks.flatMap(block => [block.body, block.caption])]),
    ...[...records.values()].flatMap(record => [record.title, record.body, record.occurredOn ?? '', ...record.media.map(item => item.caption)]),
  ].join('\n');
  const fonts = await embeddedExportFonts(visibleText);
  signal?.throwIfAborted();
  return `<!doctype html><html lang="zh-CN" data-template="${book.template}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="only light"><meta name="darkreader-lock"><meta name="generator" content="一年一册"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escapeHtml(title)}</title><style>${fonts.css}\n${yearbookCss}</style></head><body class="template-${book.template}">${body}<template id="font-licenses">${escapeHtml(fonts.licenses)}</template></body></html>`;
}
