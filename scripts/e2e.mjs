import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import sharp from 'sharp';
import { root, checkNode, hash, waitForService, stopService } from './runtime.mjs';
import { initialise, flows } from './e2e-flows.mjs';
import { finalFlows } from './e2e-final-flows.mjs';
import { appearanceFlows } from './e2e-appearance-flows.mjs';

checkNode();
const serverEntry = resolve(root, 'apps/server/dist/index.js');
const webDist = resolve(root, 'apps/web/dist');
const launcher = process.platform === 'win32'
  ? resolve(process.env.LOCALAPPDATA ?? '', 'Tabbit', 'LocalAgent', 'bin', 'tabbit-cli.exe')
  : resolve(process.env.HOME ?? '', '.local', 'bin', 'tabbit-cli');
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
const taskName = `yearbook-final-${process.pid}-${Date.now()}`;
const evidence = resolve(root, 'test-results', runId);
const working = await mkdtemp(join(tmpdir(), 'yearbook 浏览器验收 '));
const dataDir = join(working, '中文 空格 资料');
const token = randomBytes(32).toString('hex');
const runtimeFile = join(working, 'runtime.json');
const ownedChildren = new Set();
const receipts = [];
const screenshotWarnings = [];
const screenshots = [];
let service;
let serviceChild;
let browserStarted = false;
let success = false;
let mockUrl;

function childProcess(args, env = {}) {
  const child = spawn(process.execPath, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  ownedChildren.add(child);
  let output = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-12000); });
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-12000); });
  child.once('error', error => { output += error.message; });
  return { child, output: () => output };
}
async function freePort() {
  const server = createServer();
  await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
  const port = server.address().port;
  await new Promise((yes, no) => server.close(error => error ? no(error) : yes()));
  return port < 65515 ? port : freePort();
}
async function startService(port) {
  const launched = childProcess([serverEntry], { NODE_ENV: 'production', YEARBOOK_DATA_DIR: dataDir, YEARBOOK_WEB_DIST: webDist, YEARBOOK_PORT: String(port), YEARBOOK_INSTANCE_TOKEN: token, YEARBOOK_RUNTIME_FILE: runtimeFile });
  serviceChild = launched.child;
  try { service = await waitForService(runtimeFile, hash(token), serviceChild); }
  catch (error) { throw new Error(`${error.message}\n${launched.output()}`); }
}
async function stopOwnedService() {
  if (!service) return;
  await stopService({ ...service, token });
  const deadline = Date.now() + 5000;
  while (serviceChild.exitCode === null && serviceChild.signalCode === null && Date.now() < deadline) await new Promise(yes => setTimeout(yes, 50));
  assert.ok(serviceChild.exitCode !== null || serviceChild.signalCode !== null, '应用停止后进程应正常退出');
  service = null;
}
function receiptFrom(stdout) {
  return stdout.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }).at(-1);
}
async function command(args, input = '') {
  return new Promise((yes, no) => {
    const child = spawn(launcher, args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.once('error', no);
    child.once('close', code => yes({ code, receipt: receiptFrom(stdout), stdout, stderr }));
    child.stdin.end(input, 'utf8');
  });
}
async function step(name, code, readOnly = false) {
  process.stdout.write(`[E2E] ${name}\n`);
  browserStarted = true;
  const result = await command(['nodejs', '--task', taskName, '--request-id', name, '--timeout-ms', '60000', ...(readOnly ? ['--read-only'] : [])], code);
  const saved = { name, ...result };
  receipts.push(saved);
  await writeFile(join(evidence, `${name}.json`), JSON.stringify(saved, null, 2));
  if (result.code || result.receipt?.status !== 'succeeded') {
    const error = new Error(`浏览器步骤 ${name} 失败：${result.stdout}\n${result.stderr}`);
    error.receipt = result.receipt;
    throw error;
  }
  const value = result.receipt.result?.value;
  const screenshot = result.receipt.result?.nextAction ?? value?.nextAction;
  if (screenshot?.path) {
    await copyFile(screenshot.path, join(evidence, `${name}.png`));
    process.stdout.write(`[截图] ${screenshot.path}\n`);
  }
  return value;
}
async function capture(name, target = 'page') {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const before = await step(`${name}-before-${attempt}`, `return {url:${target}.url(),viewport:${target}.viewportSize(),layout:await ${target}.evaluate(() => ({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,dpr:devicePixelRatio}))};`, true);
    try {
      const shot = await step(`${name}-${attempt}`, `return await ${target}.screenshot({fullPage:true,timeout:25000,scale:'css',style:'html { scrollbar-gutter: stable !important; }'});`, true);
      const after = await step(`${name}-after-${attempt}`, `return {viewport:${target}.viewportSize(),layout:await ${target}.evaluate(() => ({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,dpr:devicePixelRatio}))};`, true);
      screenshots.push({ name, attempt, capturedFullPage: shot?.capturedFullPage === true, width: shot?.width, height: shot?.height, before, after });
      if (shot?.capturedFullPage === true) return shot;
      screenshotWarnings.push({ name, attempt, message: 'Tabbit 退回视口截图；此图不作为完整页面证据。' });
      process.stdout.write(`[截图限制] ${name} 退回视口图，单独记录视觉限制。\n`);
      return shot;
    }
    catch (error) {
      if (error.receipt?.status !== 'failed' || !error.receipt?.result?.error?.includes('screenshot')) throw error;
      screenshotWarnings.push({ name, attempt, message: error.message });
      process.stdout.write(`[截图重试] ${name} 第 ${attempt} 次未完成，业务流程结果保留。\n`);
    }
    // Inspect the same owned page before a pure screenshot retry; never replay business mutations.
    await step(`${name}-inspect-${attempt}`, `return {url:${target}.url(),title:await ${target}.title(),layout:await ${target}.evaluate(() => ({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,dpr:devicePixelRatio}))};`, true);
  }
  // Browser assertions and business mutations continue; the final report separates screenshot coverage.
  return null;
}
async function json(path) {
  const response = await fetch(new URL(path, service.url));
  assert.ok(response.ok, `${path}: HTTP ${response.status}`);
  return response.json();
}

