// Programs use the user's Tabbit-owned Playwright. Mutations go through visible controls.
export function initialise(data) { return String.raw`
globalThis.Y = ${JSON.stringify(data)};
Y.originalTitle = '六月和妈妈去河边';
Y.originalBody = '和妈妈沿着河边慢慢走。妈妈说：“晚饭回家吃面吧。”我拍了河面和路边的树。';
Y.manualBody = '手动编册，留下六月这一天。' + '记得那天的河水很安静，照片和原话都留在这一页。'.repeat(18);
globalThis.go = async path => { await page.goto(new URL(path, Y.base).href, {waitUntil:'domcontentloaded'}); };
globalThis.read = async path => { const res = await context.request.get(new URL(path, Y.base).href); assert.ok(res.ok(), path + ': ' + res.status()); return res.json(); };
globalThis.completeDraft = async (title = '本机模拟整理') => {
  await page.waitForURL(/\/tasks\?task=/);
  Y.lastTaskId = new URL(page.url()).searchParams.get('task');
  const card = page.locator('.ai-task-card.highlighted');
  await expect(card.getByRole('link', {name:'查看草稿'})).toBeVisible({timeout:25000});
  await card.getByRole('button', {name:'查看阶段与用量'}).click();
  await expect(card.locator('.ai-task-details')).toBeVisible();
  await card.getByRole('link', {name:'查看草稿'}).click();
  await page.waitForURL(/\/ai\/drafts\/[a-f0-9-]+$/);
  await expect(page.getByLabel('草稿标题')).toHaveValue(title);
  return page.url().split('/').at(-1);
};
globalThis.newModel = async (name, protocol, model, stream = false, timeout = 10) => {
  await go('/settings');
  await page.getByRole('button', {name:'添加模型配置'}).click();
  await page.getByLabel('配置名称').fill(name);
  await page.getByLabel('API 协议').selectOption(protocol);
  await page.getByLabel('Base URL').fill(Y.mockUrl + (protocol === 'responses' ? '/responses' : '/chat/completions'));
  await expect(page.locator('.endpoint-preview code')).toHaveText(Y.mockUrl + (protocol === 'responses' ? '/responses' : '/chat/completions'));
  await page.getByLabel('模型名称').fill(model);
  await page.getByLabel('请求超时（秒）').fill(String(timeout));
  await page.getByLabel('密钥保存方式').selectOption('none');
  if (stream) await page.getByLabel(/启用流式输出/).check();
  await page.getByRole('button', {name:'保存模型配置'}).click();
  await expect(page.getByRole('status').filter({hasText:'配置已保存'})).toBeVisible();
  await expect(page.getByRole('heading',{name:name + ' · 能力验证',exact:true})).toBeVisible();
  return (await read('/api/model-profiles')).items.find(item => item.name === name).id;
};
globalThis.probe = async name => {
  await page.getByRole('button', {name:'验证' + name,exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:name + '验证通过'})).toBeVisible({timeout:15000});
};
page.setDefaultTimeout(15000);
await page.emulateMedia({colorScheme:'light'});
await page.setViewportSize({width:1440,height:1000});
await go('/');
await expect(page.getByRole('heading', {name:'今天，想留住什么？'})).toBeVisible();
await page.getByRole('link', {name:/记一笔/}).first().click();
await page.getByLabel(/标题/).fill(Y.originalTitle);
await page.getByLabel('正文').fill(Y.originalBody);
await page.getByLabel('事情发生的日期').fill('2024-06-18');
await page.getByLabel('一起的人').fill('妈妈');
await page.getByLabel('地点').fill('河边');
await page.getByLabel('标签').fill('家人，散步');
await page.getByLabel('添加照片').setInputFiles([Y.landscape,Y.portrait]);
await expect(page.getByRole('status').filter({hasText:'已导入 2 张照片'})).toBeVisible();
await page.getByLabel('照片说明').nth(0).fill('河面，横向照片');
await page.getByLabel('照片说明').nth(1).fill('路边的树，竖向照片');
await page.getByRole('button', {name:'保存记录',exact:true}).click();
await page.waitForURL(/\/records\/[a-f0-9-]+$/);
Y.recordId = page.url().split('/').at(-1);
await expect(page.getByRole('heading', {name:Y.originalTitle,exact:true})).toBeVisible();
const saved = await read('/api/records/' + Y.recordId);
assert.equal(saved.media.length,2); assert.equal(saved.occurredOn,'2024-06-18');
Y.mediaIds = saved.media.map(photo => photo.id);
await go('/records/new');
await page.getByLabel(/标题/).fill('七月第一次烤面包');
await page.getByLabel('正文').fill('第一次自己烤面包，和家人一起吃。外皮比预想的硬，下次少烤一会儿。');
await page.getByLabel('事情发生的日期').fill('2024-07-09');
await page.getByLabel('一起的人').fill('家人');
await page.getByLabel(/这是生活中的第一次/).check();
await page.getByRole('button', {name:'保存记录',exact:true}).click();
await page.waitForURL(/\/records\/[a-f0-9-]+$/);
Y.firstId = page.url().split('/').at(-1);
await expect(page.getByRole('heading', {name:'七月第一次烤面包'})).toBeVisible();
assert.equal((await read('/api/model-profiles')).items.length,0);
return {recordId:Y.recordId,firstId:Y.firstId,photoCount:2,noModelConfigured:true};
`; }

