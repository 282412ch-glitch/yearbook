# 本地接口契约

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

## 节点二：年册与导出

| 方法 | 地址 | 响应/用途 |
|---|---|---|
| GET | `/api/yearbooks?year=2024` | `YearbookList`，按年筛选；`deleted=true` 查看回收站 |
| POST | `/api/yearbooks` | `YearbookInput`，不传 chapters 时按该年记录生成默认章节，201 |
| GET / PUT / DELETE | `/api/yearbooks/:id` | 读取、完整保存结构化年册、软删除 |
| POST | `/api/yearbooks/:id/restore` | 恢复软删除年册 |
| GET | `/api/yearbooks/:id/preview` | 返回包含内嵌图片的可打印 HTML |
| GET | `/api/yearbooks/:id/versions` | 版本列表（manual/ai 来源） |
| POST | `/api/yearbooks/:id/versions` | `{snapshot:YearbookInput,source:'manual'|'ai',label?}`，只保存提案快照，不替换当前编辑稿 |
| GET | `/api/yearbooks/:id/versions/:versionId` | 读取版本快照 |
| POST | `/api/yearbooks/:id/versions/:versionId/apply` | 将版本快照作为新手动版本采用 |
| POST | `/api/yearbooks/:id/export` | `{format:'html'|'pdf', idempotencyKey?}`，返回 202 `TaskItem` |
| GET | `/api/yearbooks/:id/export/:format?taskId=...` | 任务完成后下载 ZIP/PDF，否则返回 202 任务 |
| GET | `/api/tasks` / `/api/tasks/:id` | 查询导出及后台任务 |
| POST | `/api/tasks/:id/cancel` / `/retry` | 取消或重试失败/取消任务 |

年册章节包含 `kind/title/body/position`，块类型支持 `paragraph`、`image`、`quote`、`record`，每个章节保存 `sourceRecordIds`。保存会创建不可变版本快照，手动编辑不会覆盖旧版本。HTML 导出为自包含 ZIP；PDF 导出调用本机 Chromium 的无头打印参数，未安装浏览器时任务明确失败并提示在浏览器打印 HTML。

## 节点三：模型、AI 草稿与任务

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

协议与运行器接口见 [STAGE75_CONTRACT.md](STAGE75_CONTRACT.md)，用户配置流程见 [AI_CONFIGURATION.md](AI_CONFIGURATION.md)。
