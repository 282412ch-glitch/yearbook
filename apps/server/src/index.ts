import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createApp, instanceId } from './app.js';

process.env.NODE_ENV ??= 'production';

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const dataDir = resolve(process.env.YEARBOOK_DATA_DIR ?? resolve(projectRoot, 'data'));
const webDist = resolve(process.env.YEARBOOK_WEB_DIST ?? resolve(projectRoot, 'apps/web/dist'));
const initialPort = Number(process.env.YEARBOOK_PORT ?? 4317);
if (!Number.isInteger(initialPort) || initialPort < 1 || initialPort > 65515) throw new Error('YEARBOOK_PORT 应在 1–65515 之间');
const app = await createApp({ dataDir, webDist });
const runtimeFile = process.env.YEARBOOK_RUNTIME_FILE ? resolve(process.env.YEARBOOK_RUNTIME_FILE) : null;
const identifier = instanceId(process.env.YEARBOOK_INSTANCE_TOKEN);
app.addHook('onClose', async () => {
  if (runtimeFile) {
    try { const current = JSON.parse(await readFile(runtimeFile, 'utf8')); if (current.pid === process.pid && current.instanceId === identifier) await rm(runtimeFile, { force: true }); } catch { /* Already removed or belongs to another process. */ }
  }
});
let started = false;
for (let port = initialPort; port <= initialPort + 20; port++) {
  try {
    const url = await app.listen({ host: '127.0.0.1', port });
    if (runtimeFile) { await mkdir(dirname(runtimeFile), { recursive: true }); await writeFile(runtimeFile, JSON.stringify({ pid: process.pid, url, instanceId: identifier }, null, 2), 'utf8'); }
    process.stdout.write(`一年一册已启动：${url}\n数据目录：${dataDir}\n`);
    started = true;
    break;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') { await app.close(); throw error; }
  }
}
if (!started) { await app.close(); throw new Error(`端口 ${initialPort}–${initialPort + 20} 均被占用，请设置其他 YEARBOOK_PORT`); }
let closing = false;
const close = () => { if (!closing) { closing = true; void app.close(); } };
process.once('SIGINT', close);
process.once('SIGTERM', close);
