# 本地接口文档

共享类型在 `packages/shared/src/index.ts`。JSON 无额外 data 包装，错误 `{error:{code,message,details?}}`。

| 方法 | 地址 | 响应/用途 |
|---|---|---|
| GET | /api/health | `{app:'yearbook',version:'0.1.0',status:'ok',...}` |
| GET | /api/stats | AppStats |
| GET | /api/meta | Metadata |
| GET | /api/records | RecordList；q/year/month(1–12)/person/tag/first=true/deleted=true/limit/offset |
| POST | /api/records | RecordInput → RecordItem，201 |
| GET / PUT / DELETE | /api/records/:id | 详情 / 完整编辑 / 软删除，返回 RecordItem |
| POST | /api/records/:id/restore | 恢复，RecordItem |
| POST | /api/records/:id/reflections | `{body}` → RecordItem |
| GET | /api/calendar?month=YYYY-MM | CalendarData |
| GET | /api/memories?exclude=id,id&count=1 | `{items: RecordItem[]}`，尽量避开 exclude |
| POST | /api/media | multipart 文件字段 files（可多次），`{items:MediaItem[],duplicates:number}` |
| GET | /api/media/:id/original | 原图 |
| GET | /api/media/:id/display | 方向规范化的阅读图 |
| GET | /api/media/:id/thumbnail | 缩略图 |
| GET / POST | /api/backups | `{items:BackupInfo[]}` / BackupInfo |
| GET | /api/backups/:id/download | ZIP |
| POST | /api/backups/restore | multipart 字段 file，成功 `{restored:true,preRestoreBackup:BackupInfo}` |

`createApp({dataDir,webDist?})` 从 `apps/server/src/app.ts` 导出，返回 Promise<FastifyInstance>；`app.close()` 关闭数据库。生产入口在 `apps/server/src/index.ts`，支持 YEARBOOK_DATA_DIR、YEARBOOK_PORT（默认 4317）、YEARBOOK_WEB_DIST，可用 YEARBOOK_INSTANCE_TOKEN 做本应用停止认证。默认仅监听 127.0.0.1。

备份和恢复时互斥写入。备份是数据库一致性快照+原图+派生图+哈希/版本清单；恢复校验迁移版本、数据库完整性、外键和媒体引用，先保留恢复前备份，失败可回滚。ZIP 不得越界、包含密钥或嵌套历史备份。

## 年册与导出

| 方法 | 地址 | 响应/用途 |
|---|---|---|
| GET | `/api/yearbooks?year=2024` | `YearbookList`，按年筛选；`deleted=true` 查看回收站 |
| POST | `/api/yearbooks` | `YearbookInput`，不传 chapters 时按该年记录生成默认章节，201 |
| GET / PUT / DELETE | `/api/yearbooks/:id` | 读取、完整保存结构化年册、软删除 |
| POST | `/api/yearbooks/:id/restore` | 恢复软删除年册 |
| GET / HEAD | `/api/yearbooks/:id/preview` | 返回内嵌照片/字体的同一份可打印 HTML；HEAD 校验可用性，允许应用同源 iframe |
| GET | `/api/yearbooks/:id/versions` | 版本列表（manual/ai 来源） |
| POST | `/api/yearbooks/:id/versions` | `{snapshot:YearbookInput,source:'manual'|'ai',label?}`，只保存提案快照，不替换当前编辑稿 |
| GET | `/api/yearbooks/:id/versions/:versionId` | 读取版本快照 |
| POST | `/api/yearbooks/:id/versions/:versionId/apply` | 将版本快照作为新手动版本采用 |
| POST | `/api/yearbooks/:id/export` | `{format:'html'|'pdf', idempotencyKey?}`，返回 202 `TaskItem` |
| GET | `/api/yearbooks/:id/export/:format?taskId=...` | 任务完成后下载 ZIP/PDF，否则返回 202 任务 |
| GET | `/api/tasks` / `/api/tasks/:id` | 查询导出及后台任务；列表默认排除回收站，`deleted=true` 只查回收站，支持 status/yearbookId/limit/offset |
| POST | `/api/tasks/:id/cancel` / `/retry` | 取消或重试失败/取消任务 |
| DELETE | `/api/tasks/:id` | 移入任务回收站，返回含 `deletedAt` 的 `TaskItem`；等待中或运行中的任务先取消并中止执行 |
| POST | `/api/tasks/:id/restore` | 恢复到任务列表，保留状态、进度和结果，不自动执行；回收站中的任务须恢复后才能重试 |

任务移入与恢复均为幂等操作。移入时保留 AI 阶段、草稿、来源和导出文件，并释放请求幂等键，让新提交可创建新任务；恢复不会重新占用旧请求键。回收站状态随资料库保存和备份。

年册章节包含 `kind/title/body/position`，块类型支持 `paragraph`、`image`、`quote`、`record`，每个章节保存 `sourceRecordIds`。传入数组顺序决定章节和块的位置，移动时保留 ID/图注/来源；显式 `chapters:[]` 保存空册，不传字段才生成默认章节。保存会创建不可变版本快照，手动编辑不会覆盖旧版本。

HTML ZIP 的 `index.html` 内嵌所需 Noto 中文字体与全部图片，并附 OFL 许可证、导出版本清单与说明。PDF 任务使用独立 Chromium CDP，在禁网且字体/图片就绪后打印；任务结果包含实际浏览器、字节数、载入字体片段数、图片数、模板及保存时间。没有可用浏览器、资源缺失、超时或取消均为明确状态，下载端不返回未完成产物。

