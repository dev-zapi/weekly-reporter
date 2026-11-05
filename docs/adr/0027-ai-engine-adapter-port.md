---
status: accepted
---

# AI 客户端适配层与 NDJSON 生成引擎的 Go 移植

三协议（anthropic / openai responses / openai-compatible）的官方 Go SDK 只作**传输层**，统一 adapter 接口（`stepRequest`/`stepResult`/`runStep`，垂直切片已定型）+ 自建多步 tool-loop 承载全部引擎语义。明确禁用 `openai-go` 的 `BetaToolRunner`（表达不了 `hasToolCall`、消息线程归属与 ADR-0008 冲突）。各 provider 关键钉版：anthropic-sdk-go v2 `NewStreaming`+`Accumulate` 且 `anthropic-version` 钉回 `2023-06-01`（默认 `2026-10-21` 会拒 temperature/top_p/top_k）；openai-go **v3**（`github.com/openai/openai-go/v3`）`Responses.NewStreaming`；compat 路径裸 SSE 直读 reasoning 字段、不移植标记 hack，且**必须继续发 `/chat/completions`、消息历史形状（user instruction 文本 + assistant tool_calls 回放）不变**——e2e scripted-AI 的 marker 协议（base64url 剧本 + 步骤序号 = user 轮数 + 已完成工具步数）依赖此形状；「现有 e2e 套件零改动通过」= 引擎验收标准。

循环与 wire 语义（全部经垂直切片实证）：`stopWhen` 是 OR 且**在工具执行后评估**（无效的 `propose_final_report` 调用也停轮；无工具调用即停；步数上限 6，恰在第 6 次工具执行后停）；UTF-16 计长贯穿全部字符预算（450k 上下文 / 40k 正文 / 280 字 publicSummary / 2k rawResponse / 200k proposal——TS `string.length` 是 UTF-16 单元，Go `len` 是字节，CJK 直接漂移 3 倍，需 `utf16Len`/`sliceUTF16` helper）；tool-input 事件自维护 `item_id → (call_id, name)` 映射（`function_call_arguments.delta` 只带 item_id，漏映射则全部错发 "tool"）；tool-call 完成需 `function_call_arguments.done` / `output_item.done` / `response.completed` 三重兜底加 flushed 标记防双发；续轮只带**增量** output（`previous_response_id` 链下 provider 持状态），不被兼容代理支持时回退完整 output items 回放（实现开关，配置或探测切换）；nil slice 必须显式初始化为 `[]`（序列化成 `null` 会被前端 publicSummary 结构校验静默丢弃）；时间戳 Unix **秒**；wire `createdAt` 固定 `2006-01-02T15:04:05.000Z`（Go 默认 RFC3339Nano 与 `Date.toJSON()` 不一致）；客户端断连 `r.Context().Done() → cancel()` 后照常 DB 收尾（aborted + Stopped + 已收文本强制 flush，无悬挂 working 轮）；500ms 节流落库；轮次序列号 `BEGIN IMMEDIATE` 包 `max(sequence)+1 + insert`；tool `strict` 字段省略（与显式 false 等价）。

## Considered Options

- **SDK 高层 agent 框架（BetaToolRunner）**：停止语义与消息线程模型与本域冲突，无法表达 `hasToolCall`。
- **移植 AI SDK 的标记 hack**：compat 裸 SSE 直读更简单，hack 无对应物。
- **单 provider 收敛**：存量 `ai_config` 三协议并存，对等冻结。

## Consequences

- `internal/aiclient`（三 adapter）与 `internal/engine`（循环 + 事件 + 持久化副作用）两个包。
- `report-list` / `content` 两个查询工具的 Go 版为全量移植（cursor / legacy / previous_adjacent / grep 预算），是引擎的前置依赖，随 B6 批次交付。
- 垂直切片跳过的 audit 表写入在正式实现归位。
- 真实模型端点集成测试为 B6 验收必跑项（本地 ai-subscriptions 代理恢复后补跑）。
- items 回放开关默认关闭，仅 compat 代理需要时开启。
