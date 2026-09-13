# 100% 节点接续与维护说明

2026-09-13 补充：窗景与外观、界面样式、年册阅读器和 PDF 排版已更新。当前维护文件、159 项测试、完整 E2E、最终 PDF 证据及服务重启结果见 [UI_POLISH.md](UI_POLISH.md)。以下内容保留此前功能交付的背景和约束，验证数字以最新补充为准。

更新时间：2026-09-12（Asia/Shanghai）。实际项目为 **`D:\项目文件夹\yearbook`**，沿用用户确认的 Git 仓库，不搬迁到最初要求但不存在的 C 盘目录。本轮从 75% 继续到最终交付，完成后按用户要求在 **100% 节点暂停**。

起始提交为 `2e7010b`，分支 `master`，开始时工作区干净且没有远端。最终提交请用 `git log -1` 查看。不得重置后续用户改动；原 `img` 素材、正式 `data` 和模型配置保留。

## 当前功能

- 记录与照片、日期补记、人物/地点/标签、回顾补记、时间轴、日历、中文筛选搜索、软删除恢复。
- 记忆盲盒、生活第一次；未来信的草稿/照片/顺序、浏览器未提交草稿恢复、确认封存、到期提醒、显式拆阅与信件回收站。
- 同年多本手工年册、章节/段落/原话/图片/记录卡片和来源；章节/块/照片排序，选集批量选片、封面、两套模板、保存前预览/导出、历史版本恢复。
- 统一排版的预览、离线 HTML ZIP 和真实 PDF，随文件携带所需中文字体；导出进度、取消、超时、错误和重试。
- 多套模型配置、Windows 系统凭据/会话后备、Responses 与 Chat Completions 独立适配；文本/图片/工具/流式分别验证。
- AI 标题、整理、补问、月报、分月编册与自然语言 Agent；受限检索工具、来源快照、独立草稿和明确采用，重新生成保护手动修改。
- SQLite 持久任务、实际用量、阶段结果、取消/重试/重启恢复、幂等与执行代次保护。
- 迁移 001–005、一致性备份、原版本校验后升级、新目录恢复、恢复前备份、失败回滚和并发隔离；Windows 一键启停与端口冲突处理。

## 本轮新增入口

| 文件 | 用途 |
|---|---|
| `packages/shared/src/letters.ts`、`apps/server/src/letters.ts` | 信件共享契约、日期状态、CRUD/封存/拆阅和独占媒体访问边界 |
| `apps/server/migrations/005_letters.sql` | 独立未来信及照片关联，不更改旧迁移 |
| `apps/web/src/LetterPages.tsx`、`letters.css` | 信件列表、编辑、详情、封存确认和回收站 |
| `apps/web/src/YearbookPages.tsx`、`yearbook-ordering.ts`、`yearbook.css` | 稳定编辑 ID、三层排序、选集、保存与 iframe 预览 |
| `apps/server/src/yearbook-template.ts`、`export-fonts.ts` | 冻结素材快照、共享 HTML/CSS 模板和字体片段 |
| `apps/server/src/pdf-browser.ts`、`exports.ts` | 独立 Chrome/Edge profile、Node CDP、PDF 与任务生命周期 |
| `scripts/e2e-final-flows.mjs`、`verify-runtime.mjs` | 最终浏览器流程与完整中文空格项目路径的 Windows 验证 |
| `tests/export-evidence.ts` | 只在临时目录创建排版夹具，输出双模板 HTML/PDF |

既有模型与 Agent 代码在 `apps/server/src/models/`、`ai/`，对应前端为 `ModelsPanel.tsx`、`AiPages.tsx`、`AiEntryPoints.tsx`。不要因为接续而重写已有模块。

## 验证状态

