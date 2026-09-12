# 模型配置补修与真实服务诊断

日期：2026-09-12。此轮处理 75% 节点后的配置故障，不推进未来信等最终节点功能。

## 实际结论

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
