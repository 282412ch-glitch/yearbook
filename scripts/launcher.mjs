import { spawn } from 'node:child_process';
import { open, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { root, runtimeDir, hash, checkNode, readJson, health, waitForService, stopService } from './runtime.mjs';

const statePath = resolve(runtimeDir, 'launcher.json');
const servicePath = resolve(runtimeDir, 'server.json');
const logPath = resolve(runtimeDir, 'server.log');
const action = process.argv[2] ?? 'start';
function openBrowser(url) {
  if (process.argv.includes('--no-browser')) return;
  const browser = process.platform === 'win32'
    ? spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true })
    : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' });
  browser.on('error', () => process.stdout.write(`请在浏览器中打开：${url}\n`));
  browser.unref();
}
try {
  checkNode();
  await mkdir(runtimeDir, { recursive: true });
  if (action === 'stop') {
    const state = await readJson(statePath);
    if (!state) process.stdout.write('启动器没有正在管理的服务。若在终端运行 npm start，请在该终端按 Ctrl+C。\n');
    else {
      const stopped = await stopService(state);
      const latest = await readJson(statePath);
      if (latest?.token === state.token) await rm(statePath, { force: true });
      process.stdout.write(stopped ? '一年一册已停止，数据已保存。\n' : '本启动器创建的服务已经停止。\n');
    }
  } else if (action === 'start') {
    const lockFile = resolve(runtimeDir, 'launcher.lock');
    let lock;
    try { lock = await open(lockFile, 'wx'); await lock.writeFile(JSON.stringify({ pid: process.pid })); }
    catch {
      const old = await readJson(lockFile);
      let exited = false;
      if (old?.pid) { try { process.kill(old.pid, 0); } catch (e) { exited = e.code === 'ESRCH'; } }
      if (exited) { await rm(lockFile, { force: true }); lock = await open(lockFile, 'wx'); await lock.writeFile(JSON.stringify({ pid: process.pid })); }
      else throw new Error(old?.pid ? '另一个启动器正在启动，请稍后再试' : `启动锁不完整。请确认所有启动窗口已关闭后删除此锁文件，再重试：${lockFile}`);
    }
    try {
      const existing = await readJson(statePath);
      const current = existing && await health(existing.url);
      if (current && current.pid === existing.pid && current.instanceId === hash(existing.token ?? '')) {
        process.stdout.write(`一年一册已经运行：${existing.url}\n`);
        openBrowser(existing.url);
      } else {
        try { await access(resolve(root, 'node_modules/fastify/package.json')); await access(resolve(root, 'apps/server/dist/index.js')); await access(resolve(root, 'apps/web/dist/index.html')); }
        catch { throw new Error('首次使用请在项目目录运行 npm ci 和 npm run build，再打开启动器'); }
        const token = randomBytes(32).toString('hex');
        const log = await open(logPath, 'a');
        const child = spawn(process.execPath, [resolve(root, 'apps/server/dist/index.js')], {
          cwd: root, windowsHide: true, detached: true, stdio: ['ignore', log.fd, log.fd],
          env: { ...process.env, NODE_ENV: 'production', YEARBOOK_INSTANCE_TOKEN: token, YEARBOOK_RUNTIME_FILE: servicePath },
        });
        child.on('error', () => {});
        await log.close();
        let state;
        try {
          state = await waitForService(servicePath, hash(token), child);
          const pendingState = resolve(runtimeDir, `launcher-${process.pid}.json`);
          try {
            await writeFile(pendingState, JSON.stringify({ ...state, token }, null, 2), { mode: 0o600 });
            await (await import('node:fs/promises')).rename(pendingState, statePath);
          } finally { await rm(pendingState, { force: true }); }
        } catch (error) {
          if (state) await stopService({ ...state, token }).catch(() => {});
          if (child.exitCode === null) child.kill();
          throw new Error(`${error.message}。日志：${logPath}`);
        }
        child.unref();
        process.stdout.write(`一年一册已就绪：${state.url}\n关闭此窗口后服务继续运行；双击 Stop-Yearbook.cmd 可停止。\n`);
        openBrowser(state.url);
      }
    } finally { await lock.close(); await rm(lockFile, { force: true }); }
  } else throw new Error('用法：node scripts/launcher.mjs start|stop [--no-browser]');
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
