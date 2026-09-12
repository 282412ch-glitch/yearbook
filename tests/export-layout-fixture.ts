import sharp from 'sharp';
import type { YearbookInput } from '@yearbook/shared';
import type { DataStore } from '../apps/server/src/db.js';
import { importMedia } from '../apps/server/src/media.js';
import { saveRecord } from '../apps/server/src/records.js';
import { saveYearbook } from '../apps/server/src/yearbooks.js';
import { recordInputSchema } from '@yearbook/shared';

/** Synthetic content and test images only; this fixture never reads a user's photos or credentials. */
export async function exportLayoutFixture(store: DataStore) {
  const landscape = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#a6bec0' } }).composite([
    { input: Buffer.from('<svg width="1200" height="800"><rect x="0" y="530" width="1200" height="270" fill="#6e8061"/><circle cx="920" cy="160" r="85" fill="#f3d9a2"/><rect x="80" y="80" width="1040" height="640" fill="none" stroke="#fff" stroke-width="12"/></svg>') },
  ]).jpeg({ quality: 88 }).toBuffer();
  const portrait = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#c9ab87' } }).composite([
    { input: Buffer.from('<svg width="1200" height="800"><rect x="170" y="100" width="800" height="600" fill="#657d80"/><path d="M570 100V700M170 400H970" stroke="#ede8d8" stroke-width="20"/><rect x="70" y="55" width="1060" height="690" fill="none" stroke="#fff" stroke-width="12"/></svg>') },
  ]).withMetadata({ orientation: 6 }).jpeg({ quality: 88 }).toBuffer();
  const square = await sharp({ create: { width: 900, height: 900, channels: 3, background: '#c6cbaf' } }).composite([
    { input: Buffer.from('<svg width="900" height="900"><circle cx="450" cy="450" r="275" fill="#f2e5c4"/><circle cx="450" cy="450" r="160" fill="#a78067"/><rect x="65" y="65" width="770" height="770" fill="none" stroke="#fff" stroke-width="12"/></svg>') },
  ]).jpeg({ quality: 88 }).toBuffer();
  const media = [];
  for (const [filename, bytes] of [['横图 测试.jpg', landscape], ['竖图 EXIF测试.jpg', portrait], ['方图 测试.jpg', square]] as const) media.push((await importMedia(store, bytes, filename)).item);
  const walk = saveRecord(store, recordInputSchema.parse({ title: '河边的周末', occurredOn: '2024-03-17', people: ['家人'], body: '早上沿着河边慢慢走。妈妈说：“这条路，春天可以再来一次。”\n没有急着赶路，拍下横向的河岸和竖向的窗边。', media: [{ id: media[0].id, caption: '横向测试照片：白色边框应完整，画面不能被裁切。' }, { id: media[1].id, caption: '竖向测试照片：按 EXIF 方向旋转，窗框保持原有比例。' }] }));
  const photosOnly = saveRecord(store, recordInputSchema.parse({ occurredOn: '2024-06-02', media: [{ id: media[2].id, caption: '仅有照片也会进入年册，图形应保持正圆。' }] }));
  const first = saveRecord(store, recordInputSchema.parse({ title: '第一次自己烤面包', occurredOn: '2024-09-08', body: '按自己写下的步骤烤完一盘面包。边缘有点焦，我把这一点也记下。', isFirst: true }));
  const longBody = Array.from({ length: 22 }, (_, index) => `长中文排版核对第 ${String(index + 1).padStart(2, '0')} 段。下班后把今天的事情写进本子里，记住一起吃饭的人、窗外的雨和路过的小店。这些句子用于检查段落能否在页面之间自然延续；字应清楚，左右边缘完整，页尾不能截去半行。周末再打开时，还能找到那天留下的照片与原话。`).join('\n\n');
  const input: YearbookInput = {
    year: 2024, title: '2024 · 存下这些日常', template: 'photo', coverMediaId: media[0].id,
    introBody: '这一年，留下几张照片和一些具体的日子。\n\n这是独立验收素材，并非用户的真实记录。',
    chapters: [
      { kind: 'cover', title: '不会重复的空封面', body: '', blocks: [], sourceRecordIds: [] },
      { kind: 'opening', title: '先从这些日子说起', body: '少一点结论，多保留当时写下的话。', blocks: [], sourceRecordIds: [] },
      { kind: 'month', title: '二月空月份不应出现', body: '', blocks: [], sourceRecordIds: [] },
      { kind: 'month', title: '三月 · 河边', body: longBody, blocks: [{ type: 'record', recordId: walk.id, body: '', mediaId: null, caption: '' }], sourceRecordIds: [walk.id] },
      { kind: 'month', title: '六月 · 一张照片', body: '', blocks: [{ type: 'record', recordId: photosOnly.id, body: '', mediaId: null, caption: '' }], sourceRecordIds: [photosOnly.id] },
      { kind: 'firsts', title: '生活第一次', body: '', blocks: [{ type: 'record', recordId: first.id, body: '', mediaId: null, caption: '' }], sourceRecordIds: [first.id] },
      { kind: 'photos', title: '年度照片选集', body: '选集顺序：先竖图，后横图。', blocks: [
        { type: 'image', mediaId: media[1].id, caption: '选集第一张：竖向照片。', recordId: null, body: '' },
        { type: 'image', mediaId: media[0].id, caption: '选集第二张：横向照片。', recordId: null, body: '' },
      ], sourceRecordIds: [walk.id] },
      { kind: 'letter', title: '写给明年的自己', body: '明年回来翻这本年册时，愿意的话，再补上一段“现在回头看”。\n\n全书末尾核对：文字、照片与排列顺序已经完整保存。', blocks: [], sourceRecordIds: [] },
      { kind: 'cover', title: '封面附页', body: '用户填写过的封面附记必须保留在这一页。', blocks: [], sourceRecordIds: [] },
    ],
  };
  const photoBook = saveYearbook(store, input);
  const textBook = saveYearbook(store, { ...input, template: 'text' });
  return { photoBook, textBook, media, records: [walk, photosOnly, first], longBody };
}
