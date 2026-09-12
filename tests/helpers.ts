import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { expect } from 'vitest';
import type { BackupInfo, MediaItem, RecordInput, RecordItem } from '@yearbook/shared';
import { createApp } from '../apps/server/src/app.js';

export type TestWorkspace = Awaited<ReturnType<typeof createTestWorkspace>>;

/** Every test owns its temporary directory; no test opens the application's real data. */
export async function createTestWorkspace() {
  const root = await mkdtemp(join(tmpdir(), 'yearbook 验收 '));
  const apps = new Set<FastifyInstance>();
  return {
    root,
    async open(name = '本地 数据') {
      const dataDir = resolve(root, name);
      if (!dataDir.startsWith(root + sep)) throw new Error('测试数据目录必须位于独立临时目录内');
      const app = await createApp({ dataDir });
      apps.add(app);
      await app.ready();
      return app;
    },
    async dispose() {
      for (const app of apps) await app.close();
      const absolute = resolve(root);
      if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('yearbook 验收 ')) {
        throw new Error('拒绝清理不属于本测试的目录');
      }
      await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

export async function json<T>(app: FastifyInstance, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, status = 200): Promise<T> {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload: JSON.stringify(payload), headers: { 'content-type': 'application/json' } }) });
  expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(status);
  return response.json<T>();
}

export async function record(app: FastifyInstance, input: Partial<RecordInput> = {}): Promise<RecordItem> {
  return json<RecordItem>(app, 'POST', '/api/records', { body: '今天在窗边读完一本书。', ...input }, 201);
}

export function recordInput(item: RecordItem, changes: Partial<RecordInput> = {}): RecordInput {
  return {
    title: item.title, body: item.body, occurredOn: item.occurredOn,
    people: item.people, tags: item.tags, location: item.location,
    isFirst: item.isFirst, includeInYearbook: item.includeInYearbook,
    media: item.media.map(({ id, caption }) => ({ id, caption })),
    ...changes,
  };
}

export type UploadFile = { buffer: Buffer; filename: string; mime?: string; field?: string };

export function multipart(files: UploadFile[]) {
  const boundary = `yearbook-test-${randomUUID()}`;
  const parts: Buffer[] = [];
  for (const file of files) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field ?? 'files'}"; filename="${file.filename}"\r\nContent-Type: ${file.mime ?? 'image/jpeg'}\r\n\r\n`, 'utf8'), file.buffer, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

export async function upload(app: FastifyInstance, files: UploadFile[]) {
  const response = await app.inject({ method: 'POST', url: '/api/media', ...multipart(files) });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ items: MediaItem[]; duplicates: number }>();
}

/** Real JPEG with optional EXIF; orientation 6 rotates the stored landscape image clockwise. */
export async function photo(options: { width?: number; height?: number; color?: string; orientation?: number; date?: string } = {}) {
  let image = sharp({ create: { width: options.width ?? 120, height: options.height ?? 80, channels: 3, background: options.color ?? '#985b40' } });
  if (options.orientation) image = image.withMetadata({ orientation: options.orientation });
  if (options.date) image = image.withExifMerge({ IFD2: { DateTimeOriginal: options.date } });
  return image.jpeg({ quality: 90 }).toBuffer();
}

export async function backup(app: FastifyInstance) {
  const item = await json<BackupInfo>(app, 'POST', '/api/backups', undefined, 201);
  const response = await app.inject({ method: 'GET', url: `/api/backups/${item.id}/download` });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.headers['content-type']).toContain('application/zip');
  return { item, buffer: response.rawPayload };
}

export async function restore(app: FastifyInstance, buffer: Buffer, status = 200) {
  const response = await app.inject({ method: 'POST', url: '/api/backups/restore', ...multipart([{ buffer, filename: '生活 备份.zip', mime: 'application/zip', field: 'file' }]) });
  expect(response.statusCode, response.body).toBe(status);
  return response;
}
