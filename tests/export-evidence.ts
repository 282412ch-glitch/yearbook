import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { DataStore } from '../apps/server/src/db.js';
import { pauseExports, readExport, requestExport } from '../apps/server/src/exports.js';
import { getTask } from '../apps/server/src/tasks.js';
import { exportLayoutFixture } from './export-layout-fixture.js';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const allowed = resolve(repo, 'test-results');
const evidenceDir = resolve(process.argv[2] ?? join(allowed, `export-layout-${Date.now()}`));
if (!evidenceDir.startsWith(allowed + sep)) throw new Error('验收证据必须写入 test-results 内的独立目录');
await mkdir(allowed, { recursive: true });
await mkdir(evidenceDir); // Refuse to mix this test with a previous run.
const store = new DataStore(join(evidenceDir, '独立 验收数据'));
try {
  const fixture = await exportLayoutFixture(store);
  const results = [];
  for (const [template, book] of [['photo', fixture.photoBook], ['text', fixture.textBook]] as const) {
    for (const format of ['html', 'pdf'] as const) {
      const submitted = requestExport(store, book.id, format, `evidence-${template}-${format}`);
      const deadline = Date.now() + 125000;
      let task = submitted;
      while (!['completed', 'failed', 'cancelled'].includes(task.status) && Date.now() < deadline) {
        await new Promise(yes => setTimeout(yes, 150));
        task = await store.write(() => getTask(store, task.id));
      }
      if (task.status !== 'completed') throw new Error(`${template} ${format}: ${task.errorMessage || task.status}`);
      const output = await readExport(store, task.id);
      const outputFile = join(evidenceDir, `${template}.${format === 'html' ? 'zip' : 'pdf'}`);
      await writeFile(outputFile, output.buffer, { flag: 'wx' });
      if (format === 'html') {
        const html = new AdmZip(output.buffer).readAsText('index.html');
        await writeFile(join(evidenceDir, `${template}.html`), html, { flag: 'wx' });
      }
      const item = { template, format, outputFile, taskId: task.id, result: task.result, bytes: output.buffer.length };
      results.push(item);
      console.log(JSON.stringify(item));
    }
  }
  await writeFile(join(evidenceDir, 'receipt.json'), JSON.stringify({ generatedAt: new Date().toISOString(), dataDir: store.dataDir, records: fixture.records.length, media: fixture.media.length, books: [fixture.photoBook.id, fixture.textBook.id], results }, null, 2), { flag: 'wx' });
  console.log(`Evidence: ${evidenceDir}`);
} finally { await pauseExports(store); await store.close(); }
