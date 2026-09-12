import { request as httpRequest } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { backup, createTestWorkspace, json, multipart, record, recordInput, restore, type TestWorkspace } from './helpers.js';

describe('恢复资料库期间的迟到 HTTP 请求', () => {
  let workspace: TestWorkspace; let app: FastifyInstance; let url: string;
  beforeEach(async () => { workspace = await createTestWorkspace(); app = await workspace.open('恢复 代次'); url = await app.listen({ host: '127.0.0.1', port: 0 }); });
  afterEach(async () => { await workspace.dispose(); });

  async function startPartial(path: string, bytes: Buffer, headers: Record<string, string>) {
    const arrived = new Promise<void>(yes => app.server.once('request', () => setImmediate(yes)));
    const request = httpRequest(new URL(path, url), { method: 'POST', headers: { ...headers, 'content-length': String(bytes.length) } });
    const response = new Promise<{ status: number; body: string }>((yes, no) => {
      request.once('error', no);
      request.once('response', response => { let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; }); response.once('end', () => yes({ status: response.statusCode!, body })); });
    });
    const split = Math.floor(bytes.length / 2);
    request.write(bytes.subarray(0, split));
    await arrived;
    return { request, response, finish: () => request.end(bytes.subarray(split)) };
  }

  it('JSON 上传跨越完整恢复后拒绝保存，不将旧页面操作写入新资料库', async () => {
    const original = await record(app, { title: '应保留的资料' });
    const copy = await backup(app);
    const pending = await startPartial('/api/records', Buffer.from(JSON.stringify({ title: '迟到写入', body: '旧页面提交的文字' })), { 'content-type': 'application/json' });
    try {
      await restore(app, copy.buffer);
      pending.finish();
      const response = await pending.response;
      expect(response.status).toBe(409);
      expect(JSON.parse(response.body).error.code).toBe('LIBRARY_RESTORED');
      const records = await json<{ items: { id: string }[]; total: number }>(app, 'GET', '/api/records');
      expect(records.total).toBe(1); expect(records.items[0].id).toBe(original.id);
    } finally { pending.request.destroy(); }
  });

  it('旧恢复文件迟到时拒绝再次覆盖已经恢复的新资料', async () => {
    const original = await record(app, { title: '旧备份中的标题' });
    const old = await backup(app);
    await json(app, 'PUT', `/api/records/${original.id}`, recordInput(original, { title: '新备份中的标题' }));
    const current = await backup(app);
    const upload = multipart([{ buffer: old.buffer, filename: '旧 备份.zip', mime: 'application/zip', field: 'file' }]);
    const pending = await startPartial('/api/backups/restore', upload.payload, upload.headers);
    try {
      await restore(app, current.buffer);
      pending.finish();
      const response = await pending.response;
      expect(response.status).toBe(409);
      expect(JSON.parse(response.body).error.code).toBe('LIBRARY_RESTORED');
      expect((await json<{ title: string }>(app, 'GET', `/api/records/${original.id}`)).title).toBe('新备份中的标题');
    } finally { pending.request.destroy(); }
  });
});
