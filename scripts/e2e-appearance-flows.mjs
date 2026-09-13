// Run against e2e.mjs's isolated origin and files. No real library or browser
// preference is modified: application appearance is scoped to this test port.
export const appearanceFlows = {
  appearance: String.raw`
await go('/');
await page.emulateMedia({colorScheme:'light'});
await page.getByRole('button',{name:'外观',exact:true}).click();
await expect(page.getByRole('dialog',{name:'窗景与外观'})).toBeVisible();
await page.getByRole('button',{name:'深色',exact:true}).click();
await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
await page.getByLabel('选择壁纸',{exact:true}).setInputFiles(Y.landscape);
await expect(page.getByAltText('当前壁纸预览')).toBeVisible();
await page.getByRole('slider',{name:'玻璃浓度',exact:true}).press('End');
await page.getByRole('slider',{name:'玻璃浓度',exact:true}).press('ArrowLeft');
for(const label of ['背景模糊','色彩饱和度','壁纸暗度']) await page.getByRole('slider',{name:label,exact:true}).press('ArrowRight');
await page.getByRole('button',{name:'保存外观',exact:true}).click();
await expect(page.getByText('外观已保存，下次打开会自动恢复。',{exact:true})).toBeVisible();
const persisted = await page.evaluate(()=>JSON.parse(localStorage.getItem('yearbook:appearance:v1')));
assert.equal(persisted.mode,'dark'); assert.equal(persisted.density,99);
assert.equal(persisted.blur,25); assert.equal(persisted.saturation,116); assert.equal(persisted.dim,11); assert.ok(persisted.wallpaperId);
await go('/');
await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
await expect(page.locator('.wallpaper-photo')).toHaveCount(1);
await page.getByRole('button',{name:'外观',exact:true}).click();
await expect(page.getByRole('slider',{name:'玻璃浓度',exact:true})).toHaveValue('99');
await page.getByRole('button',{name:'浅色',exact:true}).click();
await page.getByRole('button',{name:'移除壁纸',exact:true}).click();
await expect(page.locator('.wallpaper-photo')).toHaveCount(0);
await page.keyboard.press('Escape');
await expect(page.getByRole('dialog')).toHaveCount(0);
await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
await expect(page.locator('.wallpaper-photo')).toHaveCount(1);
return {wallpaperPersisted:true,slidersPersisted:true,closeDiscardsPreview:true};
`,
  appearanceModes: String.raw`
await page.getByRole('button',{name:'外观',exact:true}).click();
await page.getByLabel('选择壁纸',{exact:true}).setInputFiles({name:'unsupported.svg',mimeType:'image/svg+xml',buffer:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')});
await expect(page.getByRole('alert')).toHaveText('请选择 JPEG、PNG、WebP 或 GIF 图片。');
await expect(page.getByAltText('当前壁纸预览')).toBeVisible();
await page.getByRole('switch',{name:'毛玻璃窗景',exact:true}).click();
await expect(page.getByRole('slider',{name:'玻璃浓度',exact:true})).toBeDisabled();
await expect(page.locator('.app-backdrop')).toBeHidden();
await page.getByRole('button',{name:'保存外观',exact:true}).click();
await expect(page.getByText('外观已保存，下次打开会自动恢复。',{exact:true})).toBeVisible();
await go('/');
await expect(page.locator('html')).toHaveAttribute('data-frosted','false');
await page.getByRole('button',{name:'外观',exact:true}).click();
await page.getByRole('switch',{name:'毛玻璃窗景',exact:true}).click();
await expect(page.getByAltText('当前壁纸预览')).toBeVisible();
await page.getByRole('button',{name:'跟随系统',exact:true}).click();
await page.emulateMedia({colorScheme:'light'});
await expect(page.locator('html')).toHaveAttribute('data-theme','light');
await page.emulateMedia({colorScheme:'dark'});
await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
await page.getByRole('button',{name:'恢复默认外观',exact:true}).click();
await page.getByRole('button',{name:'保存外观',exact:true}).click();
await expect(page.getByText('外观已保存，下次打开会自动恢复。',{exact:true})).toBeVisible();
await go('/');
await expect(page.locator('.wallpaper-photo')).toHaveCount(0);
assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('yearbook:appearance:v1')).wallpaperId),null);
await page.emulateMedia({colorScheme:'light'});
await expect(page.locator('html')).toHaveAttribute('data-theme','light');
return {invalidImagesRejected:true,frostTogglePersists:true,systemTheme:true,wallpaperRemoved:true};
`,
  reader: String.raw`
await go('/yearbooks/' + Y.bookId + '/preview');
await page.emulateMedia({reducedMotion:'reduce'});
await expect(page.getByRole('button',{name:'PDF 导出',exact:true})).toBeEnabled({timeout:30000});
await expect(page.locator('.reader-outline')).toBeVisible();
const outerScroll = await page.evaluate(()=>scrollY);
await page.getByRole('navigation',{name:'年册章节'}).getByRole('button').last().click();
assert.ok(Math.abs(await page.evaluate(()=>scrollY) - outerScroll) < 2, '章节跳转不应滚动外层页面');
await page.getByLabel('预览比例',{exact:true}).selectOption('125');
await expect.poll(()=>page.locator('iframe').evaluate(frame=>getComputedStyle(frame.contentDocument.querySelector('.page')).zoom)).toBe('1.25');
await page.getByRole('button',{name:'专注阅读',exact:true}).click();
await expect(page.locator('body')).toHaveAttribute('data-reader-focus','true');
const rect = await page.locator('.reader-shell').boundingBox();
assert.ok(rect.x < 15 && rect.y < 15);
await page.keyboard.press('Escape');
await expect(page.locator('.reader-shell')).not.toHaveClass(/is-focused/);
await page.emulateMedia({media:'print'});
assert.equal(await page.locator('iframe').evaluate(frame=>getComputedStyle(frame.contentDocument.querySelector('.page')).zoom),'1');
await page.emulateMedia({media:'screen'});
await page.getByLabel('预览比例',{exact:true}).selectOption('fit');
await page.setViewportSize({width:390,height:844});
assert.ok(await page.locator('iframe').evaluate(frame => frame.contentDocument.documentElement.scrollWidth <= frame.contentWindow.innerWidth + 1), '适合宽度应在窗口变窄时同步缩放');
await page.getByRole('navigation',{name:'年册章节'}).getByRole('button',{name:'封面',exact:true}).click();
await expect(page.getByRole('progressbar',{name:'年册阅读进度'})).toHaveAttribute('value','0');
await page.getByRole('button',{name:'收起年册目录',exact:true}).click();
assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth));
await page.getByRole('button',{name:'专注阅读',exact:true}).click();
await expect(page.getByRole('button',{name:'退出专注',exact:true})).toBeVisible();
await page.getByRole('button',{name:'退出专注',exact:true}).click();
await page.setViewportSize({width:1440,height:1000});
await page.emulateMedia({reducedMotion:'no-preference'});
return {chapterNavigation:true,zoom:true,printIgnoresZoom:true,focusAndEscape:true,mobileControls:true};
`,
  photoKeyboard: String.raw`
await go('/records/' + Y.recordId);
await page.locator('.detail-photos .photo-preview-button').first().click();
await expect(page.getByRole('dialog',{name:'照片预览'})).toBeVisible();
const image = page.locator('.photo-dialog > img');
const original = await image.getAttribute('src');
await page.keyboard.press('ArrowRight');
await expect(image).not.toHaveAttribute('src',original);
await page.keyboard.press('ArrowLeft');
await expect(image).toHaveAttribute('src',original);
await page.keyboard.press('Escape');
await expect(page.getByRole('dialog')).toHaveCount(0);
await go('/yearbooks/' + Y.bookId + '/preview');
await expect(page.getByRole('button',{name:'PDF 导出',exact:true})).toBeEnabled({timeout:30000});
return {photoArrowKeys:true,escapeCloses:true};
`,
};