- Node **24.14.1**、npm **11.17.0**；`npm test` 为 **18 文件、149 项通过**，类型检查和生产构建通过。
- Windows 完整中文空格项目副本内 **11 步通过**，包括 `npm start`、`npm run dev`、重复启动、端口冲突、原 CMD 启停和无关进程保护；`test-results/runtime-final.json`。
- 两模板实际 PDF 为 **10 页 + 9 页**，全部渲染打开检查；中文可提取、字体嵌入、照片比例和跨页正常。最终文件在 `test-results/export-layout-1789216054006/`，不要拿第一批缺陷夹具当最终证据。
- 原色离线 HTML 完整窄窗口截图已打开；动态 UI 截图仍有 Tabbit 超时/回退/裁切限制，不能宣称所有完整截图通过。证据在 `test-results/visual-final/`。
- 最终 `npm run test:e2e` 业务流程通过，退出码 0。备份恢复并再次重启后保留 2 条记录、2 张记录关联照片、1 本年册、8 份 AI 草稿、2 封信；未到期信与独占照片仍受限。证据 `test-results/2026-09-12T13-53-48-977Z-65276/`。4 张截图回退，完整截图覆盖为 false，不当作视觉全通过。
- 正式服务已完成升级前备份并通过本应用启动器重启，运行在 **http://127.0.0.1:4317**，迁移 005 已应用。重启前后正式记录、关联、年册列表、AI 草稿、模型配置与任务摘要相同；`test-results/final-service-upgrade.json`。详细证据以 [ACCEPTANCE.md](ACCEPTANCE.md) 为准。

## 必须保留的实现约束

1. **不改写已应用的 SQL，包括换行**。001–004 按 SHA256 校验；今后追加迁移。备份要先按原版本检查，再迁移。
2. 记录发生日期、信件查看日期使用 `YYYY-MM-DD` 与服务端本地日历，不转成 UTC 日期。未到期信件不进入普通检索、盲盒或 AI 工具；到期检查在启动/访问时执行。
3. 独占封存照片的读取和重新关联都经服务端校验。完整原文件重新导入可获得 30 分钟、当前数据库连接内的临时授权；封存/重启/恢复换库撤销。共享引用不得丢失。
4. 信件封存是应用层日期约束，不是加密。浏览器草稿封存后清理；数据库和备份仍存原文。
5. 编辑时章节与块以 ID 为 React key，数组顺序是阅读顺序。版本恢复可能为已被整册替换的章节分配新内部 ID；应核对正文、顺序、图片说明与来源，而非依赖废弃 ID。
6. 预览与导出共享模板。导出冻结已保存内容、来源和媒体后再异步排版；字体/图片丢失须明确报错，不能悄悄交付残缺文件。只停止本次创建的打印浏览器进程。
7. `scopeRecordIds` 是授权范围，`sourceRecordIds` 是实际引用。来源文字不能扩大工具权限；第一次章节只用用户标记。来源 ID 校验不保证生成文字的语义真实性。
8. 模型配置版本检查只在本地使用，不发给模型。模型等待不占写队列，取消/重试绑定执行代次；关闭先停模型、AI 和导出，再关库。
9. 恢复前开始的请求在 body 解析后仍须检查维护代次。备份/恢复副本清空凭据引用和能力，不得让外来备份绑定本机旧 Key。
10. 原记录、AI 草稿、年册编辑稿分开保存。记录建议采用只预填编辑器；整册采用前保留当前手动版本。不要篡改历史失败任务为成功。
11. 自动化只用临时资料。浏览器保持 Tabbit，同一任务处理回执，超时后不重复不确定的业务动作；按实际 `nextAction.path` 读取图片，回退图不算完整页。

## 启动、资料与模型边界

```powershell
Set-Location -LiteralPath 'D:\项目文件夹\yearbook'
npm ci
npm run build
npm start
```

日常双击 `Start-Yearbook.cmd`，用 `Stop-Yearbook.cmd` 停止启动器创建的服务。默认 `http://127.0.0.1:4317`，以实际输出为准。终端手动启动用原终端 `Ctrl+C`。

资料在 `data/yearbook.sqlite3`、`data/media`、`data/display`、`data/thumbnails`；备份在 `data/backups`，导出在 `data/exports`。本轮升级前备份为 `yearbook-20260912T140142009Z-d7d4a07f-9431-4de3-98a5-1b7a57694219.zip`。今后升级同样先核对 `.runtime` 中本应用身份和未完成任务，再创建一致性备份。不要输出启动令牌或凭据。恢复备份后重新填写 Key 并验证能力。

本轮没有调用真实模型。Codego 在前轮真实标题请求成功，但完整真实 Agent/年册质量未验收；AnyRouter 最小生成仍被网关额外 Codex 校验拒绝。旧错误没有充分原始响应，不能断言历史根因。见 [MODEL_TROUBLESHOOTING.md](MODEL_TROUBLESHOOTING.md)。

用户授权多模型协作；Sol 的供应高负载、Terra 的不支持使相应尝试未完成，实际成果由主线及可用 GPT-6 Astra 代理协作完成，不将失败尝试算作成功。最后一次附加后端只读审查同样因供应高负载未完成，主线依据代码和测试自行完成集成核对。