## 模型、AI 草稿与任务

| 方法 | 地址 | 响应/用途 |
|---|---|---|
| GET / POST | `/api/model-profiles` | `ModelProfileList` / 新增 `ModelProfile`，不返回 Key |
| PUT / DELETE | `/api/model-profiles/:id` | 修改配置 / 删除配置与其凭据 |
| POST | `/api/model-profiles/:id/activate` | 切换默认配置 |
| POST | `/api/model-profiles/normalize` | `{baseUrl,protocol}` → 规范化地址 |
| GET | `/api/model-profiles/credential-status` | Windows 系统凭据可用性及建议模式 |
| GET | `/api/model-profiles/:id/models` | 可选模型名称列表，失败不影响手填 |
| POST | `/api/model-profiles/:id/test` | `{capability:'text'|'vision'|'tools'|'streaming'}`，逐项探测并保存时间 |
| POST | `/api/ai/tasks` | `AiTaskInput` → 202 `TaskItem`，不直接覆盖原记录 |
| GET | `/api/ai/tasks/:id` | `AiTaskDetail`，含授权请求、阶段、模式、用量、提示 |
| GET | `/api/ai/drafts` | `AiDraftList`，支持 kind/year/month/recordId/limit/offset |
| GET / PUT | `/api/ai/drafts/:id` | `AiDraftItem` / `{content:AiDraftContent}` 编辑并保留版本 |
| GET | `/api/ai/drafts/:id/versions` | `AiDraftVersion[]`，生成稿和各次手动保存稿 |
| POST | `/api/ai/drafts/:id/adopt` | `{yearbookId?:UUID|null}` → `AiAdoptResult` |

任务类型为 title、polish、questions、monthly、chapter、yearbook、agent。`recordIds` 指定本次允许的素材；照片授权由 `selectedMediaIds/useImages` 控制。每段与每张选图包含 `sourceRecordIds`。任务/阶段保存采用幂等键，重试不会自动生成重复草稿。

单条标题/整理采用返回 `recordProposal`，浏览器预填编辑页，由用户显式保存。章节/月报采用追加年册章节；整册采用前保留当前年册版本。`yearbookId:null` 表示明确新建年册，未提供字段时可沿用生成任务绑定的目标。

模型详情使用 `ModelProfile`，数据库凭据引用不对前端暴露。恢复备份后凭据引用清空、四项能力重置，需重新配置。服务只给出固定中文错误，不回显上游敏感信息。恢复期间开始的写入返回 503；跨越恢复周期的迟到请求返回 409 `LIBRARY_RESTORED`。

模型配置的协议字段为 `responses` / `chat-completions`，包括 `name`、`baseUrl`、`model`、`timeoutMs`、`maxOutputTokens`、`streamEnabled`。能力为 `text`、`vision`、`tools`、`streaming`，状态为 `unknown`、`supported`、`unsupported`、`error`，分别保存检查时间；凭据模式为 `windows` / `session` / `none`。配置流程见 [AI 配置](AI_CONFIGURATION.md)。

协议服务与 AI 运行器使用 `ModelRequest/ModelResult` 传递请求和结果。`ModelRequest.expectedProfileUpdatedAt` 用于保护配置版本，不发送给模型；可信用量通过 `ModelResult.usage` 或失败时的 `ModelError.usage` 传给任务累积器。

`scopeRecordIds` 表示本次任务的完整授权范围，`sourceRecordIds` 表示草稿实际引用的记录范围，来源校验与备份恢复需分别处理。

## 未来信

| 方法 | 地址 | 响应/用途 |
|---|---|---|
| GET | `/api/letters?status=all&deleted=false&limit=24&offset=0` | `LetterList`，仅信封；status 可为 all/draft/sealed/due/read |
| GET | `/api/letters/summary` | 服务端 today、dueUnread、totalDrafts、sealedCount、至多 50 个到期信封 |
| POST | `/api/letters` | `LetterInput` → 201 `LetterDetail`，创建持久草稿 |
| GET / PUT | `/api/letters/:id` | 获取允许阅读的详情 / 更新未封存草稿 |
| POST | `/api/letters/:id/seal` | 空请求体或 `{}`，校验正文/照片和查看日期后幂等封存 |
| POST | `/api/letters/:id/read` | 到期后明确拆阅，首次 readAt 固定，重复调用幂等 |
| DELETE | `/api/letters/:id` | 软删除，照片不丢失 |
| POST | `/api/letters/:id/restore` | 恢复信件及原查看日期 |

`LetterInput={title,body,unlockOn,media:[{id,caption}]}`，草稿允许未完成正文和空日期。封存需要今天或未来的本地日期，且正文非空或至少有一张照片。封存后 PUT 返回 `LETTER_SEALED`，不能修改内容或提前改日期。

`LetterEnvelope` 含 ID、标题、查看日期、创建/修改/封存/首次阅读/删除时间、status、photoCount、canRead。未到期的 `LetterDetail` 不包含 `body` 或 `media` 字段；到期 GET 也不更新 readAt。未来信不进入 records、普通搜索、盲盒和 AI 授权范围。

仅属于未到期信件的照片经 `/api/media/:id/{kind}` 读取或只凭 ID 建立新关联时返回 `LETTER_MEDIA_SEALED`。用户主动上传完整相同文件通过哈希验证后可临时复用；再次封存、30 分钟到期、重启和恢复换库会撤销这种临时授权。已有可读的共享引用不受单个信件封存影响。
