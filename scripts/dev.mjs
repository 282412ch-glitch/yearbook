import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { root, checkNode, hash, waitForService, stopService } from './runtime.mjs';

checkNode();
const working = await mkdtemp(join(tmpdir(), 'yearbook-dev-'));
const token = process.env.YEARBOOK_INSTANCE_TOKEN || randomBytes(32).toString('hex');
const runtimeFile = process.env.YEARBOOK_RUNTIME_FILE ? resolve(process.env.YEARBOOK_RUNTIME_FILE) : resolve(working, 'server.json');
const children = [];
let service;
let closing = false;
let closePromise;
async function close() {
  if (closing) return closePromise;
  closing = true;
  closePromise = (async () => {
    if (service) await stopService({ ...service, token }).catch(() => {});
    for (const child of children) if (child.exitCode === null) child.kill();
    await rm(working, { recursive: true, force: true });
  })();
  return closePromise;
}
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
try {
  const server = spawn(process.execPath, ['--import', 'tsx', resolve(root, 'apps/server/src/index.ts')], {
    cwd: root, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true,
    env: { ...process.env, NODE_ENV: 'development', YEARBOOK_INSTANCE_TOKEN: token, YEARBOOK_RUNTIME_FILE: runtimeFile },
  });
  children.push(server);
  server.on('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; void close(); });
  service = await waitForService(runtimeFile, hash(token), server);
  if (closing) { await closePromise; process.exit(0); }
  const web = spawn(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), '--config', resolve(root, 'apps/web/vite.config.ts'), '--host', '127.0.0.1'], {
    cwd: root, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true,
    env: { ...process.env, YEARBOOK_API_URL: service.url },
  });
  children.push(web);
  web.on('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; void close(); });
  for (const child of children) child.once('exit', code => { if (!closing) { process.exitCode = code ?? 1; void close(); } });
  process.stdout.write('开发模式：前端热更新已启动。修改后端后请 Ctrl+C 重新运行 npm run dev。\n');
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; await close(); }
