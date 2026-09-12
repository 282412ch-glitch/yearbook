import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { access, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, rmdir, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { root, checkNode, hash, health, isLocalUrl, readJson, stopService } from './runtime.mjs';

/**
 * Windows integration verification. Run: node scripts/verify-runtime.mjs
 * A copied project, source build, runtime state and all application data live below a
 * new temporary Chinese/space path. Dependencies are linked; source data/.runtime/.git
 * are never copied or opened. Start-Yearbook.cmd intentionally opens one test page.
 * Use --use-existing-build only when explicitly checking the current built artifacts.
 */
checkNode();
assert.equal(process.platform, 'win32', '此验收脚本用于真实 Windows 启动器');
const startedAt = new Date().toISOString();
const working = await mkdtemp(join(tmpdir(), 'yearbook Windows 全路径 '));
const project = join(working, '一年一册 项目');
const dependencyLinks = [];
const ownedChildren = new Set();
const ownedServices = [];
const evidencePath = resolve(root, 'test-results/runtime-final.json');
const evidence = { passed: false, startedAt, platform: process.platform, node: process.versions.node,
  sourceProject: root, testedProject: project, explicitTemporaryData: true,
  sourceBuild: !process.argv.includes('--use-existing-build'), steps: [], cleanup: {}, warnings: [] };
let sentinel;
let blockedPort;
let npmCli;
let guard;
let aborted = false;
process.once('SIGINT', () => { aborted = true; });
process.once('SIGTERM', () => { aborted = true; });

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const stripAnsi = value => value.replace(/\x1b\[[0-9;]*m/g, '');
const inside = (base, path) => { const rel = relative(resolve(base), resolve(path)); return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !resolve(path).startsWith('\\\\') && !rel.includes(':'); };
function say(message) { process.stdout.write(`[Windows 验收] ${message}\n`); }
function environment(label, extra = {}) {
  const dataDir = join(project, '验收 资料', label);
  assert.ok(inside(working, dataDir));
  return { ...process.env, YEARBOOK_DATA_DIR: dataDir, YEARBOOK_WEB_DIST: join(project, 'apps/web/dist'),
    YEARBOOK_PORT: String(blockedPort ?? 59000), YEARBOOK_RUNTIME_FILE: join(project, '.runtime', `${label}.json`),
    YEARBOOK_INSTANCE_TOKEN: randomBytes(32).toString('hex'), ...extra };
}

function launch(command, args, env, options = {}) {
  assert.ok(env.YEARBOOK_DATA_DIR && inside(working, env.YEARBOOK_DATA_DIR), '每个受测进程都必须显式指定独立资料目录');
  const child = spawn(command, args, { cwd: options.cwd ?? project, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const state = { child, output: '', closed: false, result: null };
  ownedChildren.add(state);
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  const collect = chunk => { state.output = (state.output + chunk).slice(-60000); };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  child.once('error', error => { state.result = { code: null, error: error.message }; state.closed = true; });
  child.once('close', (code, signal) => { state.result ??= { code, signal }; state.closed = true; });
  child.stdin.on('error', () => {});
  child.stdin.end(options.input ?? '', 'utf8');
  return state;
}
async function until(label, predicate, timeout = 25000) {
  const deadline = Date.now() + timeout;
  let nextUpdate = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (aborted) throw new Error('验收已取消，正在停止本次创建的进程');
    const result = await predicate();
    if (result) return result;
    if (Date.now() >= nextUpdate) { say(`${label}仍在执行`); nextUpdate = Date.now() + 15000; }
    await delay(100);
  }
  throw new Error(`${label}未在 ${timeout / 1000} 秒内完成`);
}
async function finished(state, label, timeout = 45000) {
  await until(label, () => state.closed, timeout);
  assert.equal(state.result.code, 0, `${label}失败：${state.output}\n${state.result.error ?? ''}`);
  return stripAnsi(state.output);
}
async function command(label, args, env, timeout) {
  return finished(launch(process.execPath, args, env), label, timeout);
}
async function step(name, action) {
  say(name);
  const start = Date.now();
  try {
    const result = await action();
    evidence.steps.push({ name, passed: true, durationMs: Date.now() - start, ...result });
    return result;
  } catch (error) {
    evidence.steps.push({ name, passed: false, durationMs: Date.now() - start, error: error.message });
    throw error;
  }
}
async function json(url, path, method = 'GET', body, headers = {}) {
  assert.ok(isLocalUrl(url));
  const response = await fetch(new URL(path, url), { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
  const value = await response.json();
  assert.ok(response.ok, `${method} ${path}: HTTP ${response.status} ${JSON.stringify(value)}`);
  return value;
}
async function verifyFrontend(url, dev = false) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>一年一册<\/title>/);
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(match => match[1]);
  assert.ok(scripts.length > 0, '首页必须连接真实前端脚本');
  const assets = [];
  for (const path of [...scripts, ...[...html.matchAll(/<link[^>]+href="([^"]+\.css)"/g)].map(match => match[1])]) {
    assert.ok(path.startsWith('/') && !path.startsWith('//'), '界面资源必须由本机提供');
    const asset = await fetch(new URL(path, url), { signal: AbortSignal.timeout(10000) });
    assert.equal(asset.status, 200, `${path}必须可读取`);
    const bytes = Buffer.from(await asset.arrayBuffer());
    assert.ok(bytes.length > 0);
    assets.push({ path, bytes: bytes.length, sha256: sha(bytes) });
  }
  if (dev) assert.ok(scripts.some(path => path.includes('/src/main.tsx')));
  return { htmlSha256: sha(html), assets };
}
async function serviceReady(file, token, parent, label) {
  const state = await until(label, async () => {
    if (parent?.closed) throw new Error(`${label}进程提前退出：${parent.output}`);
    const entry = await readJson(file);
    if (!entry || entry.instanceId !== hash(token) || !isLocalUrl(entry.url)) return null;
    const current = await health(entry.url);
    return current?.pid === entry.pid && current.instanceId === entry.instanceId ? entry : null;
  });
  assert.notEqual(new URL(state.url).port, '4317', '不触碰正式服务端口');
  const owned = { ...state, token, parent, stopped: false };
  ownedServices.push(owned);
  return owned;
}
async function startNpm(label, script = 'start') {
  const env = environment(label);
  const parent = launch(process.execPath, [npmCli, ...(script === 'start' ? ['start'] : ['run', script])], env);
  const state = await serviceReady(env.YEARBOOK_RUNTIME_FILE, env.YEARBOOK_INSTANCE_TOKEN, parent, `npm ${script} 启动`);
  const stats = await json(state.url, '/api/stats');
  assert.equal(resolve(stats.dataDir), resolve(env.YEARBOOK_DATA_DIR));
  return { state, parent, env };
}
async function stopOwned(state) {
  if (state.stopped) return;
  await stopService(state);
  state.stopped = true;
  if (state.parent) await finished(state.parent, '应用及 npm 父进程退出', 10000);
}
async function sentinelAlive() {
  const response = await fetch(`http://127.0.0.1:${blockedPort}/`, { signal: AbortSignal.timeout(2000) });
  assert.equal((await response.json()).app, 'yearbook-runtime-unrelated-sentinel');
  if (guard && !guard.state.stopped) assert.equal((await health(guard.state.url))?.pid, guard.state.pid, '其他本次测试服务必须继续运行');
}
async function dependencyLink(source, destination) {
  assert.ok(inside(project, destination));
  await symlink(source, destination, 'junction');
  dependencyLinks.push({ source: resolve(source), destination: resolve(destination) });
}
async function copyProject() {
  await mkdir(project);
  const allowed = ['package.json', 'package-lock.json', 'tsconfig.json', 'tsup.config.ts', 'apps', 'packages', 'scripts', 'Start-Yearbook.cmd', 'Stop-Yearbook.cmd'];
  for (const name of allowed) {
    await cp(join(root, name), join(project, name), { recursive: true, dereference: false,
      filter: path => !relative(root, path).split(sep).some(part => ['node_modules', '.git', 'data', '.runtime', 'test-results'].includes(part)) });
  }
  // Link third-party packages separately so the copied @yearbook workspaces resolve
  // to their copied Chinese/space path, and Vite caches cannot enter source node_modules.
  const modules = join(project, 'node_modules');
  await mkdir(modules);
  for (const entry of await readdir(join(root, 'node_modules'), { withFileTypes: true })) {
    if (entry.name === '@yearbook' || entry.name === '.vite' || entry.name === '.cache') continue;
    const source = join(root, 'node_modules', entry.name);
    const destination = join(modules, entry.name);
    if (entry.isDirectory() || entry.isSymbolicLink()) await dependencyLink(source, destination);
    else await copyFile(source, destination);
  }
  await mkdir(join(modules, '@yearbook'));
  for (const workspace of ['packages/shared', 'apps/server', 'apps/web']) {
    const packagePath = join(project, workspace);
    const packageInfo = JSON.parse(await readFile(join(packagePath, 'package.json'), 'utf8'));
    await dependencyLink(packagePath, join(modules, packageInfo.name));
  }
  for (const excluded of ['.git', 'data', '.runtime']) {
    await assert.rejects(access(join(project, excluded)), `${excluded}不能从源项目复制`);
  }
  return { copiedPaths: allowed, dependencyJunctions: dependencyLinks.length, sharedWorkspace: await realpath(join(modules, '@yearbook/shared')) };
}
async function buildIdentity() {
  const describe = async path => {
    const file = join(project, path); const [bytes, info] = await Promise.all([readFile(file), stat(file)]);
    return { path, size: bytes.length, sha256: sha(bytes), modifiedAt: info.mtime.toISOString() };
  };
  return { server: await describe('apps/server/dist/index.js'), frontend: await describe('apps/web/dist/index.html'), lockfile: await describe('package-lock.json'),
    scripts: await Promise.all(['scripts/runtime.mjs', 'scripts/launcher.mjs', 'scripts/dev.mjs', 'Start-Yearbook.cmd', 'Stop-Yearbook.cmd'].map(describe)) };
}
async function cleanWorkingDirectory() {
  const absolute = resolve(working);
  assert.ok(inside(tmpdir(), absolute) && absolute.includes('yearbook Windows 全路径 '));
  for (const link of dependencyLinks.reverse()) {
    assert.ok(inside(working, link.destination));
    const info = await lstat(link.destination);
    assert.ok(info.isSymbolicLink(), `拒绝递归清理已不是 junction 的依赖路径：${link.destination}`);
    assert.equal((await realpath(link.destination)).toLowerCase(), (await realpath(link.source)).toLowerCase());
    // No recursive operation ever runs on a dependency junction or its target.
    try { await unlink(link.destination); }
    catch (error) { if (!['EPERM', 'EISDIR'].includes(error.code)) throw error; await rmdir(link.destination); }
  }
  const checkNoLinks = async folder => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name); const info = await lstat(path);
      assert.ok(!info.isSymbolicLink(), `残留链接未确认，不递归删除：${path}`);
      if (info.isDirectory()) await checkNoLinks(path);
    }
  };
  await checkNoLinks(absolute);
  await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await assert.rejects(access(absolute));
}

try {
  await step('复制整个项目到独立中文空格路径', copyProject);
  npmCli = resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  await access(npmCli);
  // Follow the shipped npm.cmd/npm.ps1 selection: a globally upgraded npm under
  // npm-prefix.js takes precedence over the older CLI bundled beside node.exe.
  const prefixProgram = resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-prefix.js');
  const prefix = (await command('npm 安装前缀', [prefixProgram], environment('构建 资料'))).trim();
  const upgradedNpm = resolve(prefix, 'node_modules/npm/bin/npm-cli.js');
  try { await access(upgradedNpm); npmCli = upgradedNpm; } catch { /* Use the bundled CLI, as the npm shim does. */ }
  evidence.npm = (await command('npm 版本', [npmCli, '--version'], environment('构建 资料'))).trim();
  const revision = launch('git', ['rev-parse', 'HEAD'], environment('构建 资料'), { cwd: root });
  evidence.sourceCommit = (await finished(revision, '读取源码提交')).trim();
  if (evidence.sourceBuild) await step('仅在临时副本执行 npm run build', async () => {
    const output = await command('临时项目构建', [npmCli, 'run', 'build'], environment('构建 资料'), 120000);
    const lines = output.split(/\r?\n/);
    return { output: lines.filter(line => !/dist\/assets\/noto-/.test(line)).join('\n'), bundledFontAssets: lines.filter(line => /dist\/assets\/noto-/.test(line)).length };
  });
  evidence.build = await buildIdentity();
  const sentinelRequests = [];
  await step('占用测试端口，保留无关服务作为停止保护对照', async () => {
    do {
      sentinel = createServer((request, response) => {
        sentinelRequests.push(`${request.method} ${request.url}`);
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ app: 'yearbook-runtime-unrelated-sentinel', status: 'ok' }));
      });
      await new Promise((yes, no) => { sentinel.once('error', no); sentinel.listen(0, '127.0.0.1', yes); });
      blockedPort = sentinel.address().port;
      if (blockedPort > 65515 || blockedPort === 4317) await new Promise(yes => sentinel.close(yes));
    } while (blockedPort > 65515 || blockedPort === 4317);
    return { blockedPort };
  });
  const first = await startNpm('npm start 资料');
  let persisted;
  await step('npm start 同时提供前端与 API，冲突端口自动避让', async () => {
    assert.notEqual(Number(new URL(first.state.url).port), blockedPort);
    const frontend = await verifyFrontend(first.state.url);
    persisted = await json(first.state.url, '/api/records', 'POST', { title: 'Windows 验收', body: '临时项目在中文和空格路径里保存的记录。', occurredOn: '2020-02-29' });
    assert.equal((await json(first.state.url, `/api/records/${persisted.id}`)).body, persisted.body);
    return { url: first.state.url, pid: first.state.pid, dataDir: first.env.YEARBOOK_DATA_DIR, frontend, savedRecordId: persisted.id };
  });
  guard = await startNpm('另一个 自有服务');
  await step('缺少或错误令牌均不能停止服务，也不向无关应用发送停止请求', async () => {
    for (const headers of [{}, { authorization: 'Bearer definitely-not-the-owner' }]) {
      const response = await fetch(new URL('/api/system/shutdown', first.state.url), { method: 'POST', headers, signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 403); assert.equal((await response.json()).error.code, 'INSTANCE_TOKEN_REQUIRED');
    }
    await assert.rejects(stopService({ ...first.state, pid: first.state.pid + 1 }), /不属于本启动器/);
    await assert.rejects(stopService({ ...first.state, token: 'not-the-owner' }), /不属于本启动器/);
    assert.equal(await stopService({ url: `http://127.0.0.1:${blockedPort}`, pid: first.state.pid, token: first.state.token }), false);
    assert.ok(!sentinelRequests.some(request => request.startsWith('POST ')));
    await sentinelAlive();
    return { rejectedHttpStatuses: [403, 403], protectedSiblingPid: guard.state.pid, unrelatedShutdownRequests: 0 };
  });
  await step('认证停止只关闭所属 npm start，重启后记录仍存在', async () => {
    await stopOwned(first.state); await sentinelAlive();
    const reopened = await startNpm('npm start 资料');
    assert.equal((await json(reopened.state.url, `/api/records/${persisted.id}`)).body, persisted.body);
    await stopOwned(reopened.state); await sentinelAlive();
    return { stoppedPid: first.state.pid, reopenedPid: reopened.state.pid, retainedRecordId: persisted.id };
  });
  await step('npm run dev 的 Vite 界面和代理 API 可用，后端停止后前端也退出', async () => {
    const development = await startNpm('npm dev 资料', 'dev');
    const frontUrl = await until('Vite 就绪地址', () => {
      if (development.parent.closed) throw new Error(`开发进程提前退出：${development.parent.output}`);
      return stripAnsi(development.parent.output).match(/Local:\s+(http:\/\/127\.0\.0\.1:\d+\/)/)?.[1];
    });
    const frontend = await verifyFrontend(frontUrl, true);
    const throughProxy = await json(frontUrl, '/api/health');
    assert.equal(throughProxy.pid, development.state.pid);
    const saved = await json(frontUrl, '/api/records', 'POST', { body: '通过开发前端代理写入独立资料。' });
    assert.equal((await json(development.state.url, `/api/records/${saved.id}`)).body, saved.body);
    await stopOwned(development.state);
    await until('开发前端停止', async () => { try { await fetch(frontUrl, { signal: AbortSignal.timeout(500) }); return false; } catch { return true; } }, 5000);
    await sentinelAlive();
    return { backendUrl: development.state.url, frontendUrl: frontUrl, pid: development.state.pid, frontend, proxyRecordId: saved.id, frontendStopped: true };
  });
  const launcherEnv = environment('Windows 启动器 资料');
  const launcherFile = join(project, '.runtime/launcher.json');
  let launcherState;
  await step('launcher 重复启动复用同一进程，显示实际地址', async () => {
    const output = await command('启动器启动', ['scripts/launcher.mjs', 'start', '--no-browser'], launcherEnv);
    const stored = await readJson(launcherFile); assert.ok(stored?.token && stored?.pid);
    launcherState = await serviceReady(join(project, '.runtime/server.json'), stored.token, null, '启动器服务');
    const again = await command('重复启动器', ['scripts/launcher.mjs', 'start', '--no-browser'], launcherEnv);
    const repeated = await readJson(launcherFile);
    assert.equal(repeated.pid, stored.pid); assert.equal(repeated.instanceId, stored.instanceId);
    assert.match(again, /已经运行/); assert.ok(again.includes(stored.url));
    assert.equal(resolve((await json(stored.url, '/api/stats')).dataDir), resolve(launcherEnv.YEARBOOK_DATA_DIR));
    await sentinelAlive();
    return { url: stored.url, pid: stored.pid, reusedPid: repeated.pid, output, repeatedOutput: again };
  });
  await step('launcher stop 关闭自有服务，其他服务保持可读', async () => {
    const output = await command('停止启动器', ['scripts/launcher.mjs', 'stop'], launcherEnv);
    assert.equal(await health(launcherState.url), null); launcherState.stopped = true;
    assert.equal(await readJson(launcherFile), null); await sentinelAlive();
    return { output, stoppedPid: launcherState.pid };
  });
  await step('实际执行 Start-Yearbook.cmd 和 Stop-Yearbook.cmd（含 pause 输入）', async () => {
    const commandShell = process.env.ComSpec || 'cmd.exe';
    const started = launch(commandShell, ['/d', '/s', '/c', 'Start-Yearbook.cmd'], launcherEnv);
    const startOutput = await finished(started, 'Start-Yearbook.cmd');
    const stored = await readJson(launcherFile); assert.ok(stored?.token);
    const service = await serviceReady(join(project, '.runtime/server.json'), stored.token, null, 'CMD 启动的服务');
    assert.ok(startOutput.includes(service.url));
    const frontend = await verifyFrontend(service.url);
    await sentinelAlive();
    const stopped = launch(commandShell, ['/d', '/s', '/c', 'Stop-Yearbook.cmd'], launcherEnv, { input: '\r\n' });
    const stopOutput = await finished(stopped, 'Stop-Yearbook.cmd');
    assert.equal(await health(service.url), null); service.stopped = true;
    assert.equal(await readJson(launcherFile), null); await sentinelAlive();
    const repeat = launch(commandShell, ['/d', '/s', '/c', 'Stop-Yearbook.cmd'], launcherEnv, { input: '\r\n' });
    const repeatOutput = await finished(repeat, '重复 Stop-Yearbook.cmd');
    await sentinelAlive();
    return { startExitCode: started.result.code, stopExitCode: stopped.result.code, repeatedStopExitCode: repeat.result.code,
      url: service.url, pid: service.pid, startOutput, stopOutput, repeatedStopOutput: repeatOutput, frontend,
      browserOpening: 'Start-Yearbook.cmd 使用应用原有默认浏览器打开命令；页面视觉检查由主线浏览器验收负责' };
  });
  await step('停止最后一个自有对照服务，无关端口仍工作', async () => {
    await stopOwned(guard.state); await sentinelAlive();
    assert.ok(!sentinelRequests.some(request => request.startsWith('POST ')));
    return { stoppedPid: guard.state.pid, unrelatedPortStillAlive: true, unrelatedShutdownRequests: 0 };
  });
  evidence.passed = true;
} catch (error) {
  evidence.error = error.stack || error.message;
  process.stderr.write(`${evidence.error}\n`);
  process.exitCode = 1;
} finally {
  for (const service of [...ownedServices].reverse()) {
    if (service.stopped) continue;
    try { await stopService(service); service.stopped = true; }
    catch (error) { evidence.warnings.push(`自有服务收尾失败：${error.message}`); process.exitCode = 1; }
  }
  for (const state of ownedChildren) if (!state.closed) state.child.kill();
  for (const state of ownedChildren) {
    if (state.closed) continue;
    const deadline = Date.now() + 3000;
    while (!state.closed && Date.now() < deadline) await delay(50);
  }
  if (sentinel?.listening) { sentinel.closeAllConnections(); await new Promise(yes => sentinel.close(yes)); }
  evidence.cleanup.ownedServicesStopped = ownedServices.every(service => service.stopped);
  evidence.cleanup.spawnedProcessesClosed = [...ownedChildren].every(state => state.closed);
  try { await cleanWorkingDirectory(); evidence.cleanup.temporaryProjectRemoved = true; }
  catch (error) { evidence.cleanup.temporaryProjectRemoved = false; evidence.warnings.push(error.message); process.exitCode = 1; }
  evidence.passed &&= !process.exitCode && evidence.cleanup.ownedServicesStopped && evidence.cleanup.spawnedProcessesClosed && evidence.cleanup.temporaryProjectRemoved;
  evidence.finishedAt = new Date().toISOString();
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
  say(`${evidence.passed ? '通过' : '未通过'}；证据：${evidencePath}`);
}
