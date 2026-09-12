# 75% 节点模块契约

本轮只推进模型配置、AI 助理与 Agent；最终节点的未来信与完整导出排版验收继续保留。

## 实际实现与文件边界

- 主线：共享模型契约、`models/`、迁移 003、设置页、路由/备份/生命周期集成、E2E、启动脚本与文档。
- GPT-6 Astra 子代理：共享 AI 契约、`ai/`、迁移 004、AI/月报/任务页面、AI 与模拟协议回归，并参与最后的并发/来源审查。
- 用户授权的其他模型尝试没有成功进入可用工作状态；实际协作结果不包含这些失败尝试。

## 对外接口约定

模型路由统一为 `/api/model-profiles`：列表/新增、`/:id` 编辑/删除、`/:id/activate` 切换、`/:id/test` 单项能力测试、`/:id/models` 获取可选模型列表。`/normalize` 预览最终地址，`/credential-status` 返回本机凭据可用性。列表与详情都不能返回密钥；编辑不填写密钥表示保留，显式清除由单独字段表达。

协议字段 `responses` / `chat-completions`。配置包括 `name`、`baseUrl`、`model`、`timeoutMs`、`maxOutputTokens`、`streamEnabled`；能力分别为 `text`、`vision`、`tools`、`streaming`，状态为 `unknown`、`supported`、`unsupported`、`error`，每项独立保存检查时间。凭据模式 `windows` / `session` / `none`。

AI 路由统一为 `/api/ai/tasks` 创建异步任务；任务查询/取消/重试沿用 `/api/tasks`。草稿列表/详情/编辑/采用使用 `/api/ai/drafts`、`/:id`、`/:id/adopt`。任务种类包括记录标题、文字整理、补充问题、月报、章节、全年编册和自然语言 Agent；任务提交必须指定素材范围或记录 ID，不访问未来信。

AI 草稿保持独立，逐段记录 `sourceRecordIds`，图片记录 `mediaId` 和说明。模型重生成为新任务/草稿版本；采用只能显式发生。原记录不被任务自动更新；采用年册草稿先保存现有版本，保留所有旧版本。

协议服务与 AI 运行器之间以 `ModelRequest/ModelResult` 为契约。`ModelRequest.expectedProfileUpdatedAt` 是内部配置版本保护字段，不发送给模型。可信用量通过 `ModelResult.usage` 或失败时 `ModelError.usage` 传给任务累积器。

## 集成约定

- 路由通过 `registerModelRoutes(app, modelService)` / `registerAiRoutes(app, store, aiRunner)` 注册；服务由 `new ModelService(store, vault?)`、`new AiRunner(store, models)` 构造。
- 网络等待不能占用 DataStore 写队列；事务只包数据库读写。请求取消必须中止网络，服务关闭先停止任务再关闭数据库。
- 任务执行最多 30 分钟、工具调用次数受限；分月阶段结果落库；同一任务重试不重复保存草稿。
- 系统凭据只保存不可猜测引用；会话密钥仅在服务进程内存，不写普通文件。模型错误不回显响应中的密钥。
- 备份必须验证新增实体与来源，支持旧版本备份先验证原结构再升级，恢复不能让旧的任务写入新资料库。
- `scopeRecordIds` 是完整授权范围，`sourceRecordIds` 是草稿实际引用范围，校验和备份不能混淆二者。
- 恢复前暂停并等待模型/AI/导出，HTTP 请求及任务检查代次；备份与恢复副本清除凭据引用并重置能力。
- 测试使用独立临时目录和本机模拟 HTTP 服务，不读取真实凭据或发送用户资料。