try {
  for (const [path, name] of [[serverEntry, '生产服务'], [join(webDist, 'index.html'), '前端构建'], [launcher, 'Tabbit 浏览器入口']]) {
    try { await access(path, constants.R_OK); } catch { throw new Error(`${name}不可用：${path}。请先安装依赖并运行 npm run build。`); }
  }
  await mkdir(evidence, { recursive: true });
  const mock = childProcess(['--import', 'tsx', resolve(root, 'tests/mock-model.ts')]);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !mockUrl) {
    for (const line of mock.output().split(/\r?\n/)) { try { const value = JSON.parse(line); if (value.url) mockUrl = value.url; } catch { /* startup output */ } }
    if (!mockUrl) await new Promise(yes => setTimeout(yes, 75));
  }
  assert.ok(mockUrl, `本机模拟模型未启动：${mock.output()}`);
  const port = await freePort();
  await startService(port);
  const landscape = join(working, '横向 测试.jpg');
  const portrait = join(working, '竖向 测试.jpg');
  const letterPhoto = join(working, '只在信中的 照片.jpg');
  await sharp({ create: { width: 900, height: 600, channels: 3, background: '#b6c9bc' } }).jpeg().toFile(landscape);
  await sharp({ create: { width: 600, height: 900, channels: 3, background: '#ceb697' } }).jpeg().toFile(portrait);
  await sharp({ create: { width: 800, height: 600, channels: 3, background: '#9cad92' } }).jpeg().toFile(letterPhoto);
  await step('01-records-and-photos', initialise({ base: service.url, mockUrl, landscape, portrait, letterPhoto }));
  await step('01-letters-create-seal', finalFlows.lettersCreate);
  await stopOwnedService();
  await startService(port);
  await step('02-restart-search-restore', `globalThis.Y.base = ${JSON.stringify(service.url)};\n${flows.restart}`);
  await step('02-letters-due-after-restart', finalFlows.lettersAfterRestart);
  await capture('02-letters-narrow');
  await step('02-desktop-width', `await page.setViewportSize({width:1440,height:1000}); return {width:1440};`);
  await step('02-appearance-persistence', appearanceFlows.appearance);
  await step('02-appearance-modes', appearanceFlows.appearanceModes);
  await step('03-manual-yearbook', flows.yearbook);
  await step('03-reader-controls', appearanceFlows.reader);
  await step('03-photo-keyboard', appearanceFlows.photoKeyboard);
  const exported = await step('04-html-export', flows.exportHtml);
  const download = await fetch(new URL(exported.href, service.url));
  assert.ok(download.ok, '离线 HTML ZIP 下载失败');
  const buffer = Buffer.from(await download.arrayBuffer());
  const zip = new AdmZip(buffer);
  const html = zip.readAsText('index.html');
  assert.ok(html.includes('手动编册，留下六月这一天。'), '导出必须包含当前保存的年册正文');
  const offline = join(evidence, 'offline-yearbook');
  await mkdir(offline, { recursive: true });
  await writeFile(join(evidence, 'manual-yearbook.zip'), buffer);
  await writeFile(join(offline, 'index.html'), html);
  await step('05-offline-html-open', `globalThis.Y.offlineUrl = ${JSON.stringify(pathToFileURL(join(offline, 'index.html')).href)};\n${flows.offline}`);
  await capture('05-offline-screenshot', 'Y.offlinePage');
  await step('05-offline-cleanup', `await Y.offlinePage.close(); delete Y.offlinePage; return {closedScratchPage:true};`);
  const pdfExport = await step('05-pdf-export', finalFlows.exportPdf);
  const pdfResponse = await fetch(new URL(pdfExport.href, service.url));
  assert.ok(pdfResponse.ok, 'PDF 下载失败');
  const pdfBytes = Buffer.from(await pdfResponse.arrayBuffer());
  assert.equal(pdfBytes.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdfBytes.subarray(-200).toString().includes('%%EOF'), 'PDF 必须完整结束');
  await writeFile(join(evidence, 'manual-yearbook.pdf'), pdfBytes);
  await writeFile(join(evidence, 'pdf-export.json'), JSON.stringify(pdfExport.result, null, 2));
  await step('05-yearbook-ordering-and-template', finalFlows.ordering);
  for (const [name, code] of [
    ['06-model-responses', flows.responses], ['07-model-chat', flows.chat],
    ['08-models-desktop', null],
    ['09-record-ai', flows.recordAi], ['10-questions', flows.questions], ['11-monthly-create-edit', flows.monthly],
    ['12-monthly-narrow', flows.narrow], ['13-regenerate-and-adopt', flows.regenerate], ['14-agent-with-tools', flows.agent],
    ['15-yearbook-batched', flows.annual], ['16-capability-fallback', flows.fallback], ['17-task-cancel', flows.cancel],
    ['18-task-retry', flows.retry], ['19-backup-and-restore', flows.backup],
  ]) {
    if (name === '08-models-desktop') await capture(name);
    else { await step(name, code); if (name === '12-monthly-narrow') await capture('12-monthly-screenshot'); }
  }
  const state = await step('20-final-persistence', flows.final);
  const letterState = await step('20-letters-backup-restored', finalFlows.lettersRestored);
  await stopOwnedService();
  await startService(port);
  const [records, drafts, books, letters] = await Promise.all([json('/api/records?limit=500'), json('/api/ai/drafts?limit=100'), json('/api/yearbooks'), json('/api/letters')]);
  assert.equal(records.total, 2); assert.ok(drafts.total >= 7); assert.ok(books.total >= 1);
  assert.equal(records.items.find(record => record.id === state.recordId).media.length, 2);
  assert.equal(letters.total, 2);
  assert.equal((await json('/api/letters/' + letterState.futureLetterId)).status, 'sealed');
  assert.equal((await json('/api/letters/' + letterState.dueLetterId)).status, 'read');
  assert.ok((await readFile(join(evidence, 'manual-yearbook.zip'))).length > 1000);
  await writeFile(join(evidence, 'summary.json'), JSON.stringify({ passed: true, at: new Date().toISOString(), steps: receipts.filter(item => item.receipt?.status === 'succeeded').map(item => item.name), screenshots, fullPageScreenshotsComplete: ['02-letters-narrow','05-offline-screenshot','08-models-desktop','12-monthly-screenshot'].every(name => screenshots.some(shot => shot.name === name && shot.capturedFullPage)), screenshotWarnings, records: records.total, aiDrafts: drafts.total, yearbooks: books.total, letters: letters.total, pdfBytes: pdfBytes.length, modelService: '本机确定性模拟；不代表真实模型验证', ...state, ...letterState }, null, 2));
  success = true;
  process.stdout.write(`E2E 通过：隔离资料、照片与重启、未来信封存/到期/恢复、手工年册、离线 HTML 与 PDF、双协议、AI 草稿保护、Agent、降级、取消重试、备份恢复。\n截图失败或重试记录：${screenshotWarnings.length} 项；详见回执。\n验收证据：${evidence}\n`);
} catch (error) {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
  if (browserStarted) await step('failure-inspection', `const book = globalThis.Y?.bookId && globalThis.read ? await read('/api/yearbooks/' + Y.bookId).catch(() => null) : null; return {url:page.url(),tree:JSON.stringify(await page.ariaSnapshot({mode:'ai',depth:12})).slice(0,9000),book:book && {id:book.id,template:book.template,chapters:book.chapters.map(chapter => ({id:chapter.id,title:chapter.title,body:chapter.body.slice(0,200),sourceRecordIds:chapter.sourceRecordIds,blocks:chapter.blocks.map(block => ({id:block.id,type:block.type,mediaId:block.mediaId,recordId:block.recordId,caption:block.caption}))}))}};`, true).catch(() => undefined);
} finally {
  if (browserStarted) {
    const result = await command(['finish', '--task', taskName]);
    if (result.code) { process.stderr.write(`Tabbit finish：${result.stderr || result.stdout}\n`); process.exitCode = 1; }
  }
  await stopOwnedService().catch(error => { process.stderr.write(`服务收尾：${error.message}\n`); process.exitCode = 1; });
  for (const child of ownedChildren) if (child.exitCode === null && child.signalCode === null) child.kill();
  const absolute = resolve(working);
  if (absolute.startsWith(resolve(tmpdir()) + sep) && absolute.includes('yearbook 浏览器验收 ')) await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (!success) process.stderr.write(`已保留失败回执：${evidence}\n`);
}
