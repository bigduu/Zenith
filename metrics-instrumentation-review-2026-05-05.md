# Metrics / Telemetry Review

Date: 2026-05-05
Project: Zenith / Bamboo / Lotus
Reviewer: Bodhi

## Executive Summary

当前 metrics 展示层整体没有大问题，**主要问题确实在数据源与采集口径**，而且很像是多轮重构后留下的“语义漂移 + 生命周期不闭环 + 部分埋点未持久化”。

### 结论

1. **暂时不建议把当前产品 metrics 直接整体迁移到 OpenTelemetry。**
   - 现在的核心问题不是“缺少标准协议”，而是：
     - 会话/forward 生命周期没有稳定闭环
     - SQLite 数据存在历史脏数据和未修复的 `running` / incomplete 记录
     - 某些字段语义已经和 UI 文案不一致
     - 某些新加字段只定义了类型和前端展示，但没有落库
   - 如果现在直接上 OTel，很可能只是把**错误语义和脏数据标准化输出**，并不能解决“数据源不可信”的根因。

2. **应该把 metrics 分成两层：**
   - **产品/业务指标（product metrics）**：会话、round、tool、forward、memory、压缩、pending question 等——继续保留自定义 domain schema。
   - **运行/基础设施可观测性（observability）**：请求耗时、错误率、队列积压、落库失败、崩溃恢复、trace/span——这部分可以选择性引入 OTel。

3. **短期优先级应放在修复数据源可信度，而不是先换标准。**
   - 先把 session/round/forward 的完成状态、崩溃恢复、压缩指标持久化、字段命名统一做好。
   - 等 domain metrics 稳定后，再考虑为“运行链路”引入 OpenTelemetry。

---

## Scope Reviewed

### Backend / storage / API
- `bamboo/crates/bamboo-engine/src/metrics/collector.rs`
- `bamboo/crates/bamboo-engine/src/metrics/storage.rs`
- `bamboo/crates/bamboo-engine/src/metrics/types.rs`
- `bamboo/crates/bamboo-engine/src/runtime/runner/metrics_lifecycle/session_metrics.rs`
- `bamboo/crates/bamboo-engine/src/runtime/runner/metrics_lifecycle/round_metrics.rs`
- `bamboo/crates/bamboo-engine/src/runtime/runner/loop_execution/pipeline.rs`
- `bamboo/crates/bamboo-engine/src/runtime/runner/round_lifecycle/context_preparation.rs`
- `bamboo/crates/bamboo-server/src/metrics_service.rs`
- `bamboo/crates/bamboo-server/src/handlers/agent/metrics/unified_handlers.rs`
- `bamboo/crates/bamboo-server/src/handlers/openai/**`
- `bamboo/crates/bamboo-server/src/handlers/anthropic/**`
- `bamboo/crates/bamboo-server/src/handlers/gemini/**`
- `bamboo/crates/bamboo-server/src/app_state/init.rs`

### Frontend / dashboard
- `lotus/src/services/metrics/MetricsService.ts`
- `lotus/src/pages/SettingsPage/components/SystemSettingsPage/hooks/useUnifiedMetrics.ts`
- `lotus/src/pages/SettingsPage/components/SystemSettingsPage/UnifiedMetricsDashboard.tsx`
- `lotus/src/pages/SettingsPage/components/SystemSettingsPage/metrics/UnifiedMetricsCards.tsx`
- `lotus/src/pages/SettingsPage/components/SystemSettingsPage/metrics/SessionTable.tsx`
- `lotus/src/pages/SettingsPage/components/SystemSettingsPage/metrics/ForwardRequestTable.tsx`

### Live data inspected
- SQLite DB: `/Users/bigduu/.bamboo/metrics.db`
- DB is initialized at: `bamboo/crates/bamboo-server/src/app_state/init.rs:176-185`

---

## Current Data Flow

### Chat/session metrics
1. Runtime emits lifecycle events:
   - session start: `bamboo/crates/bamboo-engine/src/runtime/runner/metrics_lifecycle/session_metrics.rs:5-18`
   - session cancel: `.../session_metrics.rs:20-34`
   - session complete-if-resolved: `.../session_metrics.rs:36-54`
   - round start/complete/error: `bamboo/crates/bamboo-engine/src/runtime/runner/metrics_lifecycle/round_metrics.rs:8-72`
