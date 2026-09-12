import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RecordItem, YearbookBlock, YearbookChapter, YearbookItem } from '@yearbook/shared';
import type { DataStore } from './db.js';
import { AppError } from './errors.js';
import { embeddedExportFonts } from './export-fonts.js';
import { mediaFiles } from './media.js';
import { getRecord, type MediaRow } from './records.js';

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
  if (hasText(book.introBody) && !firstOpening) {
    renderedChapters.push({ id: 'annual-opening', title: '年度开篇', html: `<section class="chapter opening" id="annual-opening"><header class="chapter-heading"><h2>年度开篇</h2></header><div class="prose chapter-body">${paragraphs(book.introBody)}</div></section>` });
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
    renderedChapters.push({ id, title, html: `<section class="chapter kind-${chapter.kind}${keepPhotoLead}" id="${id}" data-kind="${chapter.kind}"><header class="chapter-heading"><h2>${escapeHtml(title)}</h2></header>${content}${sources}</section>` });
  }
  const unshownSources = [...records.values()].filter(record => !linkedRecords.has(record.id));
  const sourceAppendix = unshownSources.length ? `<section class="chapter source-appendix" id="source-appendix"><header class="chapter-heading"><h2>原始素材索引</h2></header>${unshownSources.map(record => renderRecord(record, true)).join('')}</section>` : '';
  const title = book.title || `${book.year} 年册`;
  const contents = renderedChapters.length > 1 ? `<nav class="contents" aria-label="年册目录"><p>翻阅章节</p><ol>${renderedChapters.map(chapter => `<li><a href="#${chapter.id}">${escapeHtml(chapter.title)}</a></li>`).join('')}${sourceAppendix ? '<li><a href="#source-appendix">原始素材索引</a></li>' : ''}</ol></nav>` : '';
  const cover = `<section class="cover${title.length > 80 ? ' long-title' : ''}" aria-label="封面"><p class="cover-year">${book.year}</p><h1>${escapeHtml(title)}</h1>${book.coverMediaId ? picture(book.coverMediaId, '', true) : ''}<p class="imprint">一年一册</p></section>`;
  const body = `<main class="page">${cover}${contents}${renderedChapters.map(chapter => chapter.html).join('')}${sourceAppendix}</main>`;
  const visibleText = [title, '一年一册 翻阅章节 原始素材索引 展开原始素材 素材来源 素材： 日期待补 年度开篇 照片里的这一天 记下的这一天 0123456789 ·', ...Object.values(chapterLabels), book.introBody,
    ...book.chapters.flatMap(chapter => [chapter.title, chapter.body, ...chapter.blocks.flatMap(block => [block.body, block.caption])]),
    ...[...records.values()].flatMap(record => [record.title, record.body, record.occurredOn ?? '', ...record.media.map(item => item.caption)]),
  ].join('\n');
  const fonts = await embeddedExportFonts(visibleText);
  signal?.throwIfAborted();
  return `<!doctype html><html lang="zh-CN" data-template="${book.template}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="generator" content="一年一册"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escapeHtml(title)}</title><style>${fonts.css}\n${yearbookCss}</style></head><body class="template-${book.template}">${body}<template id="font-licenses">${escapeHtml(fonts.licenses)}</template></body></html>`;
}

