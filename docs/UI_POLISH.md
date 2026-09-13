# 窗景与年册美化

更新时间：2026-09-13（Asia/Shanghai）。参考 [dsh-frosted-window](https://github.com/SenryLee/dsh-frosted-window#readme) 的本地壁纸、毛玻璃调节与外观保存交互，完成界面、阅读预览和年度 PDF 排版更新。

## 使用入口

- 侧栏“窗景与外观”、右上角“外观”以及设置页均可打开外观面板。支持浅色、深色、跟随系统、三种内置窗景、本地壁纸选择与拖入，以及玻璃浓度、背景模糊、饱和度、暗度调节。
- 调整即时预览，保存后恢复；关闭面板会放弃尚未保存的调整。可以撤销、移除壁纸、关闭毛玻璃或恢复默认。
- 年册预览新增章节目录、适合宽度、50%–150% 缩放、专注阅读、阅读进度和重新载入。Esc 退出专注，照片预览支持左右方向键。
- 年度导出统一封面、目录、章节编号、正文、图片说明和页码。照片版突出大图，文字版收紧图片与版心；PDF 包含可点击目录和章节书签。

壁纸存放于当前站点的 IndexedDB，参数保存在 localStorage；不进入资料库备份。界面主题、壁纸和预览缩放不影响导出。浅深色主题使用页面自己的配色，并声明 `darkreader-lock`，避免扩展重复着色。

## 实际验收

所有生成、修改和恢复测试都使用独立资料目录及模拟内容。

| 检查 | 结果与证据 |
|---|---|
| 类型检查、生产构建、差异检查 | `npm run typecheck`、`npm run build`、`git diff --check` 通过 |
| 自动化测试 | `npm test`：19 个文件、159 项通过；`test-results/ui-polish/final-unit-tests.log` |
| 完整浏览器回归 | `npm run test:e2e` 退出码 0；`test-results/2026-09-13T03-28-16-246Z-81112/summary.json` |
| 外观与小功能 | 壁纸上传、保存与刷新、撤销、非法图片、开关、系统主题、移除与重置；预览缩放、打印比例、目录、专注、进度和照片方向键通过 |
| 窄屏阅读 | 390px、440px、1440px 之间切换，外层及“适合宽度”预览文档无横向溢出；修复了缩放监听延迟造成的暂时溢出 |
| 实际 PDF | 照片版 12 页、文字版 11 页，全部渲染并检查；`test-results/ui-polish/pdf-layout-v3/` |
| PDF 内容与资源 | 两版分别嵌入 22、25 个字体片段，各有 12 项书签；无文字越界、空白页或图片比例变形，见 `visual-check.json` 和 `pdf-audit.json` |
| 正式服务 | 已通过本项目启动器重启至最新构建，地址 `http://127.0.0.1:4317/`；重启前后记录、年册、信件、AI 草稿、模型配置和任务接口响应摘要完全一致，见 `test-results/ui-polish/live-service-after.json` |

浏览器回归同时覆盖原有记录、照片、未来信、年册排序、离线 HTML、PDF、双协议模拟模型、AI 草稿保护、取消重试及备份恢复。没有调用真实模型服务。

PDF 使用本机 Chrome 生成，由 PyMuPDF 渲染检查。最终 PDF 证据是 `pdf-layout-v3`；早期两批用于修正分页，不作为最终交付效果。

## 视觉证据

已查看首页浅色、年册列表浅色与深色壁纸、手机外观面板及两版 PDF 全部页面。界面截图保存在 `test-results/ui-polish/` 的 `home-light.png`、`gallery-light.png`、`gallery-dark-wallpaper.png`、`appearance-mobile.png`；PDF 逐页图片和四张总览位于 `pdf-layout-v3/`。

Tabbit 对部分长页面截图仍会超时或回退为视口图；完整 E2E 有 4 次回退，`fullPageScreenshotsComplete` 为 `false`。深色首页截图也发生超时，随后通过深色年册列表取得完整截图。上述限制与交互回归分别记录，不将视口截图视为整页覆盖。

## 维护位置

外观逻辑在 `apps/web/src/Appearance.tsx`、`appearance-store.ts`，视觉样式在 `tokens.css`、`appearance.css`、`polish.css`；阅读器在 `YearbookReader.tsx`、`reader.css`。导出共用 `apps/server/src/yearbook-template.ts` 和 `yearbook-print-style.ts`，PDF 书签由 `pdf-browser.ts` 启用。新增浏览器流程位于 `scripts/e2e-appearance-flows.mjs`。

当前改动保留在工作区，未创建 Git 提交。
