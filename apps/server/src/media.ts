import { createHash, randomUUID } from 'node:crypto';
import { writeFile, rename, rm, readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import sharp, { type Metadata } from 'sharp';
import exifr from 'exifr';
import { isLocalDate } from '@yearbook/shared';
import type { DataStore } from './db.js';
import { AppError } from './errors.js';
import { presentMedia, type MediaRow } from './records.js';
import { authorizeLetterPhotoReimport } from './letters.js';

const formats: Record<string, { extension: string; mime: string }> = {
  jpeg: { extension: 'jpg', mime: 'image/jpeg' }, png: { extension: 'png', mime: 'image/png' },
  webp: { extension: 'webp', mime: 'image/webp' }, gif: { extension: 'gif', mime: 'image/gif' },
  avif: { extension: 'avif', mime: 'image/avif' }, heif: { extension: 'heif', mime: 'image/heif' },
  tiff: { extension: 'tif', mime: 'image/tiff' },
};
export const MAX_PHOTO_BYTES = 25 * 1024 * 1024;

export function mediaFiles(row: Pick<MediaRow, 'hash' | 'extension'>) {
  if (!/^[a-f0-9]{64}$/.test(row.hash) || !/^(jpg|png|webp|gif|avif|heif|tif)$/.test(row.extension)) throw new AppError(400, 'INVALID_MEDIA', '照片文件信息无效');
  return { original: `media/${row.hash}.${row.extension}`, display: `display/${row.hash}.jpg`, thumbnail: `thumbnails/${row.hash}.jpg` };
}

async function suggestedDate(buffer: Buffer): Promise<string | null> {
  try {
    const data = await exifr.parse(buffer, { pick: ['DateTimeOriginal', 'CreateDate'], reviveValues: false });
    const value = data?.DateTimeOriginal ?? data?.CreateDate;
    if (typeof value === 'string') {
      const match = value.match(/^(\d{4})[:-](\d{2})[:-](\d{2})/);
      if (match) { const date = `${match[1]}-${match[2]}-${match[3]}`; if (isLocalDate(date)) return date; }
    }
    return null;
  } catch { return null; }
}

async function atomicWrite(store: DataStore, relative: string, buffer: Buffer) {
  const temporary = join(store.dataDir, 'tmp', `${randomUUID()}.upload`);
  try {
    await writeFile(temporary, buffer, { flag: 'wx' });
    await rename(temporary, join(store.dataDir, relative));
  } finally { await rm(temporary, { force: true }); }
}

export async function importMedia(store: DataStore, buffer: Buffer, rawFilename: string) {
  if (!buffer.length || buffer.length > MAX_PHOTO_BYTES) throw new AppError(413, 'PHOTO_SIZE', '每张照片需大于 0 字节且不超过 25 MB');
  const hash = createHash('sha256').update(buffer).digest('hex');
  const existing = store.db.prepare('SELECT * FROM media WHERE hash = ?').get(hash) as MediaRow | undefined;
  if (existing) {
    // Only a full hash-matching upload may re-use a photo hidden by a sealed future letter.
    authorizeLetterPhotoReimport(store, existing.id);
    return { item: presentMedia(existing), duplicate: true };
  }
  let original: Metadata;
  let display: Buffer;
  let thumbnail: Buffer;
  try {
    const decoder = sharp(buffer, { limitInputPixels: 100_000_000, failOn: 'error' });
    original = await decoder.metadata();
    if (!original.format || !formats[original.format]) throw new Error('不支持的格式');
    display = await decoder.clone().rotate().resize({ width: 3200, height: 3200, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#f6f2e9' }).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
    thumbnail = await decoder.clone().rotate().resize({ width: 600, height: 600, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#f6f2e9' }).jpeg({ quality: 82 }).toBuffer();
  } catch { throw new AppError(400, 'INVALID_PHOTO', '无法读取这张照片。请使用 JPEG、PNG、WebP、GIF、AVIF 或受支持的 TIFF 照片'); }
  const rotated = [5, 6, 7, 8].includes(original.orientation ?? 1);
  const row: MediaRow = {
    id: randomUUID(), hash, ...formats[original.format!], filename: basename(rawFilename.replace(/\\/g, '/')).slice(0, 255) || '照片', size: buffer.length,
    width: (rotated ? original.height : original.width)!, height: (rotated ? original.width : original.height)!,
    suggested_date: await suggestedDate(buffer), created_at: new Date().toISOString(),
  };
  const files = mediaFiles(row);
  await atomicWrite(store, files.original, buffer);
  await atomicWrite(store, files.display, display);
  await atomicWrite(store, files.thumbnail, thumbnail);
  store.db.prepare('INSERT INTO media(id, hash, extension, filename, mime, size, width, height, suggested_date, created_at) VALUES (@id, @hash, @extension, @filename, @mime, @size, @width, @height, @suggested_date, @created_at)').run(row);
  return { item: presentMedia(row), duplicate: false };
}

export async function readMedia(store: DataStore, id: string, kind: 'original' | 'display' | 'thumbnail') {
  const row = store.db.prepare('SELECT * FROM media WHERE id = ?').get(id) as MediaRow | undefined;
  if (!row) throw new AppError(404, 'NOT_FOUND', '这张照片不存在');
  const file = mediaFiles(row)[kind];
  try { return { buffer: await readFile(join(store.dataDir, file)), mime: kind === 'original' ? row.mime : 'image/jpeg', filename: row.filename, hash: row.hash }; }
  catch { throw new AppError(404, 'MEDIA_FILE_MISSING', '照片文件缺失，请从备份恢复'); }
}