// Quiet paper and olive follow the application's existing Almanac palette. Print deliberately stays light.
const yearbookCss = `
:root{color-scheme:only light;--paper:#f6f3eb;--surface:#fffdf8;--ink:#30312c;--muted:#65685d;--rule:#d9d7ca;--accent:#5f6c48;--serif:YearbookSerif,"Songti SC",serif;--sans:YearbookSans,"Microsoft YaHei",sans-serif}
*{box-sizing:border-box}html{background:var(--paper);color:var(--ink)}body{margin:0;font-family:var(--sans);font-size:16px;line-height:1.85}a{color:var(--accent);text-underline-offset:3px;overflow-wrap:anywhere}a:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:4px}h1,h2,h3,p,figure,blockquote,ol,ul{margin:0}h1,h2,h3{font-weight:400;font-family:var(--serif);line-height:1.5;overflow-wrap:anywhere;text-wrap:balance}h1{font-size:42px}h2{font-size:28px}h3{font-size:20px}.page{max-width:900px;margin:0 auto;padding:44px 56px;background:var(--surface)}.cover{text-align:center;min-height:680px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;padding:20px 0 56px}.cover-year{font-size:18px;letter-spacing:.14em;color:var(--muted);font-variant-numeric:tabular-nums}.cover h1{max-width:20em}.cover-photo{margin:12px 0 0;width:100%}.cover-photo img{display:block;width:auto;height:auto;max-width:100%;max-height:440px;object-fit:contain;margin:0 auto}.imprint{font-family:var(--serif);font-size:14px;letter-spacing:.2em;color:var(--muted)}.long-title h1{font-size:25px}.long-title .cover-photo img{max-height:260px}.contents{padding:28px 0;border-block:1px solid var(--rule);font-size:14px}.contents>p{color:var(--muted);margin-bottom:12px}.contents ol{list-style:none;padding:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 24px}.contents a{display:inline-block;padding:3px 0}.chapter{padding:38px 0 30px;border-bottom:1px solid var(--rule)}.chapter-heading{margin-bottom:20px}.prose{max-width:42em;overflow-wrap:anywhere;line-break:strict;word-break:normal}.prose p{white-space:pre-wrap;orphans:3;widows:3}.prose p+p{margin-top:1em}.chapter-body{margin-bottom:24px}.paragraph-block{margin:18px auto}.record{margin:30px 0}.record-heading{margin-bottom:14px}.record-date{font-size:13px;color:var(--muted);font-variant-numeric:tabular-nums;margin-bottom:4px}.record-body{margin:18px auto}.photo{margin:24px auto;text-align:center;width:100%;break-inside:avoid;page-break-inside:avoid}.photo img{display:block;width:auto;height:auto;max-width:100%;max-height:640px;object-fit:contain;margin:0 auto}.photo figcaption{max-width:48em;margin:9px auto 0;font-family:var(--sans);font-size:13px;color:var(--muted);line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere;orphans:3;widows:3}.long-caption{break-inside:auto;page-break-inside:auto}.long-caption img{max-height:340px;break-after:avoid}.long-caption figcaption{break-before:avoid}blockquote{margin:24px auto;padding:12px 0 12px 22px;border-left:2px solid var(--accent);font-family:var(--serif);color:var(--muted)}.sources{font-family:var(--sans);font-size:12px;color:var(--muted);padding-top:12px;margin-top:22px;border-top:1px solid var(--rule)}.sources>p{margin-bottom:5px}.sources ul{padding-left:1.4em}.sources li{overflow-wrap:anywhere}.block-source{font:12px/1.7 var(--sans);color:var(--muted);margin:5px 0 20px}.source-record{margin:20px 0}.source-record h3{font-size:17px}.source-details summary{font-size:13px;color:var(--accent);cursor:pointer;margin-bottom:14px}.template-text .page{max-width:800px;padding-inline:70px}.template-text .prose{font-family:var(--serif);font-size:17px;line-height:2}.template-text .cover-photo img{max-height:330px}.template-text .photo{max-width:600px}.template-text .photo img{max-height:390px}.template-text .record{margin:26px 0}.template-text .record-heading{margin-bottom:10px}.template-photo .prose{max-width:40em}.template-photo .photo+ .record-body{margin-top:20px}
@page{size:A4;margin:16mm 18mm 18mm}
@media print{html,body{background:#fff;color:var(--ink)}body{-webkit-print-color-adjust:exact;print-color-adjust:exact;font-size:11pt;line-height:1.85}.page,.template-text .page{width:100%;max-width:none;margin:0;padding:0;background:#fff;min-height:0}.template-text .page{width:150mm;margin-inline:auto}.cover{height:auto;min-height:248mm;padding:4mm 0 8mm;gap:5mm;break-after:page;page-break-after:always}.cover h1{font-size:31pt;line-height:1.4}.cover-year{font-size:14pt}.cover-photo{margin:4mm 0 0}.cover-photo img{max-height:150mm;max-width:100%}.template-text .cover-photo img{max-height:110mm}.long-title h1{font-size:18pt}.long-title .cover-photo img,.template-text .long-title .cover-photo img{max-height:78mm}.imprint{font-size:10pt}.contents{display:none}.chapter{padding:7mm 0 5mm;break-inside:auto;page-break-inside:auto;border-bottom:0}.chapter-heading{margin-bottom:4mm;break-inside:avoid;break-after:avoid;page-break-after:avoid}h2{font-size:20pt}h3{font-size:13pt}.record{margin:6mm 0;break-inside:auto;page-break-inside:auto}.record-heading{margin-bottom:3mm;break-inside:avoid;break-after:avoid;page-break-after:avoid}.record-date{font-size:9pt}.prose,.template-photo .prose{max-width:145mm;margin-inline:auto}.template-text .prose{max-width:none;font-size:11.5pt;line-height:1.95}.chapter-body{margin-bottom:5mm}.record-body,.paragraph-block{margin-block:4mm}.photo{margin:5mm auto}.photo img{max-height:162mm;max-width:100%;object-fit:contain}.photo.portrait img{max-height:162mm}.photo figcaption{font-size:9pt;margin-top:2mm;line-height:1.55}.template-text .photo{max-width:142mm;margin-block:4mm}.template-text .photo img{max-height:103mm}.long-caption img,.template-text .long-caption img{max-height:80mm}.sources{font-size:8.5pt;margin-top:4mm;padding-top:2mm;break-inside:auto}.sources>p{break-after:avoid}.sources li{break-inside:avoid}.sources a,.block-source a{color:var(--muted);text-decoration:none}.block-source{font-size:8.5pt}blockquote{margin:5mm auto;padding:2mm 0 2mm 5mm;break-inside:auto}.source-record .record-heading{break-after:auto}.source-record .source-details{display:none}.source-record h3{font-size:11pt}}
@media print{.keep-photo-lead>.chapter-body{break-inside:avoid;break-after:avoid;page-break-after:avoid}.chapter:last-child{padding-bottom:0;border-bottom:0}.chapter:last-child>:last-child{margin-bottom:0}.cover:last-child{break-after:auto;page-break-after:auto}}
@media screen and (max-width:640px){.page,.template-text .page{padding:24px}.cover{min-height:520px;padding-bottom:30px}.cover h1{font-size:32px}.long-title h1{font-size:23px}.cover-photo img,.template-text .cover-photo img{max-height:360px}.contents ol{grid-template-columns:1fr}.chapter{padding-block:28px}h2{font-size:24px}.template-text .prose{font-size:16px}.photo img,.template-text .photo img{max-height:520px}blockquote{padding-left:15px}}
`;