2. Collector receives commands asynchronously and writes SQLite:
   - `bamboo/crates/bamboo-engine/src/metrics/collector.rs:90-255`
3. SQLite aggregates session fields from round/tool tables:
   - `bamboo/crates/bamboo-engine/src/metrics/storage.rs:2079-2126`
4. REST API reads storage:
   - `bamboo/crates/bamboo-server/src/metrics_service.rs:33-128`
5. Lotus dashboard consumes `/metrics/*` and `/metrics/v2/*`:
   - `lotus/src/services/metrics/MetricsService.ts:41-175`
   - `lotus/src/pages/SettingsPage/components/SystemSettingsPage/hooks/useUnifiedMetrics.ts:97-172`

### Forward/proxy metrics
1. Provider handlers call `forward_started(...)` and `forward_completed(...)`:
   - OpenAI examples:
     - `bamboo/crates/bamboo-server/src/handlers/openai/chat/non_stream.rs:36-40`
     - `.../openai/chat/non_stream.rs:105-109`
     - `.../openai/chat/stream/mod.rs:40-44`
     - `.../openai/chat/stream/worker.rs:64-90`
   - Anthropic examples:
     - `bamboo/crates/bamboo-server/src/handlers/anthropic/messages/non_stream.rs:26-30`
     - `.../anthropic/messages/non_stream.rs:142-146`
     - `.../anthropic/messages/stream.rs:31-35`
     - `.../anthropic/messages/stream.rs:134-138`
   - Gemini examples:
     - `bamboo/crates/bamboo-server/src/handlers/gemini/generate/mod.rs:65-69`
     - `.../gemini/generate/mod.rs:114-118`
     - `.../gemini/stream/handler.rs:58-62`
     - `.../gemini/stream/runtime.rs:74-78`
2. Collector persists `forward_request_metrics`:
   - start: `bamboo/crates/bamboo-engine/src/metrics/storage.rs:1162-1194`
   - complete: `.../storage.rs:1196-1245`
3. API aggregates forward summary / endpoint / request details:
   - summary: `.../storage.rs:1247-1293`
   - by endpoint: `.../storage.rs:1295-1346`
   - requests: `.../storage.rs:1348-1411`

### Unified dashboard
- Unified API composition:
  - `bamboo/crates/bamboo-server/src/handlers/agent/metrics/unified_handlers.rs:16-86`
- Frontend cards/tables:
  - `lotus/src/pages/SettingsPage/components/SystemSettingsPage/metrics/UnifiedMetricsCards.tsx:79-299`
  - `.../SessionTable.tsx:61-157`
  - `.../ForwardRequestTable.tsx:35-167`

---

## Live Database Findings

Source: `/Users/bigduu/.bamboo/metrics.db`

### Raw counts
- `session_metrics`: **515**
- `round_metrics`: **10,924**
- `forward_request_metrics`: **2,257**
- `execute_sync_mismatch_metrics`: **25 rows**, total mismatch count **85**

### Session status distribution
- `completed`: **332**
- `error`: **73**
- `running`: **64**
- `cancelled`: **46**

### Forward status distribution
- `success`: **1,961**
- `error`: **176**
- `NULL status`: **120**

### High-signal anomalies
- `running` sessions: **64 / 515 = 12.43%**
- `running` sessions older than 1 day: **63 / 515 = 12.23%**
- `running` rounds: **13 / 10,924 = 0.12%**
- `running` rounds older than 1 day: **12 / 10,924 = 0.11%**
- incomplete forward rows (`completed_at IS NULL OR status IS NULL`): **120 / 2,257 = 5.32%**
- incomplete forward rows older than 1 day: **105 / 2,257 = 4.65%**

### Historical stale data exists
Examples from live DB:
- oldest incomplete forward rows start as early as **2026-03-08**
- oldest `running` round starts as early as **2026-03-04**
- oldest `running` session starts as early as **2026-02-19**

This strongly indicates **there is no reliable startup/backfill/reconciliation step to repair stale metrics state after crashes or interrupted runs**.

