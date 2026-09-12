# 模型配置补修与真实服务诊断

日期：2026-09-12。此轮处理 75% 节点后的配置故障，不推进未来信等最终节点功能。

## Codego：能力通过但整理失败（后续诊断）

用户随后新增并启用 Codego：Responses、`https://shu26.cfd/v1/responses`、`gpt-5.6-sol`。保存结果中，文字、图片、流式分别已通过，工具尚未验证。两个失败任务确实绑定这套配置，分别为标题建议和自然语言整理；均执行固定流程，没有发送图片或工具调用。因此工具未验证不是这两次失败的直接原因。

`HTTP 200` 只表示 HTTP 连接层成功。Responses 流中可以继续返回 `response.failed` 或 `error`；旧错误分类将这种情况也显示成“模型服务未接受请求，请检查协议、模型与输出长度”。另外，旧解析器会把成功响应中的 `error: {}` 或 `{code:null,message:null}` 误判为错误。这些不同情况会显示同一条提示，历史任务只保存该提示，无法从已有记录确定当时的响应究竟是哪一种。

实际复测：

- 18:15 使用同一模型、同一整理系统提示词和虚构素材生成标题，成功收到 `response.completed`，完整内容通过草稿 JSON 校验。
- 18:21 将用户此前已授权并提交的失败标题请求发送到同一服务，仍成功；终止响应为 `status: completed`、`error: null`，用量有实际返回。此重放没有保存草稿、改动原记录或原任务，也没有发送照片。
- **两次成功均发生在本轮源码补修之前。** 这表明当前配置可以处理真实标题请求，不能把历史失败归因于地址、Key 或必然不兼容；同样不能将空错误对象缺陷断言为这两次历史失败的根因。服务临时失败或其他响应差异仍无法从旧日志还原。

本轮补修：成功响应允许空错误壳，明确 `failed`、非空错误、取消及未完成响应仍拒绝。HTTP 200 中无法分类的错误改为 `MODEL_GENERATION_FAILED`，说明连接已建立但生成未完成；SSE 错误保留受限事件名，仍不回显上游正文、素材或密钥。

新增回归在修复前实际复现 4 项失败；补修后协议专项 25 项通过。另用本机 HTTP 模拟“短能力测试成功、含素材生成返回空错误对象”，验证独立草稿保存、原文不变、来源正确、未选素材未发送及真实用量保留。全仓测试为 12 文件 114 项通过，类型检查和构建通过。完整隔离 Tabbit E2E 再次通过，证据在 `test-results/2026-09-12T10-30-38-837Z-55448/`；截图已实际打开，视觉限制见验收文档。

证据为 `test-results/codego-diagnostic.json`、`test-results/codego-title-replay.json`、`test-results/build-codego-fix.log`，只保存有限诊断字段，不保存原始请求/响应正文。旧任务的失败状态代表之前那次执行，部署修复不会改写历史结果；可以在任务页选择“继续 / 重试”。工具调用、完整真实 Agent/全年编册质量仍需另行验证。

## AnyRouter：前次诊断结论

用户配置为 Responses、`https://anyrouter.top/v1`、`gpt-6-astra`，流式已启用。最终地址正确为 `https://anyrouter.top/v1/responses`，没有重复 `/v1` 或接口路径。

保存的 Windows 凭据能够读取；使用该配置获取真实 `/v1/models` 成功，列表包含 `gpt-6-astra`。这证明模型发现可用，但不能证明生成接口接受本应用的请求。

真实最小文字请求返回 **HTTP 400**，上游错误码 `invalid_responses_request`，消息为 `invalid codex request`。逐项尝试流式、显式输入消息结构和不传输出长度参数后，仍是同一拒绝。修复后通过本应用的能力验证接口再次请求，结果仍然相同。因此 **当前 AnyRouter 配置的真实文字生成尚未连通**，不能标记为验证通过，也不能据此推断图片或工具能力。

