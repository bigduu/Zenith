# Session Summary 显示整场 Session Token 总量：可行性分析

## 结论

**可以做，而且建议做。**

但要分成两种“token”概念：

1. **当前上下文 token**：当前 session summary / session list 已经能拿到，来自 `SessionSummary.token_usage`。
2. **整场 session 累计 token**：**当前 SessionSummary 里没有现成字段**，但后端已有稳定的 **metrics/session_detail** 聚合链路，可以拿到完整累计值，并且**不受 compact 影响**。

## 当前前端现状

### Session Summary 组件
- 文件：`lotus/src/pages/ChatPage/components/SessionSummaryCard/index.tsx`
- 现在只统计：
  - message 数
  - user/assistant turn 数
  - tool call 数
  - tool error 数
  - file changes
  - compression 次数
  - duration
- **没有 token 总量展示**。

### 前端 store 已有的 token 字段
- 文件：`lotus/src/pages/ChatPage/store/slices/chatSessionSlice.ts`
- `SessionSummary.token_usage` 会映射到 `chat.config.tokenUsage`
- 这个字段来自后端 session list 的 `token_usage`

### 这个 token_usage 的语义
- 文件：`lotus/src/pages/ChatPage/types/tokenBudget.ts`
- 包含：
  - `systemTokens`
  - `summaryTokens`
  - `windowTokens`
  - `totalTokens`
  - `budgetLimit`
- 语义是：**当前 prompt/context 准备后的 token 使用情况**，不是整场 session 的历史累计总量。

## 后端现状

### Session list / SessionSummary 已暴露 token_usage
- 文件：`bamboo/crates/bamboo-server/src/handlers/agent/sessions/types.rs`
- `SessionSummary` 里有：
  - `token_usage: Option<TokenBudgetUsage>`

### session index 会持久化这个 token_usage
- 文件：`bamboo/crates/bamboo-infrastructure/src/storage/v2.rs`
- `SessionIndexEntry` 中有：
  - `token_usage: Option<TokenBudgetUsage>`
- `save_session` -> `upsert_index_from_session` 时会把 `session.token_usage` 写入 index

### 但这个 token_usage 不是“完整累计 token”
原因：
- `TokenBudgetUsage` 是上下文预算/窗口视角数据，字段是：
  - `system_tokens`
  - `summary_tokens`
  - `window_tokens`
  - `total_tokens`
- 这更像“本轮请求时上下文塞了多少 token”，不是“整个 session 到目前为止累计消耗了多少 prompt/completion token”。

## compact 会不会影响完整累计 token

### 如果依赖 SessionSummary.token_usage
**会有语义偏差。**
因为 compact 后：
- 旧消息会被摘要化 / 压缩
- 当前上下文窗口 token 会下降或变化
- `token_usage.total_tokens` 反映的是**当前上下文占用**，不是整个 session 历史累计消耗

### 如果依赖 Metrics session_detail
**不会受 compact 影响。**
原因：
- 文件：`bamboo/crates/bamboo-engine/src/metrics/types.rs`
- `SessionMetrics` 中已有：
  - `total_token_usage: TokenUsage`
- 含义明确：
  - `prompt_tokens`
  - `completion_tokens`
  - `total_tokens`
- 注释写明：`Total token usage across all rounds`

### metrics API 已暴露 session 级累计 token
- 后端：`GET /metrics/sessions/{session_id}`
  - 文件：`bamboo/crates/bamboo-server/src/handlers/agent/metrics/core_handlers/chat.rs`
- 前端已有 service：
  - `lotus/src/services/metrics/MetricsService.ts`
  - `metricsService.getSessionDetail(sessionId)`
- 前端类型：
  - `lotus/src/services/metrics/types.ts`
  - `SessionMetrics.total_token_usage.total_tokens`

## 推荐实现路径

### 推荐方案（最正确）
在 `SessionSummaryCard` 中显示：

- **累计 Token**：来自 `metricsService.getSessionDetail(sessionId)` -> `session.total_token_usage.total_tokens`
- 可选 tooltip：显示
  - prompt tokens
  - completion tokens
  - tool calls
  - rounds

#### 优点
- **即使 compact，也能统计完整 token**
- 语义准确
- 后端已存在，不需要改 bamboo 核心持久化模型

#### 成本
- 需要在 `SessionSummaryCard` 增加一次按 sessionId 的异步加载
- 最好加缓存，避免 inspector 展开时重复请求

### 次优方案（最小改动但不满足你的核心要求）
直接展示当前 store 里的 `chat.config.tokenUsage.totalTokens`

#### 问题
- 这是“当前上下文 token”
- **不等于整场 session 累计 token**
- compact 后更不准确

### 更进一步方案（如果想更高性能）
后端把 `metrics.total_token_usage` 冗余进 `SessionSummary` / `SessionIndexEntry`，例如新增：
- `lifetime_token_usage`
- 或 `cumulative_token_usage`

#### 优点
- session list / inspector 无需额外请求
- 打开 session summary 即可直接显示

#### 缺点
- 需要改后端持久化和同步逻辑
- 要保证 metrics 与 session index 一致性
- 改动面比直接复用 metrics API 大

## 数字格式化建议（K / M / B）
当前 token 格式化函数：
- 文件：`lotus/src/pages/ChatPage/types/tokenBudget.ts`
- `formatTokenCount(count)` 目前只是 `toLocaleString()`

建议新增一个更适合 summary 的 compact formatter，例如：

```ts
export function formatCompactTokenCount(value: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: value >= 100 ? 0 : 1,
  }).format(value);
}
```

### 展示建议
- 主显示：`1.2M tokens`
- tooltip / hover：`1,245,332 total tokens`

### 注意点
- `Intl.NumberFormat({ notation: "compact" })` 在不同 locale 下可能显示：
  - `1.2M`
  - `120万`
- 如果你想**强制英文风格 M/B**，就不要依赖 locale 默认值，需要自定义 formatter。

## 最小前端实现建议

1. 在 `SessionSummaryCard` 中新增累计 token 行
2. 通过 `metricsService.getSessionDetail(sessionId)` 拉取 session metrics
3. 缓存到组件级或 store 级（推荐）
4. 显示：
   - collapsed：一个 token 图标 + `1.2M`
   - expanded：`Total tokens 1.2M`
   - tooltip：`Prompt 820k / Completion 425k / Total 1.245M`
5. 数字用 compact formatter

## 建议优先级

### 方案 A（推荐立即做）
- 前端复用现有 metrics API
- 在 `SessionSummaryCard` 显示累计 token
- 使用 compact formatter

### 方案 B（后续优化）
- 把累计 token 冗余回 session summary/list 接口，减少额外请求

## 最终判断

**答案是：能做。**

而且如果你的要求是：
> “即使 compact 了也要算完整 token”

那么**正确实现方式应该走 `metrics/sessions/{session_id}` 的 `total_token_usage.total_tokens`**，而不是直接用当前 `SessionSummary.token_usage.total_tokens`。