---

## Main Problems Found

## 1. Lifecycle closure is incomplete, so historical `running` and incomplete rows pollute the source

### Evidence
- session completion is conditional on `!has_pending_question`:
  - `bamboo/crates/bamboo-engine/src/runtime/runner/metrics_lifecycle/session_metrics.rs:46-53`
- `record_session_completed_if_resolved(...)` intentionally leaves session as `running` when there is a pending question:
  - `.../session_metrics.rs:36-54`
- live DB still contains many very old `running` sessions/rounds.

### Why this is a problem
“pending question / waiting for next user input” is a **product session state**, but it is currently overloading the **metrics execution state**. For the dashboard, this means:
- many historical sessions look active forever
- `active_sessions` is inflated
- “success” / “completion” rates become ambiguous
- long-lived conversational state and execution-lifecycle state are conflated

### Recommendation
Split these concepts:
- execution status: `running | completed | error | cancelled`
- conversational waiting state: `awaiting_user | awaiting_children | idle | closed`

If a round is done and the agent is waiting for the next user message, the **execution should be closed**, not left as active forever in metrics.

---

## 2. No visible reconciliation / stale-state repair on startup

### Evidence
- metrics DB is only initialized here:
  - `bamboo/crates/bamboo-server/src/app_state/init.rs:176-185`
- collector only initializes storage and schedules prune:
  - `bamboo/crates/bamboo-engine/src/metrics/collector.rs:90-255`
- no concrete startup repair logic was found that converts stale `running` rows to terminal states.

### Why this is a problem
Any crash, kill, upgrade, or mid-stream termination can leave:
- `session_metrics.status = 'running'`
- `round_metrics.status = 'running'`
- `forward_request_metrics.completed_at IS NULL / status IS NULL`

Without repair, the dashboard is reading **ever-accumulating historical ghosts**.

### Recommendation
Add a startup reconciliation step, e.g.:
- mark `session_metrics.status='running'` and `updated_at < now - grace_period` as `abandoned` or `interrupted`
- mark stale `round_metrics.status='running'` similarly
- mark stale forward rows as `interrupted` / `aborted`
- optionally store a `reconciled_at` timestamp and reason

This is probably the single highest-leverage fix for source quality.

---

## 3. Compression metrics are defined and surfaced, but not actually persisted

### Evidence
- round/session types declare compression fields:
  - `bamboo/crates/bamboo-engine/src/metrics/types.rs:128-136`
  - `.../types.rs:164-172`
- collector receives `ContextCompressed` events:
  - `bamboo/crates/bamboo-engine/src/metrics/collector.rs:186-204`
- but the handler is explicitly **no-op storage for now**:
  - `.../collector.rs:200-203`
- storage query results hardcode these fields to zero:
  - session list: `bamboo/crates/bamboo-engine/src/metrics/storage.rs:1641-1643`
  - session detail: `.../storage.rs:1716-1718`
  - round detail: `.../storage.rs:2218-2220`

### Why this is a problem
The product believes it has compression-related metrics, but the persisted source cannot answer:
- how many compression events occurred
- how many tokens were saved
- which sessions/rounds benefited

This is a classic “schema/interface moved ahead of storage” refactor gap.

### Recommendation
Add durable compression storage before relying on these fields in dashboard/product decisions.

Options:
1. add compression columns to `round_metrics` and aggregate to `session_metrics`
2. or add a dedicated `context_compression_metrics` table keyed by round/session/time

Until then, do not present compression metrics as if they were trustworthy persisted analytics.

---

## 4. `prompt_cached_tool_outputs` has semantic drift between backend meaning and frontend label

### Evidence
- backend field definition:
  - `bamboo/crates/bamboo-engine/src/metrics/types.rs:128-130`
  - comment: **"Number of tool outputs compacted into prompt-side cache summaries in this round."**
- source value comes from runtime token usage:
  - `bamboo/crates/bamboo-engine/src/runtime/runner/loop_execution/pipeline.rs:189-194`
  - `.../pipeline.rs:286-291`
- frontend label shows it as:
  - `lotus/src/pages/SettingsPage/components/SystemSettingsPage/metrics/UnifiedMetricsCards.tsx:192-199`
  - label text: **"Prompt Cache Compactions"**