该站公开公告提供官方 Codex 客户端的配置方式；没有找到完整的普通第三方 Responses 调用契约。当前只能确认它有额外的 Codex 请求校验，具体校验规则尚未公开确认。实际使用需要服务方提供支持第三方应用的接口要求，或使用已支持标准兼容调用的服务。保留原模型、地址和密钥配置，没有改成其他模型，也没有伪装官方客户端或修改生活整理提示词来绕过校验。

## 已修复的应用问题

1. **验证忽略流式设置**：文本验证此前强制 `stream:false`，图片和工具也默认普通请求。现在各项验证沿用已保存的流式设置；验证成功仍只更新被测试的能力。只支持流式的模拟服务已真实走通文字、图片和两轮工具探测。
2. **错误信息过于笼统**：兼容 HTTP 嵌套错误和 Responses 顶层 SSE 错误；识别鉴权、限流、服务故障、参数拒绝、要求流式和网关 Codex 校验。显示 HTTP 状态及白名单错误码/参数名；未知原始正文、密钥和任意上游字段不回显。
3. **流式完成后仍等连接关闭**：Responses 在完整 `response.completed` 后结束读取，Chat 在 `[DONE]` 后结束；Chat 的 `finish_reason` 后仍读取最后用量。网关不关闭 HTTP 响应时也能及时完成，并取消 reader。
4. **部分响应误判成功**：已取消、仍执行中等 Responses 结果不得作为完整草稿返回；内容过滤导致的未完成明确归为拒绝，保留服务实际返回的可靠用量。
5. **最小请求与状态一致性**：一次文字验证不再无条件要求 encrypted reasoning；需要工具往返时仍保留必要 reasoning items。改变超时或输出上限也会重置能力验证，避免沿用旧请求条件的结果。

## 验证记录

- 类型检查、构建通过。
- `npm test`：12 个文件、101 项通过；其中模型专项 41 项。
- 新增 `tests/protocol-regression.test.ts`：13 项，在修复前实际复现 11 个失败；修复后全部通过。包括真实本机 HTTP 持续连接、结束标记、顶层错误、非完成状态和失败用量。
- 生产服务已通过本应用启动器正常停止、重新启动；模型配置与凭据保持可用。
- `test-results/model-fix-live.json` 保存本机服务健康、实际配置的非敏感字段和真实失败结论，不包含 Key 或原始上游响应。
- 生产设置页已实际核对：原模型/地址、已保存流式方式和具体错误均正确显示，其余能力保持尚未验证。浏览器回执为 `test-results/model-fix-ui-inspect.json`。
- 完整浏览器回归与截图证据见 [ACCEPTANCE.md](ACCEPTANCE.md)。

回归测试均使用隔离资料和本机模拟服务；真实请求只发送固定连接测试文字，没有发送用户记录或照片。当前服务没有返回可靠生成用量，不推算 Token 或费用。

## 参考资料与边界

- [OpenAI Responses 迁移指南](https://developers.openai.com/api/docs/guides/migrate-to-responses)
- [OpenAI Function calling](https://developers.openai.com/api/docs/guides/function-calling)
- [DeepSeek Harness 的 SSE 终止处理](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/llm/llm-deepseek/src/sse.ts)
- [DeepSeek Harness 的显式协议兼容配置](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/llm/llm-pi-ai/README.zh.md)
- [AnyRouter 公开公告和 Codex 使用方式](https://anyrouter.top/)
- [AnyRouter 使用文档](https://docs.anyrouter.top/)

已阅读参考项目在 `c291e7961a515f6d7af9304e7fd1d257929aef26` 的实现，没有运行第三方代码或引入其整套 Agent 工具。参考其协议边界、结束标记和显式兼容配置原则；没有证据支持靠通用参数开关解决本次网关拒绝，因此没有增加任意请求头、自动换协议或静默删除参数的重试。

标准协议适配不等于支持每个服务的额外扩展，例如 DeepSeek thinking 的 `reasoning_content` 工具往返尚未纳入当前 Chat 适配契约。每套真实服务仍须分别验证能力。