export const flows = {
restart: String.raw`
await go('/records');
await page.getByRole('textbox', {name:'搜索记录'}).fill('妈妈');
await page.getByRole('button', {name:'搜索',exact:true}).click();
await expect(page.getByRole('link', {name:Y.originalTitle,exact:true})).toBeVisible();
await page.getByRole('link', {name:Y.originalTitle,exact:true}).click();
await expect(page.getByText(Y.originalBody,{exact:true})).toBeVisible();
await expect(page.locator('main img[src*="/api/media/"]')).toHaveCount(2);
await page.waitForFunction(() => [...document.querySelectorAll('main img[src*="/api/media/"]')].every(img => img.complete && img.naturalWidth > 0));
await page.getByRole('button', {name:'移入回收站',exact:true}).click();
await expect(page.getByRole('status').filter({hasText:'已移入回收站'})).toBeVisible();
await page.getByRole('link', {name:'回收站',exact:true}).click();
await page.getByRole('button', {name:'恢复记录',exact:true}).click();
await expect(page.getByRole('status').filter({hasText:'记录已恢复'})).toBeVisible();
assert.equal((await read('/api/records/' + Y.recordId)).media.length,2);
return {restart:true,search:true,deletedAndRestored:true,imagesLoaded:true};
`,
yearbook: String.raw`
await go('/yearbooks');
await page.getByRole('link', {name:'新建年册',exact:true}).click();
await expect(page.getByRole('heading', {name:'新建年册',exact:true})).toBeVisible();
await page.getByRole('spinbutton', {name:'年份',exact:true}).fill('2024');
await page.getByLabel('年册标题').fill('我们的 2024 · 手工年册');
await page.getByLabel('年度开篇').fill('这是完全手动写下的年度开篇，需要一直保留。');
await expect(page.getByLabel('封面照片').locator('option')).toHaveCount(3);
await page.getByLabel('封面照片').selectOption(Y.mediaIds[0]);
while (await page.locator('.chapter-editor').count() > 1) {
  page.once('dialog',dialog => dialog.accept());
  await page.locator('.chapter-editor').last().getByRole('button',{name:'删除章节',exact:true}).click();
}
const chapter = page.locator('.chapter-editor').first();
await chapter.getByLabel('第 1 章类型').selectOption('custom');
await chapter.getByLabel('第 1 章标题').fill('六月 · 和妈妈散步');
await chapter.getByLabel('章节正文').fill(Y.manualBody);
await chapter.getByRole('checkbox', {name:new RegExp(Y.originalTitle)}).check();
for (let i=0;i<2;i++) {
  await chapter.getByRole('button', {name:'照片',exact:true}).click();
  await chapter.getByLabel('选择照片').nth(i).selectOption(Y.mediaIds[i]);
  await chapter.getByLabel('照片说明').nth(i).fill(i ? '竖向照片保留比例' : '横向照片保留比例');
}
await chapter.getByRole('button', {name:'记录卡片',exact:true}).click();
await chapter.getByLabel('关联记录').selectOption(Y.recordId);
await page.getByRole('button', {name:'保存年册',exact:true}).click();
await page.waitForURL(/\/yearbooks\/[a-f0-9-]+\/edit$/);
Y.bookId = page.url().split('/').at(-2);
await expect(page.getByLabel('年册标题')).toHaveValue('我们的 2024 · 手工年册');
await page.getByRole('link', {name:'预览',exact:true}).click();
await expect(page.locator('.preview-body')).toHaveText(Y.manualBody);
await expect(page.locator('.yearbook-preview img')).toHaveCount(4);
await page.waitForFunction(() => [...document.querySelectorAll('.yearbook-preview img')].every(img => img.complete && img.naturalWidth > 0));
assert.equal((await read('/api/yearbooks/' + Y.bookId)).chapters.length,1);
return {yearbookId:Y.bookId,manual:true,preview:true};
`,
exportHtml: String.raw`
await page.getByRole('button', {name:'离线 HTML',exact:true}).click();
await expect(page.getByRole('status').filter({hasText:'导出文件已下载'})).toBeVisible({timeout:25000});
const task = (await read('/api/tasks?limit=100')).items.find(item => item.yearbookId === Y.bookId && item.kind === 'yearbook-html');
assert.equal(task.status,'completed');
return {href:'/api/yearbooks/' + Y.bookId + '/export/html?taskId=' + task.id};
`,
offline: String.raw`
const offline = await context.newPage();
Y.offlinePage = offline;
try {
  await context.setOffline(true);
  await offline.goto(Y.offlineUrl,{waitUntil:'load'});
  await expect(offline.getByRole('heading',{name:'我们的 2024 · 手工年册',exact:true})).toBeVisible();
  await expect(offline.locator('.chapter-body')).toHaveText(Y.manualBody);
  await expect(offline.locator('img')).toHaveCount(3);
  const sizes = await offline.locator('figure img').evaluateAll(items => items.map(img => ({natural:[img.naturalWidth,img.naturalHeight],shown:[img.width,img.height],complete:img.complete})));
  assert.ok(sizes.every(photo => photo.complete && photo.natural[0] > 0));
  assert.ok(sizes.some(photo => photo.natural[0] > photo.natural[1]));
  assert.ok(sizes.some(photo => photo.natural[0] < photo.natural[1]));
  assert.ok(sizes.every(photo => Math.abs(photo.shown[0]/photo.shown[1] - photo.natural[0]/photo.natural[1]) < .02));
  await offline.locator('.chapter').scrollIntoViewIfNeeded();
  return {offlineHtmlReadable:true,chineseBody:true,photosLoaded:true,orientations:sizes};
} finally { await context.setOffline(false); }
`,
responses: String.raw`
Y.responsesId = await newModel('E2E Responses','responses','mock-all',true);
for (const name of ['文本生成','图片理解','工具调用','流式输出']) await probe(name);
const saved = (await read('/api/model-profiles')).items.find(item => item.id === Y.responsesId);
assert.equal(saved.endpointUrl,Y.mockUrl + '/responses');
assert.ok(Object.values(saved.capabilities).every(value => value.status === 'supported'));
assert.equal(saved.keyPresent,false);
await page.getByRole('button',{name:'编辑模型配置 E2E Responses',exact:true}).click();
await page.getByRole('button',{name:'获取已保存配置的模型列表',exact:true}).click();
await expect(page.getByRole('status').filter({hasText:'已获取模型列表'})).toBeVisible();
await expect(page.locator('#yearbook-model-names option')).toHaveCount(10);
await page.getByRole('button',{name:'取消编辑',exact:true}).click();
return {responses:true,capabilities:['text','vision','tools','streaming'],modelList:true};
`,
chat: String.raw`
Y.chatId = await newModel('E2E Chat','chat-completions','mock-all',true);
for (const name of ['文本生成','图片理解','工具调用','流式输出']) await probe(name);
await page.locator('.model-profile-list li').filter({hasText:'E2E Chat'}).getByRole('button',{name:'启用',exact:true}).click();
await expect(page.getByRole('status').filter({hasText:'已切换到“E2E Chat”'})).toBeVisible();
assert.equal((await read('/api/model-profiles')).activeId,Y.chatId);
assert.ok(Object.values((await read('/api/model-profiles')).items.find(item => item.id === Y.chatId).capabilities).every(value => value.status === 'supported'));
await page.locator('.model-settings').evaluate(el => el.scrollIntoView({block:'start'}));
return {chatCompletions:true,switched:true,styles:await page.evaluate(() => ({width:innerWidth,ratio:devicePixelRatio,rootBackground:getComputedStyle(document.documentElement).backgroundColor,rootColor:getComputedStyle(document.documentElement).color,rootScheme:getComputedStyle(document.documentElement).colorScheme,darkreader:document.documentElement.getAttribute('data-darkreader-scheme'),injectedStyles:[...document.querySelectorAll('style')].map(el=>el.id || el.className).filter(Boolean).slice(0,12)}))};
`,
recordAi: String.raw`
await go('/records/' + Y.recordId);
await page.getByRole('link',{name:'建议标题',exact:true}).click();
await page.getByLabel('模型配置').selectOption(Y.responsesId);
await page.getByRole('button',{name:'生成独立草稿',exact:true}).click();
Y.titleDraftId = await completeDraft();
assert.equal((await read('/api/records/' + Y.recordId)).title,Y.originalTitle);
await page.locator('.ai-source-archive summary').first().click();
await expect(page.locator('.ai-source-archive').getByText(Y.originalBody,{exact:true})).toBeVisible();
await page.getByRole('button',{name:'放入记录编辑页',exact:true}).click();
await page.waitForURL(/\/records\/.*\/edit\?aiDraft=/);
await expect(page.getByLabel(/标题/)).toHaveValue('本机模拟整理');
assert.equal((await read('/api/records/' + Y.recordId)).title,Y.originalTitle);
await page.getByRole('button',{name:'保存记录',exact:true}).click();
await page.waitForURL(/\/records\/[a-f0-9-]+$/);
await expect(page.getByRole('heading',{name:'本机模拟整理',exact:true})).toBeVisible();
assert.equal((await read('/api/records/' + Y.recordId)).body,Y.originalBody);
return {titleProposal:true,explicitSave:true,sourceSnapshot:true};
`,
questions: String.raw`
await page.getByRole('link',{name:'补充问题',exact:true}).click();
await page.getByRole('button',{name:'生成补充问题',exact:true}).click();
await completeDraft();
await expect(page.locator('.ai-question')).toHaveCount(2);
await expect(page.getByRole('link',{name:'打开原记录',exact:true})).toBeVisible();
return {optionalQuestions:2};
`,
monthly: String.raw`
await go('/reports');
await page.getByLabel('翻到哪一月').fill('2024-06');
await expect(page.getByText('这个月有 1 条生活记录。',{exact:true})).toBeVisible();
await page.getByRole('link',{name:'整理这一月',exact:true}).click();
await page.getByLabel('模型配置').selectOption(Y.responsesId);
await page.getByRole('button',{name:'生成独立草稿',exact:true}).click();
Y.monthlyId = await completeDraft();
await expect(page.getByRole('heading',{name:'值得记住的事',exact:true})).toBeVisible();
await expect(page.getByRole('heading',{name:'照片里的日子',exact:true})).toBeVisible();
await expect(page.locator('.ai-photo-grid img')).toHaveCount(2);
assert.equal(JSON.stringify((await read('/api/ai/drafts/' + Y.monthlyId)).sourceRecordIds),JSON.stringify([Y.recordId]));
await page.getByLabel('草稿标题').fill('六月小报 · 手动留字');
Y.monthlyBody = '手动保留的月末回顾。妈妈说：“晚饭回家吃面吧。”';
await page.getByLabel('段落 1').fill(Y.monthlyBody);
await page.getByRole('button',{name:'保存草稿修改',exact:true}).click();
await expect(page.getByRole('status').filter({hasText:'草稿已保存'})).toBeVisible();
await page.getByRole('button',{name:'查看历史版本',exact:true}).click();
await expect(page.locator('.ai-version')).toHaveCount(2);
return {monthlyDraft:Y.monthlyId,photos:2,manualVersions:2};
`,
narrow: String.raw`
await page.setViewportSize({width:430,height:932});
await page.getByLabel('草稿标题').scrollIntoViewIfNeeded();
assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),'窄窗口不应横向溢出');
return {narrowWindow:430,noHorizontalOverflow:true};
`,
regenerate: String.raw`
await page.setViewportSize({width:1440,height:1000});
await page.getByRole('button',{name:'重新生成新版本',exact:true}).click();
Y.regeneratedId = await completeDraft();
assert.notEqual(Y.regeneratedId,Y.monthlyId);
await go('/ai/drafts/' + Y.monthlyId);
await expect(page.getByLabel('草稿标题')).toHaveValue('六月小报 · 手动留字');
await expect(page.getByLabel('段落 1')).toHaveValue(Y.monthlyBody);
await page.getByLabel('采用到').selectOption(Y.bookId);
await page.getByRole('button',{name:'采用为年册章节',exact:true}).click();
await page.waitForURL(/\/yearbooks\/.*\/edit$/);
await expect(page.locator('.chapter-editor').first().getByLabel('章节正文')).toHaveValue(Y.manualBody);
const book = await read('/api/yearbooks/' + Y.bookId);
assert.ok(JSON.stringify(book).includes(Y.monthlyBody)); assert.equal(book.chapters.length,2);
return {newDraftPreservedOld:true,appendedChapter:true,manualYearbookPreserved:true};
`,
agent: String.raw`
await page.getByRole('link',{name:'用一句话整理章节',exact:true}).click();
await page.getByLabel('模型配置').selectOption(Y.chatId);
await page.getByRole('button',{name:'清空选择',exact:true}).click();
await page.locator('.ai-source-choice').filter({hasText:'七月第一次烤面包'}).getByRole('checkbox').check();
await page.getByLabel(/补充整理要求/).fill('把今年与家人有关的记录整理成一个章节，文字朴素一点，多保留原话。');
await page.getByRole('button',{name:'生成独立草稿',exact:true}).click();
Y.agentId = await completeDraft();
const draft = await read('/api/ai/drafts/' + Y.agentId);
const detail = await read('/api/ai/tasks/' + Y.lastTaskId);
assert.equal(draft.mode,'tools'); assert.equal(JSON.stringify(draft.sourceRecordIds),JSON.stringify([Y.firstId]));
assert.ok(detail.task.toolCalls >= 3); assert.ok(detail.usage.totalTokens > 0);
assert.ok(!JSON.stringify(draft.content).includes(Y.originalBody));
return {agent:true,mode:draft.mode,toolCalls:detail.task.toolCalls,selectedSourceOnly:true};
`,
annual: String.raw`
await go('/yearbooks/' + Y.bookId + '/edit');
await page.getByRole('link',{name:'生成全年 AI 草稿',exact:true}).click();
await page.getByLabel('模型配置').selectOption(Y.responsesId);
await page.getByRole('button',{name:'生成独立草稿',exact:true}).click();
Y.annualId = await completeDraft('2024 · 一年一册');
const detail = await read('/api/ai/tasks/' + Y.lastTaskId);
assert.ok(detail.stages.length >= 3,'按月份保存阶段再汇总');
const draft = await read('/api/ai/drafts/' + Y.annualId);
assert.ok(draft.content.chapters.some(chapter => chapter.kind === 'firsts'));
await page.getByLabel('采用到').selectOption(Y.bookId);
await page.getByRole('button',{name:'采用整册草稿',exact:true}).click();
await page.waitForURL(/\/yearbooks\/.*\/edit$/);
const versions = await read('/api/yearbooks/' + Y.bookId + '/versions');
let preserved;
for (const version of versions) {
  const full = await read('/api/yearbooks/' + Y.bookId + '/versions/' + version.id);
  if (JSON.stringify(full.snapshot).includes(Y.manualBody) && JSON.stringify(full.snapshot).includes(Y.monthlyBody)) { preserved = version; break; }
}
assert.ok(preserved,'采用整册前的手动内容必须保留在版本中');
await page.locator('.version-list li').filter({hasText:'第 ' + preserved.versionNo + ' 个版本 ·'}).getByRole('button',{name:'采用此版本',exact:true}).click();
await expect(page.getByRole('status').filter({hasText:'已采用第 ' + preserved.versionNo + ' 个版本'})).toBeVisible();
await expect(page.locator('.chapter-editor').first().getByLabel('章节正文')).toHaveValue(Y.manualBody);
return {batchedYearbook:true,stages:detail.stages.length,adoptionSnapshotRestored:true};
`,
fallback: String.raw`
Y.textOnlyId = await newModel('E2E 仅文字','responses','no-tools',false);
await probe('文本生成');
await page.getByRole('button',{name:'验证工具调用',exact:true}).click();
await expect(page.getByRole('alert').filter({hasText:'不支持此次工具调用'})).toBeVisible();
const profile = (await read('/api/model-profiles')).items.find(item => item.id === Y.textOnlyId);
assert.equal(profile.capabilities.text.status,'supported'); assert.equal(profile.capabilities.tools.status,'unsupported');
assert.equal(profile.capabilities.vision.status,'unknown');
await go('/ai?kind=agent&year=2024&recordId=' + Y.firstId);
await page.getByLabel('模型配置').selectOption(Y.textOnlyId);
await page.getByLabel(/补充整理要求/).fill('保留原话，整理与家人吃面包这件事。');
await page.getByRole('button',{name:'生成独立草稿',exact:true}).click();
const id = await completeDraft();
assert.equal((await read('/api/ai/drafts/' + id)).mode,'fixed');
await expect(page.getByText(/程序筛选素材后生成/).first()).toBeVisible();
return {independentCapabilities:true,fallback:'fixed'};
`,
cancel: String.raw`
Y.slowId = await newModel('E2E 取消与重试','chat-completions','timeout',false,60);
await page.getByRole('button',{name:'验证文本生成',exact:true}).click();
await page.getByRole('button',{name:'取消验证',exact:true}).click();
await expect(page.getByRole('status').filter({hasText:'验证已取消'})).toBeVisible();
await go('/ai?kind=polish&recordId=' + Y.recordId);
await page.getByLabel('模型配置').selectOption(Y.slowId);
await page.getByRole('button',{name:'生成独立草稿',exact:true}).click();
await page.waitForURL(/\/tasks\?task=/);
Y.cancelledTaskId = new URL(page.url()).searchParams.get('task');
const card = page.locator('.ai-task-card.highlighted');
await card.getByRole('button',{name:'取消任务',exact:true}).click();
await expect(card.locator('.ai-status')).toHaveText('已取消');
assert.equal((await read('/api/tasks/' + Y.cancelledTaskId)).status,'cancelled');
return {cancelledProbe:true,cancelledTask:Y.cancelledTaskId};
`,
retry: String.raw`
await go('/settings');
await page.getByRole('button',{name:'编辑模型配置 E2E 取消与重试',exact:true}).click();
await page.getByLabel('模型名称').fill('mock-all');
await page.getByRole('button',{name:'保存模型配置',exact:true}).click();
await expect(page.getByRole('status').filter({hasText:'配置已保存'})).toBeVisible();
await go('/tasks?task=' + Y.cancelledTaskId);
await page.locator('.ai-task-card.highlighted').getByRole('button',{name:'继续 / 重试',exact:true}).click();
Y.retryDraftId = await completeDraft();
assert.equal((await read('/api/ai/drafts/' + Y.retryDraftId)).kind,'polish');
const drafts = await read('/api/ai/drafts?limit=100');
assert.equal(drafts.items.filter(item => item.taskId === Y.cancelledTaskId).length,1);
assert.equal((await read('/api/records/' + Y.recordId)).body,Y.originalBody);
return {retryCompleted:true,singleDraft:true,originalUnchanged:true};
`,
backup: String.raw`
await go('/settings');
await page.getByRole('button',{name:'创建备份',exact:true}).click();
await expect(page.getByRole('status').filter({hasText:'备份已保存'})).toBeVisible();
const href = await page.getByRole('link',{name:/下载/}).first().getAttribute('href');
const res = await context.request.get(new URL(href,Y.base).href);
assert.ok(res.ok()); const bytes = await res.body(); assert.equal(bytes.subarray(0,2).toString(),'PK');
const backupFile = artifactPath('yearbook-stage75-backup.zip');
await (await import('node:fs/promises')).writeFile(backupFile,bytes);
await page.getByLabel('选择备份文件').setInputFiles(backupFile);
await page.getByLabel(/我了解恢复会将当前资料库替换为这份备份/).check();
await page.getByRole('button',{name:'恢复这份备份',exact:true}).click();
await expect(page.getByRole('status').filter({hasText:'恢复完成'})).toBeVisible({timeout:25000});
await expect(page.locator('.model-capabilities .capability-state')).toHaveText(['尚未验证','尚未验证','尚未验证','尚未验证']);
assert.equal((await read('/api/records/' + Y.recordId)).media.length,2);
assert.ok(JSON.stringify(await read('/api/yearbooks/' + Y.bookId)).includes(Y.manualBody));
const profiles = await read('/api/model-profiles');
assert.ok(profiles.items.every(profile => Object.values(profile.capabilities).every(capability => capability.status === 'unknown')));
assert.equal((await read('/api/ai/drafts/' + Y.monthlyId)).content.paragraphs[0].text,Y.monthlyBody);
return {backup:true,restored:true,modelsNeedRevalidation:true,aiAndMediaPreserved:true};
`,
final: String.raw`
await go('/reports');
await page.getByLabel('翻到哪一月').fill('2024-06');
await expect(page.getByRole('link',{name:'六月小报 · 手动留字',exact:true})).toBeVisible();
await page.getByRole('link',{name:'六月小报 · 手动留字',exact:true}).click();
await expect(page.getByLabel('段落 1')).toHaveValue(Y.monthlyBody);
await expect(page.locator('.ai-photo-grid img')).toHaveCount(2);
return {recordId:Y.recordId,bookId:Y.bookId,monthlyId:Y.monthlyId,annualId:Y.annualId,agentId:Y.agentId};
`,
};