### Why this is a problem
These are not necessarily the same thing:
- backend meaning: **count of tool outputs summarized/cached into prompt-side representation**
- frontend label implies: **count of compaction operations/events**

One compaction event may affect multiple tool outputs. The live DB also shows this metric is sparse:
- non-zero sessions: **12 / 515 = 2.33%**
- non-zero rounds: **108 / 10,924 = 0.99%**

So the card is likely both semantically ambiguous and easy to misread.

### Recommendation
Rename one side so both match.

Preferred options:
- backend/domain name: `cached_tool_output_count`
- UI label: `Cached Tool Outputs` or `Tool Outputs Compactly Cached`

If you want “compaction events”, instrument that separately.

---

## 5. Unified success rate formula is misleading

### Evidence
Unified summary computes:
- `total_success = (chat.total_sessions - chat.active_sessions) + forward.successful_requests`
- `success_rate = total_success / total_requests`
- source: `bamboo/crates/bamboo-server/src/handlers/agent/metrics/unified_handlers.rs:55-77`

Given live DB:
- chat total = 515
- chat running = 64
- chat completed = 332
- chat cancelled = 46
- chat error = 73
- forward total = 2257
- forward success = 1961

Current formula yields:
- `chat.total_sessions - chat.active_sessions = 451`
- this counts **completed + cancelled + error** together as “success-like finished”
- resulting unified rate ≈ **87.01%**

Alternative interpretations:
- completed only: ≈ **82.72%**
- completed + cancelled: ≈ **84.38%**

### Why this is a problem
The current formula treats **all non-running chat sessions as successful for the combined numerator**, which is not semantically correct.

### Recommendation
Define success explicitly.

For example:
- chat success = `status == completed`
- chat terminal non-success = `error | cancelled | interrupted | abandoned`
- active = `running`

Then compute unified rate on actual success semantics.

---

## 6. Incomplete forward rows show source quality gaps even though handler code usually records completion

### Evidence
- completion paths exist across provider handlers:
  - OpenAI / Anthropic / Gemini handlers all call `forward_completed(...)` in success/error paths.
- storage completion implementation exists:
  - `bamboo/crates/bamboo-engine/src/metrics/storage.rs:1196-1245`
- but live DB still has **120 incomplete forward rows**, and **105** are older than 1 day.

### Likely causes
- process interrupted between `forward_started` and `forward_completed`
- stream aborted in a path not fully covered
- abrupt shutdown before async collector drained to SQLite
- historical refactor left old rows unrepaired

### Important nuance
This is **not** evidence that the forward completion call is generally absent today. It is evidence that the metrics system lacks:
- durable completion guarantees
- recovery/reconciliation
- explicit “aborted/interrupted” terminal state

### Recommendation
- add `interrupted` / `aborted` status for forward requests
- reconcile stale incomplete rows on startup
- optionally add bounded drain/flush on shutdown
- add tests for abrupt cancellation during stream handling

---

## 7. There are two metrics ingestion styles in the codebase, which increases refactor risk

### Evidence
- active runtime path uses `MetricsCollector` with direct unbounded command channel:
  - `bamboo/crates/bamboo-engine/src/metrics/collector.rs`
- repository also contains `MetricsBus` + `MetricsWorker` event-based ingestion:
  - `bamboo/crates/bamboo-engine/src/metrics/worker.rs`
  - `bamboo/crates/bamboo-engine/src/metrics/bus.rs`
- current production persistence path is centered on `MetricsCollector::spawn(...)` from `MetricsService::new(...)`:
  - `bamboo/crates/bamboo-server/src/metrics_service.rs:19-26`

### Why this matters
Even if only one path is active in production, retaining another partially overlapping ingestion model makes it easier for refactors to:
- update one path but not the other
- update types but not storage behavior
- create conflicting assumptions about event semantics

### Recommendation
Choose one ingestion architecture as canonical and clearly mark the other as:
- deprecated, or
- experimental / not production wired.

---

## Frontend Assessment

## What looks good
The Lotus dashboard is mostly a clean consumer of API payloads.

### Evidence
- service layer is straightforward and query-based:
  - `lotus/src/services/metrics/MetricsService.ts:41-175`
- unified hook simply loads summary + timeline + details in parallel:
  - `lotus/src/pages/SettingsPage/components/SystemSettingsPage/hooks/useUnifiedMetrics.ts:97-172`
- session and forward tables mostly render API fields directly:
  - `.../SessionTable.tsx:61-157`
  - `.../ForwardRequestTable.tsx:35-167`

### Assessment
The UI is **not the primary problem**. It is surfacing the numbers it is given.

### Caveat
Some labels and combined formulas can mislead users when backend semantics are weak. So the display layer is not broken, but it currently **amplifies source ambiguity**.

---

## OpenTelemetry Review

## What is currently in use?
For the Bamboo/Lotus metrics path reviewed here:
- **No active OpenTelemetry integration was found** in the current Bamboo/Lotus metrics implementation.
- Bamboo mainly uses `tracing` for logs/instrumented logging.
- OTel references found in the repo are in `claude_code/`, not in the Bamboo/Lotus metrics path under review.

### Evidence
- no Bamboo/Lotus metrics implementation files using OTel APIs were found in the reviewed metrics path
- `claude_code/` contains OTel-related code, but that is a separate codepath and not the current metrics dashboard pipeline

## Should we adopt OpenTelemetry now?

### Short answer
**Yes for infra observability later; no as a direct replacement for current product metrics now.**

### Why not as the immediate solution
OpenTelemetry is excellent for:
- traces/spans
- service-to-service latency
- standardized counters/histograms
- exporter ecosystem (OTLP, Prometheus, Tempo, Jaeger, etc.)

But your current dashboard depends on **domain-specific product facts**, such as:
- session status and message counts
- round/tool aggregation
- prompt cached tool outputs
- sync mismatch reasons
- memory/project-specific summaries
- context compression effectiveness

These are **business/domain analytics**, not just generic observability signals.

If you move too early to OTel, you still need:
- a domain schema
- durable storage or export mapping
- reconciliation logic
- status semantics
- accurate event completion

So OTel will not remove the need to fix the current domain model.

### Where OTel *would* help
After source correctness is repaired, OTel is useful for:
1. **Operational traces**
   - request span for `/v1/chat/completions` proxy
   - child spans for provider call, streaming loop, tool execution, SQLite write
2. **Runtime health metrics**
   - collector queue depth
   - storage write failures
   - dropped events
   - stale record reconciliation count
   - stream abort count
3. **Cross-service debugging**
   - if Bamboo / Bodhi / Lotus / server boundaries need distributed traces later

### Recommended stance
- **Keep domain/product metrics in your own schema and DB/API.**
- **Optionally add OTel for infrastructure observability around that pipeline.**

This hybrid approach is the best fit here.

---

## Recommended Remediation Plan

## Phase 1 — Fix source-of-truth semantics first
Priority: Critical

1. **Introduce explicit terminal states for stale/incomplete records**
   - sessions: add `interrupted` / `abandoned`
   - rounds: add `interrupted` / `abandoned`
   - forward requests: add `interrupted` / `aborted`
2. **Add startup reconciliation job**
   - convert stale `running` / incomplete records into terminal repaired states
   - log reconciliation counts
3. **Separate execution-state from conversational waiting-state**
   - pending question should not keep execution metrics forever “running”
4. **Backfill / repair existing `metrics.db`**
   - one-time migration/reconciliation script for historical rows

## Phase 2 — Fix semantic drift
Priority: High

5. **Rename `prompt_cached_tool_outputs` or UI label** so both reflect the same thing
6. **Redefine unified success rate** using actual success semantics
7. **Document all metrics field definitions in one canonical spec**
   - event name
   - source
   - aggregation level
   - UI label
   - exact semantic meaning

## Phase 3 — Finish incomplete instrumentation
Priority: High

8. **Persist compression metrics**
   - `compression_count`
   - `tokens_saved`
   - maybe `compression_trigger_type`
9. **Add tests covering interruption/crash-adjacent behavior**
   - stream aborted before completion
   - cancellation mid-round
   - process restarts with stale rows present
10. **Standardize one ingestion architecture**
   - collector only, or bus/worker only

## Phase 4 — Add OTel selectively
Priority: Medium

11. Introduce OTel only for runtime observability:
   - HTTP handler span
   - provider call span
   - stream loop span
   - tool execution span
   - metrics collector write latency histogram
   - storage write error counter
   - reconciliation counter
12. Export to OTLP/Prometheus if operational value is clear
13. Keep product dashboard backed by your domain tables/API

---

## Suggested Near-Term Engineering Tasks

### Task A — Reconcile stale metrics on startup
Acceptance criteria:
- stale `running` sessions/rounds are repaired on boot
- stale forward rows become terminal `interrupted`/`aborted`
- reconciliation counts are logged and queryable

### Task B — Fix status semantics
Acceptance criteria:
- pending question no longer means metrics execution remains forever `running`
- unified success rate uses explicit success semantics
- dashboard cards/tooltips explain exact meanings

### Task C — Persist compression metrics
Acceptance criteria:
- compression events are stored durably
- session/round/detail APIs return real values
- Lotus cards/tables only show persisted values

### Task D — Normalize metric vocabulary
Acceptance criteria:
- `prompt_cached_tool_outputs` renamed or relabeled consistently
- one metrics dictionary document exists in repo
- backend and frontend tests assert the intended meaning

### Task E — Evaluate optional OTel rollout for infra only
Acceptance criteria:
- prototype spans around forward proxy + tool execution
- no change to product metrics source-of-truth
- exporter is optional and does not gate the dashboard

---

## Bottom Line

你的判断是对的：**现在主要不是展示层问题，而是数据源问题。**

更具体一点说，当前主要症结是：
- metrics 生命周期闭环不稳
- 崩溃/中断后没有 reconciliation
- 部分指标只有类型和 UI，没有真实持久化
- 部分字段语义和展示文案已经漂移
- unified summary 的某些组合口径会误导使用者

### Final recommendation
- **先不要把这件事定义成“要不要上 OpenTelemetry”。**
- 先把 **domain metrics 的语义、完成态、修复机制、持久化完整性** 做对。
- 然后再把 OTel 作为 **infra observability 增强层** 引入，而不是当前产品指标的替代方案。

---

## Key Code References

- DB initialization: `bamboo/crates/bamboo-server/src/app_state/init.rs:176-185`
- Metrics service + collector spawn: `bamboo/crates/bamboo-server/src/metrics_service.rs:19-26`
- Collector async command handling: `bamboo/crates/bamboo-engine/src/metrics/collector.rs:90-255`
- Compression metrics no-op persistence: `bamboo/crates/bamboo-engine/src/metrics/collector.rs:186-204`
- Session completion-if-resolved: `bamboo/crates/bamboo-engine/src/runtime/runner/metrics_lifecycle/session_metrics.rs:36-54`
- Session cancel metrics: `.../session_metrics.rs:20-34`
- Round start/complete/error metrics: `bamboo/crates/bamboo-engine/src/runtime/runner/metrics_lifecycle/round_metrics.rs:8-72`
- Prompt cached tool outputs source: `bamboo/crates/bamboo-engine/src/runtime/runner/loop_execution/pipeline.rs:189-194`, `:286-291`
- Session aggregate refresh: `bamboo/crates/bamboo-engine/src/metrics/storage.rs:2079-2126`
- Forward summary aggregation: `.../storage.rs:1247-1293`
- Forward request detail query: `.../storage.rs:1348-1411`
- Chat summary aggregation: `.../storage.rs:1465-1537`
- Session list hardcoded compression zeros: `.../storage.rs:1625-1644`
- Session detail hardcoded compression zeros: `.../storage.rs:1700-1722`
- Round detail hardcoded compression zeros: `.../storage.rs:2203-2221`
- Unified summary formula: `bamboo/crates/bamboo-server/src/handlers/agent/metrics/unified_handlers.rs:52-77`
- Frontend unified loader: `lotus/src/pages/SettingsPage/components/SystemSettingsPage/hooks/useUnifiedMetrics.ts:97-172`
- Frontend metric cards: `lotus/src/pages/SettingsPage/components/SystemSettingsPage/metrics/UnifiedMetricsCards.tsx:79-299`
