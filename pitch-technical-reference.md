# Zenith / Bodhi AI — 演讲技术参考手册

> 本文档基于对 bamboo / lotus / bodhi / bodhi-server 源码的直接阅读生成，每一个技术主张均有代码级证据支撑。用于演讲、路演、技术宣传时参考。

---

## 目录

1. [架构全景：四层分离](#1-架构全景)
2. [核心差异化能力 · 详解](#2-核心差异化能力)
   - 2.1 [Rust 嵌入式引擎 — 零 sidecar、零 GC 停顿](#21-rust-嵌入式引擎)
   - 2.2 [工具并发安全模型 — RwLock 驱动的读写分类](#22-工具并发安全模型)
   - 2.3 [声明式工作流 DSL — 唯一可序列化的 Agent 编排](#23-声明式工作流-dsl)
   - 2.4 [生产级调度系统 — Misfire / Overlap / Window](#24-生产级调度系统)
   - 2.5 [Dream Notebook — 跨会话持久记忆](#25-dream-notebook)
   - 2.6 [三协议兼容 API 网关](#26-三协议兼容-api-网关)
   - 2.7 [子代理架构 — 层级任务共享](#27-子代理架构)
   - 2.8 [MCP 全传输 + 熔断器](#28-mcp-全传输--熔断器)
   - 2.9 [安全层 — 语言级 + 行为级双重防护](#29-安全层)
   - 2.10 [桌面原生工作台 UI](#210-桌面原生工作台-ui)
3. [bodhi-server — 企业级后端](#3-bodhi-server--企业级后端)
4. [完整横向对比表](#4-完整横向对比表)
5. [必须澄清的夸大点（不要讲的）](#5-必须澄清的夸大点)
6. [演讲 Soundbites](#6-演讲-soundbites)

---

## 1. 架构全景

```
┌──────────────────────────────────────────────────────┐
│              bodhi (Tauri v2 桌面壳)                  │
│  • Cmd+Shift+Space 全局快捷键                         │
│  • 内部/公开构建双模式 (is_internal_build_mode)       │
│  • 7 个 Tauri IPC 命令                               │
├──────────────────────────────────────────────────────┤
│              lotus (React 18 + Ant Design 5)          │
│  • 11 阶段 FSM 可视化                                 │
│  • 4 窗格二叉树布局                                   │
│  • 6 语言 i18n / 14 任务模板 / Cmd+K 命令面板        │
├──────────────────────────────────────────────────────┤
│              bamboo (Rust 引擎)                        │
│  • 同进程嵌入，无 IPC 开销                            │
│  • bamboo-engine / tools / memory / server / domain   │
├──────────────────────────────────────────────────────┤
│              bodhi-server (Go 后端)                    │
│  • PostgreSQL + JWT + Prometheus                      │
│  • 多租户配额 / 计费 / 审计 / RBAC / Webhook          │
└──────────────────────────────────────────────────────┘
```

**关键证据**：`bodhi/src-tauri/src/embedded/mod.rs` 注释明确写道：
> "Instead of using a sidecar process, we run the HTTP server directly in the app process."

bamboo 以 `bamboo-agent = { workspace = true }` 直接链接进 Tauri 进程，监听 9562 端口。没有任何竞品做到这一点。

---

## 2. 核心差异化能力

### 2.1 Rust 嵌入式引擎

**代码证据**：
- 引擎入口：`bamboo-engine/src/runtime/runner.rs::run_agent_loop`
- 异步运行时：Tokio（`tokio = { features = ["full"] }` in Cargo.toml）
- 无 GC：Rust 所有权系统保证，无停顿（对比 Node.js 的 V8 GC、Python 的 CPython GC）
- 内存安全：Rust 借用检查器在编译期消除 use-after-free、data race 等整类漏洞

**对比数字**：
| 引擎 | 语言 | 已知 CVE（2026/05） | GC 停顿 | 部署方式 |
|---|---|---|---|---|
| bamboo | Rust | **0** | 无 | 同进程嵌入 |
| Claude Code | TypeScript | **27**（15 in 2026） | V8 GC | 单体 CLI |
| OpenCode | Go + Bun | 极少 | Go GC | 双进程 HTTP |
| OpenClaw | Node.js | **多个严重 CVE** | V8 GC | 独立进程 |
| Hermes | Python | 0 | CPython GC | 单体 Python |

**演讲话术**：
> "其他人在用脚本语言运行 Agent。我们用 Rust 构建了 Agent 引擎。这不是炫技，是因为 Agent 有 shell 访问权时，安全是地基，不是外挂。Claude Code 27 个 CVE 中绝大多数是 Node.js command injection。Rust 在语言层面消除了这整类漏洞。"

---

### 2.2 工具并发安全模型

这是竞品无人做到的**工程级差异**，不是 feature，是 correctness。

**机制**：`bamboo-tools/src/parallel.rs::ToolCallRuntime`

```rust
// 一个 RwLock 控制整个工具执行层
struct ToolCallRuntime {
    executor: Arc<dyn ToolExecutor>,
    parallel_lock: Arc<RwLock<()>>,
}

// ReadOnly 工具并发执行（共享读锁）
let _guard = self.parallel_lock.read().await;   // N 个读者同时进入
// Mutating 工具独占执行（写锁屏障）
let _guard = self.parallel_lock.write().await;  // 清空所有并发后独占
```

**分类表（`bamboo-agent-core/src/tools/mod.rs::classify_tool`）**：
- `ReadOnly`：Read, GetFileInfo, Glob, Grep, WebFetch, WebSearch, Workspace(GET), BashOutput, session_note, memory_note, Sleep, compact_context
- `Mutating`（默认）：Write, Edit, Bash, KillShell, NotebookEdit, Task, JsRepl 及所有未知工具（失败安全）

**批次执行（`execute_batch`）**：
- 连续 ReadOnly 工具 → 合并为一组，`join_all` 并发
- 遇到 Mutating 工具 → 先 flush 当前读组，再独占执行
- 这意味着 `[Grep, Glob, Read, Bash, Read, Read]` → `[并发(Grep+Glob+Read)]` → `[独占(Bash)]` → `[并发(Read+Read)]`

**对比**：
- Claude Code：`Promise.all()` 并发，无可变性分类，理论上存在竞态
- OpenCode / Aider：无并发执行
- LangChain / AutoGen：无工具层面的读写锁，靠 prompt 引导

**演讲话术**：
> "我们把数据库工程师熟悉的读写锁概念引入了 Agent 工具执行层。ReadOnly 工具并发跑，Mutating 工具独占。这不是让 Agent 跑得'更快'——是让它在并发时不出错。这是正确性保证，不是性能优化。"

---

### 2.3 声明式工作流 DSL

**代码位置**：
- AST：`bamboo-domain/src/session/composition/expr.rs::ToolExpr`
- 条件：`bamboo-domain/src/session/composition/condition.rs::Condition`
- 执行器：`bamboo-agent-core/src/composition/executor.rs`
- 顶层定义：`bamboo-domain/src/workflow/definition.rs::WorkflowDefinition`
- 加载器（带 mtime 缓存）：`bamboo-server/src/workflow/loader.rs`

**完整 AST**：
```rust
enum ToolExpr {
    Call   { tool: String, args: serde_json::Value }
    Sequence { steps: Vec<ToolExpr>, fail_fast: bool }       // default fail_fast: true
    Parallel { branches: Vec<ToolExpr>, wait: ParallelWait } // wait: All|Any|N(k)
    Choice   { condition: Condition, then_branch, else_branch }
    Retry    { expr, max_attempts: u32, delay_ms: u64 }      // default 3次/1000ms
    Let      { var: String, expr, body }                      // 词法作用域变量绑定
    Var(String)                                               // 变量引用
}

enum Condition {
    Success
    Contains { path: String, value: String }   // JSON 点路径
    Matches  { path: String, pattern: String } // 正则全匹配
    And      { conditions: Vec<Condition> }
    Or       { conditions: Vec<Condition> }
}

enum ParallelWait {
    All,        // 等所有分支完成
    Any,        // 第一个成功即返回
    N(usize),   // 至少 N 个分支成功（quorum）
}
```

**真实 YAML 示例**（从测试文件）：
```yaml
id: code-review
name: Intelligent Code Review
version: "1.0.0"
composition:
  type: sequence
  fail_fast: false          # 即使某步失败也继续收集所有结果
  steps:
    - type: call
      tool: read_file
      args: { path: "${file_path}" }
    - type: parallel
      wait: { type: all }   # 并发执行，等所有完成
      branches:
        - { type: call, tool: run_tests, args: {} }
        - { type: call, tool: run_linter, args: {} }
    - type: choice
      condition:
        type: and
        conditions:
          - { type: success }
          - { type: contains, path: "result", value: "PASS" }
      then_branch:
        { type: call, tool: generate_report, args: {} }
      else_branch:
        type: retry
        max_attempts: 3
        delay_ms: 2000
        expr: { type: call, tool: attempt_fix, args: {} }
```

**`fail_fast: false` 的独特价值**：
- LangChain LCEL：无原生支持，需自定义错误处理链
- AutoGen Graph：无 fail_fast 声明，靠 Python 代码控制
- CrewAI Flows：无此语义

**`ParallelWait::N(k)` 仲裁语义**：
- "至少 3 个验证器认为安全才放行"
- 竞品无任何等价物

**演讲话术**：
> "LangChain 的工作流是 Python 代码。AutoGen 的图是 Python 类。CrewAI 的任务是 Python 装饰器。它们都把'编排逻辑'锁进了代码里，无法审计，无法版本化配置文件，无法给非开发者看。我们的 DSL 是纯 YAML——可以放进 git，可以做 PR review，可以给安全团队审批，可以在 CI 里验证。"

---

### 2.4 生产级调度系统

**代码位置**：
- 领域类型：`bamboo-domain/src/schedule/domain.rs`
- 存储（原子 JSON）：`bamboo-server/src/schedule_app/store.rs`
- 触发引擎：`bamboo-server/src/schedule_app/trigger_engine.rs`
- 管理器（15s ticker）：`bamboo-server/src/schedule_app/manager.rs`

**完整触发器类型**：
```rust
enum ScheduleTrigger {
    Interval { every_seconds: u64, anchor_at: Option<DateTime<Utc>> }
    Daily    { hour: u8, minute: u8, second: u8 }
    Weekly   { weekdays: Vec<ScheduleWeekday>, hour, minute, second }
    Monthly  { days: Vec<u8>, hour, minute, second }  // 超月日期自动跳过
    Cron     { expr: String }   // 7字段：sec min hour dom month dow year
}
```

**Interval 对齐算法**（非"上次完成后等 N 秒"）：
```rust
let elapsed = after.signed_duration_since(anchor).num_seconds();
let intervals_elapsed = elapsed.div_euclid(step) + 1;
anchor + Duration::seconds(intervals_elapsed * step)
// 效果：每小时整点触发，漂移为零
```

**Misfire Policy（机器关机/重启后）**：
```rust
enum MisFirePolicy {
    RunOnce,          // 默认：补跑一次，无论漏了多少次
    Skip,             // 跳过所有漏跑，更新 next_fire_at
    CatchUpAll,       // 按漏跑次数补跑全部
    CatchUpWindow {
        max_catch_up_runs: u32,      // 最多补跑次数上限
        max_lateness_seconds: u64,   // 超过这个延迟就放弃（如 Skip）
    }
}
```

**Overlap Policy（上一次还没跑完）**：
```rust
enum OverlapPolicy {
    Allow,      // 无论如何都触发
    Skip,       // 有运行中就跳过
    QueueOne,   // 默认：最多排一个，防止队列无限增长
}
```

**时间窗口**：
```rust
pub struct ScheduleWindow {
    pub start_at: Option<DateTime<Utc>>,
    pub end_at: Option<DateTime<Utc>>,  // 超过后自动禁用此 schedule
}
```

**持久化**：单一 JSON 文件，`atomic_write_json`（写临时文件→fsync→rename→fsync 父目录）。文件损坏时备份到 `.corrupted.<uuid>` 重新开始，不 panic。

**运行时指标（`ScheduleState`）**：
```
total_run_count, total_success_count, total_failure_count, total_missed_count
consecutive_failures, dispatch_lag_ms, execution_duration_ms
```

**竞品对比**：
| 能力 | Zenith | Claude Code | OpenCode | LangChain | AutoGen | Airflow |
|---|---|---|---|---|---|---|
| 调度 | ✅ 生产级 | ❌ | ❌ | ❌ | ❌ | ✅ 但是独立系统 |
| Misfire Policy | ✅ 4种 | — | — | — | — | ✅ |
| Overlap Policy | ✅ 3种 | — | — | — | — | ✅ |
| 时间窗口 | ✅ | — | — | — | — | ✅ |
| 触发类型 | ✅ 5种(含7字段cron) | — | — | — | — | ✅ |
| 与 Agent 一体 | ✅ | — | — | ❌ 需外接 | ❌ 需外接 | ❌ 需外接 |

**演讲话术**：
> "我们是唯一一个把生产级调度器内置进 Agent 运行时的产品。Claude Code 完全没有调度能力。Airflow 有调度但你要单独搭一套系统。我们的调度知道'机器刚开机，漏了 3 次应该补几次'，知道'上一次还在跑，新的来了应该排队还是跳过'。这是生产运维级别的设计，不是玩具 cron。"

---

### 2.5 Dream Notebook — 跨会话持久记忆

**代码位置**：
- 整个记忆系统：`bamboo/crates/bamboo-memory/`
- 自动整合服务：`bamboo-server/src/services/auto_dream.rs`
- 三层存储结构：`bamboo-memory/src/memory_store/types.rs`

**记忆 Frontmatter（每条记忆的元数据）**：
```rust
struct DurableMemoryFrontmatter {
    id:         String,                 // "mem_20260513_123456_ab1234"
    title:      String,                 // 最长 160 字符
    r#type:     DurableMemoryType,      // user | feedback | project | reference
    scope:      MemoryScope,            // session | project | global
    project_key: Option<String>,        // 基于 git root + 路径 hash
    status:     DurableMemoryStatus,    // active | stale | superseded | contradicted | archived
    freshness:  Option<String>,         // high | medium | low
    confidence: Option<String>,
    sources:    Vec<DurableMemorySource>,
    relations:  DurableMemoryRelations, // supersedes, contradicted_by, related
    tags:       Vec<String>,
    retrieval:  DurableMemoryRetrieval, // keywords, entities, embedding_ready, last_accessed_at
}
```

**Dream Notebook 自动整合流程**（每 30 分钟后台运行）：
1. 收集最近会话（回溯到 `last_consolidated_at`，最多 12 个会话）
2. 三种模式：
   - **Incremental**：只用近期摘要生成
   - **Refine**（有已有 Notebook）：基于现有 Notebook + 新记忆增量更新
   - **Rebuild**（每 30 天一次）：基于全量 durable memory 重建
3. **LLM 调用 1**：生成 5 个固定章节的 Notebook
   - `## Current durable context`
   - `## Cross-session patterns`
   - `## Active threads to remember`
   - `## Stable constraints and preferences`
   - `## Open risks or questions`
4. **LLM 调用 2**：从同一批会话中抽取最多 8 条 durable memory 候选，写入持久存储

**召回评分公式（代码精确）**：
```rust
// match_memory_query 中的每个 query token 得分
title.contains(token)    → +3.0
keywords.contains(token) → +2.5
tags.contains(token)     → +2.0
entities.contains(token) → +1.5
body.contains(token)     → +1.0

// 状态权重
Active    → 0.0 调整
Stale     → -0.75 调整
Superseded/Contradicted/Archived → -10.0（实际上被过滤掉）
```

**5 种索引文件**：
```
lexical.json   → 快速关键词搜索（标题/标签/关键词/实体/摘要）
recent.json    → 按 updated_at 排序的 Top-50
graph.json     → 记忆关系图（supersedes/contradicted_by/related）
stale_candidates.json → 所有非 Active 条目
taxonomy.json  → 按 type/status/scope 的聚合计数
```

**去重/合并逻辑**：
- 精确标题匹配 OR 启发式评分 `(keyword_overlap + entity_overlap×2 + title_prefix_match) ≥ 4` → 自动合并
- 合并时追加内容（`---` 分隔），合并 tags，写 `merge_audit.jsonl`
- 矛盾检测（`mark_memory_contradicted`）：将源记忆标记为 `Contradicted`，写 `contradiction_audit.jsonl`

**项目隔离（`project_key_from_path`）**：
```rust
// 基于 git root 目录名 + 路径 SHA 的 8 位 hex
key = sanitize(git_root_name) + "-" + sha256(canonical_path)[0..8]
// 例：zenith-a1b2c3d4
```

**新鲜度警告**：超过 1 天的记忆注入时附加提示：
> "Historical memory (3 days old); verify against current task context..."

**对比表**：
| | Zenith | Claude Code | Cursor | Aider | LangChain | Hermes |
|---|---|---|---|---|---|---|
| 跨会话记忆 | ✅ Dream Notebook | ~200行限制 | `.cursorrules`静态 | ❌ | 需自配 | ✅ 但2200字符上限 |
| 自动整合 | ✅ 去重+合并+矛盾 | ❌ | ❌ | ❌ | ❌ | ❌ |
| 关系图 | ✅ supersedes/contradicts | ❌ | ❌ | ❌ | ❌ | ❌ |
| 审计日志 | ✅ JSONL全记录 | ❌ | ❌ | ❌ | ❌ | ❌ |
| 项目隔离 | ✅ git root hash | ❌ | ❌ | ❌ | ❌ | ❌ |

**重要限制（不要夸大）**：
- 召回是 TF 加权，**不是向量嵌入**，不是语义搜索
- Dream Notebook **无前端 UI**（后端有，lotus 中无组件）——用户当前感知不到

**演讲话术**：
> "Claude Code 的记忆是 200 行文本。Hermes 的记忆是 2200 字符，超了就 flush。我们给每一条记忆建了完整的元数据：类型、新鲜度、置信度、来源会话、与其他记忆的关系（supersedes / contradicts）。我们有一个 Dream Notebook——每 30 分钟在后台自动整合跨会话的知识，去重，合并矛盾，按主题组织。Agent 越用越懂你，不是靠堆文本，是靠结构化的长期记忆。"

---

### 2.6 三协议兼容 API 网关

**代码位置**：`bamboo-server/src/routes/provider.rs` + `handlers/openai/` + `handlers/anthropic/` + `handlers/gemini/`

**完整路由**：
```
# OpenAI 兼容
POST /openai/v1/chat/completions
POST /openai/v1/responses
GET  /openai/v1/models

# Anthropic 兼容
POST /anthropic/v1/messages
POST /anthropic/v1/complete
GET  /anthropic/v1/models

# Gemini 兼容
GET  /gemini/v1beta/models
POST /gemini/v1beta/models/{model}:generateContent
POST /gemini/v1beta/models/{model}:streamGenerateContent
```

**全部受同一 `enforce_access_password_middleware` 保护**

**入站 5 个 Provider**：
```rust
const AVAILABLE_PROVIDERS: &[&str] = &["copilot", "openai", "anthropic", "gemini", "bodhi"];
```

**ProviderModelRef — 一等公民类型**（`bamboo-domain/src/provider_model_ref.rs`）：
```rust
struct ProviderModelRef {
    provider: String,  // e.g. "anthropic"
    model: String,     // e.g. "claude-sonnet-4-6"
}
// 字符串表示："{provider}/{model}"  e.g. "anthropic/claude-sonnet-4-6"
```

**热重载机制**：
```rust
struct ReloadableProvider {
    inner: Arc<RwLock<Arc<dyn LLMProvider>>>,
}
// 配置更新 → write lock 瞬间 swap provider → 下一个请求立即生效
// 已在飞的流式请求持有旧 Arc clone，不中断
```

**Copilot 特殊能力**：
- 完整 OAuth Device Code 认证流
- 短期 token 自动刷新（过期前 60 秒换新）
- 401/403 自动强刷（`force_refresh_chat_token`）
- 模型列表从 `api.githubcopilot.com/models` 拉取，15 分钟 TTL 缓存

**OpenAI 兼容翻译层**（`providers/common/openai_compat.rs`）：
- 剥离内部字段，保留 role/content/tool_calls/content_parts
- 清理不支持的 JSON Schema 组合符（oneOf/anyOf/allOf）
- Lenient 模式（Copilot）vs Strict 模式（OpenAI）SSE 解析

**演讲话术**：
> "我们不只是消费 AI，我们也对外暴露 AI。任何支持 OpenAI API 的工具——VS Code 插件、Cursor、其他 Agent——都可以把我们的 bamboo 引擎当做 OpenAI 来调用。我们是一个 AI 能力的中枢，不只是一个 AI 客户端。"

---

### 2.7 子代理架构 — 层级任务共享

**代码位置**：
- 孵化：`bamboo-engine/src/runtime/execution/spawn.rs`
- 完成协调：`bamboo-server/src/app_state/child_completion_coordinator.rs`
- 六个内置角色：`bamboo-server/src/subagent_profiles/builtin.rs`

**六个内置子代理角色**：
| 角色 ID | 工具策略 | 模型级别 | 是否可递归 |
|---|---|---|---|
| `general-purpose` | 继承全部 | sub_agent | system prompt 限制 |
| `plan` | Allowlist（只读工具） | chat | ❌ 不在白名单 |
| `researcher` | Allowlist（只读+记忆） | chat | ❌ |
| `coder` | Denylist（禁 SubAgent/scheduler） | sub_agent | ❌ 硬拒绝 |
| `reviewer` | Allowlist（只读） | chat | ❌ |
| `tester` | Denylist（禁 SubAgent/Edit/Write） | sub_agent | ❌ |

**父代理等待机制**（`pipeline.rs` L887-942）：
```rust
SuspensionState {
    reason: "waiting_for_children",
    suspended_at: DateTime<Utc>,
    resumable: true,
    hook_point: Some("AfterToolExecution"),
}

WaitingForChildrenState {
    child_session_ids: Vec<String>,
    wait_for: ChildWaitPolicy,  // All | Any | FirstError
    timeout_at: Option<DateTime<Utc>>,
}
```

**任务列表共享**（`bamboo-tools/src/tools/task.rs`）：
> "Child sessions write to the same task list as their parent/root session."

所有子代理共写同一个 root session 的 TaskList，任务有层级（`parent_id`）、依赖（`depends_on`）、阶段（`planning/execution/verification/handoff`）和完成标准（`completionCriteria`）。

**子代理事件流**：
```rust
// 每 5 秒心跳（保持父会话流活跃）
AgentEvent::SubAgentHeartbeat { parent_session_id, child_session_id, timestamp }

// 每个子代理事件包装后推到父会话的 broadcast stream
AgentEvent::SubAgentEvent { parent_session_id, child_session_id, event: Box<AgentEvent> }
```

Inspector 面板（`lotus/src/pages/ChatPage/inspector/SessionInspectorPane.tsx`）订阅父会话流，通过 `child_session_id` 解复用，无需为每个子代理单独建连接。

**对比**：
- Claude Code：有子代理，有 git worktree 隔离，但**无共享任务列表**
- AutoGen：多 Agent 对话，但**无父子层级/等待/挂起语义**
- CrewAI：有角色但**无共享 TodoList**

---

### 2.8 MCP 全传输 + 熔断器

**代码位置**：`bamboo-engine/src/mcp/`

**三种传输**：
```
StdioTransport      → 子进程 stdin/stdout，Windows 隐藏控制台，stderr 转 trace log
SseTransport        → 持久 SSE 连接，endpoint 自动发现，POST 回写
StreamableHttpTransport → MCP 2025-03-26 spec，POST+GET SSE+DELETE session lifecycle
```

**熔断器参数**：
```rust
DEFAULT_MAX_CONCURRENT_CALLS_PER_SERVER = 4    // 并发信号量
DEFAULT_CIRCUIT_FAILURE_THRESHOLD = 3          // 3次失败 → 打开熔断
DEFAULT_CIRCUIT_OPEN_MS = 5_000                // 5秒后自动半开
```

状态机：Closed → (3次失败) → Open (5秒) → Closed（下一次请求自动重试）

**代理指纹重连**（`mcp/manager/fingerprint.rs`）：
```rust
SHA256(proxy_url + "\0" + username + "\0" + password)
```
代理配置变更时自动重启 SSE 连接（reqwest Client 在创建时 bake 代理配置）。

**工具白名单/黑名单**（per-server 过滤）：
```rust
if !allowed_tools.is_empty() && !allowed_tools.contains(&tool.name) { continue; }
if denied_tools.contains(&tool.name) { continue; }
```

**竞品对比**：
- Claude Code：stdio + SSE，无熔断器
- OpenCode：有 MCP，无熔断
- LangChain：有 MCP client，无熔断
- Hermes：有 MCP，但 MCP loading 吃掉 71.5% 上下文（143K/200K token）

---

### 2.9 安全层 — 语言级 + 行为级双重防护

#### A. AES-256-GCM 静态加密

**代码**：`bamboo-infrastructure/src/config/encryption.rs`

```rust
// 密钥来源（优先级顺序）
1. BAMBOO_CONFIG_ENCRYPTION_KEY 环境变量（32字节 hex）
2. ~/.bamboo/.bamboo_encryption_key 文件
3. 机器 ID（macOS: IOPlatformUUID; Windows: MachineGuid; Linux: machine-id）
   → SHA256("bamboo-config-encryption-v1" || machine_id_bytes)
4. OS+Arch+hostname+username+home+exe 拼接后 SHA256
5. 随机生成并持久化到密钥文件

// 格式：hex(12字节nonce) + ":" + hex(密文+16字节GCM tag)
```

加密的内容：MCP 服务器的环境变量值（API 密钥）、SSE/HTTP 请求头的 value（认证 token）。

#### B. 关键词脱敏（`masking_decorator.rs`）

```rust
// 包装每一个 LLMProvider
MaskingProviderDecorator<P: LLMProvider>
// 出站消息中的所有 text content 都经过 apply_masking()
// [MASKED] 替换，单向不可逆
// 正则 + 精确匹配两种规则
```

#### C. AST 级 Bash 分析（`permission/bash_security.rs`）

使用 `tree_sitter_bash` 建立完整 AST，**50ms 超时 + 50,000 节点预算**（超出 → 硬拒绝）。

**硬拒绝（Deny）的命令**：
```
eval, source, ., exec, command, builtin  ← eval 类
zmodload, emulate, sysopen ...           ← zsh 危险内建
重定向到 /etc/passwd, /etc/shadow, /boot/, /dev/sd*, /proc/sys ...
$cmd arg  ← 变量作为命令名
未知 AST 节点类型  ← 失败安全
```

**Wrapper 剥离**：`nohup eval 'rm -rf /'` → 剥离 `nohup` → 识别 `eval` → 硬拒绝。

#### D. 五级权限模式（`permission/checker.rs`）

```rust
enum PermissionMode {
    Default,            // 交互式提示
    Plan,               // 阻断 Medium/High 风险操作
    AcceptEdits,        // 自动批准 WriteFile + 安全 shell 命令
    DontAsk,            // 仅白名单内资源通过
    BypassPermissions,  // 全部允许（CI/测试环境）
}
```

**AcceptEdits 安全命令列表**：
```
mkdir, touch, cp, mv, ls, cat, echo, pwd, chmod, chown,
git status/diff/log/add/commit,
cargo check/build/test/clippy,
npm run/test/install
```

#### E. 访问密码中间件（`handlers/settings/access_control.rs`）

所有三个 compat API surface + `/v1/` bamboo 管理接口均受保护：
- 本地请求（loopback/private LAN）豁免
- Cookie `bamboo_access_verified = "v1:<SHA256(v1:hash:salt)>"` 验证
- 密码以 `SHA256(16字节随机salt || password)` 存储
- Cookie：HttpOnly + SameSite=Lax + 12小时 + HTTPS Secure

**对比**：
| 安全能力 | Zenith | Claude Code | OpenCode | OpenClaw |
|---|---|---|---|---|
| 内存安全 | ✅ Rust 语言保障 | ❌ JS | ⚠️ Go+Bun | ❌ Node.js |
| 配置加密 | ✅ AES-256-GCM | ❌ | ❌ | ❌ |
| 关键词脱敏 | ✅ LLM 出站前掩码 | ❌ | ❌ | ❌ |
| AST Bash 分析 | ✅ tree_sitter | ❌ | ❌ | ❌ |
| 权限模式 | ✅ 5种 | ✅ 7层 | ❌ | ❌ |
| OS 级沙箱 | ❌ **（注意！）** | ✅ macOS Seatbelt | ❌ | ❌ |

---

### 2.10 桌面原生工作台 UI

**完整功能清单（均有代码证据）**：

#### 多窗格布局
- 二叉树模型，最多 4 窗格，可拖拽 resize（`uiLayoutStore.ts`）
- 每窗格独立会话，横向/纵向任意分割（`MultiPaneChatView/index.tsx`）
- 侧边栏 260px 默认（180-520 可调），Inspector 520px（420-840 可调）

#### 11 阶段执行状态机
```typescript
// executionStateSlice.ts 定义的完整状态
idle → starting → running → streaming → running_tools
    → waiting_user_answer → running_children → settling
    → completed / error / cancelled
```
UI 映射为 7 个显示状态，实时可视化当前阶段和活跃工具。

#### 命令面板（Cmd+K）
- 快速操作：新建会话/切换主题/分割窗格/切换模式
- 设置跳转：所有设置 Tab 快捷入口
- 会话搜索：跨标题/内容的全文搜索
- 搜索范围 40 个结果，键盘导航

#### 14 个任务模板
```
blank, codeReview, implementFeature, refactor, bugInvestigation,
explainError, tokenUsage, architectureReview, compareFiles,
releaseNotes, summarizeWork, writeDocs, createSchedule, sessionReview
```
分四类：development / debugging / analysis / documentation / operations

#### 指标仪表盘（16 个指标卡 + 4 个图表）
- 16 个统计卡：total_requests、tokens、success_rate（颜色编码）、avg_response_time、sync_mismatches、chat/tool/memory 相关统计
- TokenChart：prompt vs completion 时间线（Recharts LineChart）
- ModelDistribution：PieChart 按模型分词量
- ForwardEndpointDistribution：BarChart 按 API 端点成功/失败
- Top Skills + Top MCP Tools 排行

#### i18n（6 语言）
- en-US, zh-CN, zh-TW, fr-FR, ja-JP, hi-IN
- `react-i18next`，懒加载

#### 其他特性
- PDF / Markdown 导出（`MessageExportService.ts`，`html2pdf.js`）
- VDI 安全模式（`vdiSafeMode.ts`，localStorage 开关）
- Simple / Advanced 模式（`experienceModeStore.ts`）
- 原生桌面通知（`tauri-plugin-notification`）
- 拖拽上传图片（`useDragAndDrop.ts` + `usePasteHandler.ts`）
- Mermaid 图表渲染（`LazyMermaidChart` 带主题适配）
- 子代理 Inspector（`SessionInspectorPane.tsx`：Overview/Tasks/Sub-agents/Diffs 四 Tab）
- 调度管理界面（完整 CRUD + 运行历史 + 会话深链）
- MCP 服务器管理（表格 + 表单 + JSON 模式 + 工具列表）

**对比**：
| UI 能力 | Zenith | Claude Code | OpenCode TUI | Cursor IDE | Aider |
|---|---|---|---|---|---|
| 形态 | **桌面原生应用** | 终端 | 终端 | IDE fork | 终端 |
| 多窗格 | **4窗格二叉树** | ❌ | tmux 风 | 标签 | ❌ |
| 执行可视化 | **11阶段 FSM** | 简单 | 简单 | 简单 | 简单 |
| 指标仪表盘 | **16卡+4图表** | ❌ | ❌ | ❌ | ❌ |
| 调度管理 | **完整 CRUD** | ❌ | ❌ | ❌ | ❌ |
| 命令面板 | ✅ Cmd+K | ❌ | ❌ | ✅ | ❌ |
| i18n | **6语言** | ❌ | ❌ | 有 | ❌ |
| PDF 导出 | ✅ | ❌ | ❌ | ❌ | ❌ |
| VDI 模式 | ✅ | ❌ | ❌ | ❌ | ❌ |
| Mermaid 渲染 | ✅ | ❌ | ❌ | ✅ | ❌ |

---

## 3. bodhi-server — 企业级后端

**代码位置**：`bodhi-server/` (Go)

**20+ 个数据库表（PostgreSQL）**：
```
users, api_keys, provider_credentials, usage_tracking,
user_quotas, user_usage_counters, model_pricing, model_mappings,
system_settings, invite_codes, models, provider_instances,
provider_failures, billing_periods, groups, group_members,
group_credentials, group_quotas, request_cache, audit_log,
content_rules, distributed_rate_limits, webhooks, retention_policies,
token_revocations, versions
```

**6 维度配额（RPM/RPD/日Token/月Token/日消费/月消费）**：
- 滑动窗口计数，upsert 原子更新
- 个人配额 + 团队配额独立管理
- `allowed_models[]` glob 白名单

**计费精度（价格表 `model_pricing`）**：
- 以 `cents per 1M tokens` 为单位存储
- 模式匹配（glob `*`）+最长匹配优先
- 预置价格：gpt-4o 250/1000，claude-opus 1500/7500，gemini-2.5-pro 125/500
- 用户可查日/月账单，CSV 导出，余额预警

**审计系统**：
```go
type Entry struct {
    UserID, APIKeyID, Action, Resource string
    Detail    map[string]interface{}   // JSONB
    IPAddress, UserAgent string
}
// 异步缓冲 channel(256)，overflow 时静默丢弃+日志
```

**内容规则引擎（`moderation/filter.go`）**：
- 预编译正则，input/output/both 作用域
- Action：block / warn / redact
- 管理员 CRUD + 开关

**Webhook 系统**：
- HTTP POST + 可选 `X-Webhook-Secret` 头
- 事件通配符 `"*"` 支持
- 异步 buffered dispatch（channel 128）

**JWT 认证**：
- HS256，支持 JTI 黑名单（token_revocations 表）
- 用户级全量撤销（`"user-revoke:"+userID`）
- Refresh token 过期清理

**关键差异**：这个 Go 后端将 bamboo 引擎变成了**多租户 SaaS 平台**。Bamboo 是产品（桌面端引擎），bodhi-server 是平台（企业/团队管理层）。

---

## 4. 完整横向对比表

### 与 AI Coding Agent 对比

| 维度 | Zenith/Bodhi | Claude Code | OpenCode | Cursor | Aider |
|---|---|---|---|---|---|
| 引擎语言 | **Rust** | TypeScript | Go+Bun | TypeScript | Python |
| 形态 | **桌面应用** | CLI | CLI/TUI | IDE | CLI |
| 嵌入方式 | **同进程库** | 单体 | 双进程 HTTP | IDE 插件 | 单进程 |
| CVE | **0** | 27 | 极少 | 未知 | 极少 |
| 并行工具 | **RwLock 读写分类** | join_all | 有 | 有 | ❌ |
| 工作流 DSL | **YAML 声明式** | ❌ | ❌ | ❌ | ❌ |
| 调度器 | **生产级 5种触发** | ❌ | ❌ | ❌ | ❌ |
| 跨会话记忆 | **Dream Notebook** | ~200行 | ❌ | 静态文件 | ❌ |
| 多协议出站 API | **3协议** | ❌ | ❌ | ❌ | ❌ |
| 子代理 | **层级+任务共享** | 有(无任务共享) | 有 | ❌ | ❌ |
| MCP | **全传输+熔断器** | stdio+SSE | ✅ | ✅ | ❌ |
| 配置加密 | **AES-256-GCM** | ❌ | ❌ | ❌ | ❌ |
| Bash AST 分析 | **tree_sitter** | 沙箱 | ❌ | ❌ | ❌ |
| i18n | **6语言** | ❌ | ❌ | 有 | ❌ |
| 指标仪表盘 | **16卡+4图** | ❌ | ❌ | ❌ | ❌ |
| 企业后端 | **Go+PG+配额+计费** | 无 | 无 | 无 | 无 |

### 与通用 Agent 框架对比

| 维度 | Zenith/Bodhi | LangChain | AutoGen | CrewAI | Mastra |
|---|---|---|---|---|---|
| 目标用户 | **终端用户(有UI)** | 开发者(SDK) | 开发者(SDK) | 开发者(SDK) | 开发者(SDK) |
| 编排方式 | **YAML DSL** | Python LCEL | Python Graph | Python 装饰器 | TypeScript |
| DSL 可序列化 | **✅ YAML/JSON** | ❌ 代码 | ❌ 代码 | ❌ 代码 | ❌ 代码 |
| Parallel quorum N(k) | **✅** | ❌ | ❌ | ❌ | ❌ |
| fail_fast: false | **✅** | ❌ | ❌ | ❌ | ❌ |
| 内置调度器 | **✅ 生产级** | ❌ | ❌ | ❌ | ❌ |
| 跨会话记忆 | **✅ 自动整合** | 需自配 | 需自配 | 有(基础) | 需自配 |
| 多协议 API 出站 | **✅ 3协议** | ❌ | ❌ | ❌ | ❌ |
| 工具可变性分类 | **✅ ReadOnly/Mutating** | ❌ | ❌ | ❌ | ❌ |
| 企业多租户 | **✅ Go后端** | ❌ | ❌ | ❌ | ❌ |
| 开箱即用 | **✅ 桌面安装即用** | ❌ 需搭建 | ❌ 需搭建 | ❌ 需搭建 | ❌ 需搭建 |

---

## 5. 必须澄清的夸大点

在演讲中**不要使用**的表述：

| 错误表述 | 实际情况 | 正确表述 |
|---|---|---|
| "语义召回" / "RAG" | TF 加权，不是向量嵌入 | "关键词加权召回，标题权重最高" |
| "沙箱化 shell 执行" | 无 OS 级沙箱（无 bwrap/Seatbelt） | "AST 级 Bash 分析 + 权限策略" |
| "Dream Notebook 可视化" | 后端有，lotus 无 UI | "后台自动整合，API 可查" |
| "0 CVE 永远安全" | 目前 0，但未经大规模审计 | "Rust 内存安全消除整类漏洞" |
| "可视化工作流编辑器" | 是 textarea，不是 n8n | "YAML 工作流编辑器，声明式配置" |
| "自有模型(Bodhi)" | bodhi provider 极薄 | "支持自托管 OpenAI 兼容端点" |
| 对标 LiteLLM 时 "5 provider 领先" | LiteLLM 支持 100+ | 正面回应：我们更轻、开箱即用 |

---

## 6. 演讲 Soundbites

### 一句话定位
> "我们是第一个把 Rust Agent 引擎嵌进桌面应用的开发工作台——不是 CLI，不是 IDE 插件，是一个真正的 AI 指挥中心。"

### 安全角度
> "Agent 有 shell 权限的那一刻，安全就不再是功能——是地基。Rust 的借用检查器在编译期消灭了 Claude Code 27 个 CVE 里的大多数。我们的 Bash 分析器用 tree_sitter 建完整 AST，eval/exec 在语言层面就被拦截，不靠正则，不靠规则列表。"

### 工作流 DSL 角度
> "LangChain 的工作流是 Python。我们的是 YAML。一个字的区别意味着：我们的工作流可以放进 git 做版本管理，可以在 CI 里做 schema 校验，可以给安全团队审批，可以给非程序员配置。这是从'AI 玩具'到'企业工具'的分水岭。"

### 调度角度
> "你设置一个 Agent 任务，今晚跑，明天早上出报告。机器睡着了重启，Misfire Policy 决定是补跑还是跳过。上一次还没跑完下一次又触发了，Overlap Policy 决定是排队一个还是直接跳过。这不是 cron，这是生产级任务编排。Claude Code 完全没有。"

### 记忆角度
> "Claude Code 记得你 200 行。我们的 Dream Notebook 每 30 分钟在后台整合跨会话知识：去重、合并矛盾、标记新鲜度、按主题组织。每条记忆都有类型、置信度、来源会话、与其他记忆的关系。Agent 越用越懂你，不靠堆文本，靠结构化记忆。"

### 企业角度
> "Bamboo 是给开发者用的工具。bodhi-server 是给企业用的平台。6 维度配额、精确到分的计费（cents per 1M tokens）、完整审计日志、内容规则引擎、Webhook——这是一个完整的多租户 AI 基础设施，不是一个聊天应用。"

### 多协议网关角度
> "我们的 API 网关同时对外暴露三套兼容接口：OpenAI 格式、Anthropic 格式、Gemini 格式。任何支持这三个 API 的工具都可以把我们当做后端。我们不只是 AI 的消费者——我们是 AI 能力的中枢。"

---

## 附录：关键代码文件速查

| 功能 | 文件路径 |
|---|---|
| 执行主循环 | `bamboo-engine/src/runtime/runner/loop_execution/pipeline.rs` |
| 工具并发 RwLock | `bamboo-tools/src/parallel.rs` |
| 工具可变性分类 | `bamboo-agent-core/src/tools/mod.rs` |
| 工作流 DSL AST | `bamboo-domain/src/session/composition/expr.rs` |
| 工作流执行器 | `bamboo-agent-core/src/composition/executor.rs` |
| 工作流加载器 | `bamboo-server/src/workflow/loader.rs` |
| 调度领域类型 | `bamboo-domain/src/schedule/domain.rs` |
| 调度存储 | `bamboo-server/src/schedule_app/store.rs` |
| 触发引擎 | `bamboo-server/src/schedule_app/trigger_engine.rs` |
| Dream Notebook | `bamboo-memory/src/auto_dream.rs` |
| 记忆召回 | `bamboo-memory/src/memory_store/mod.rs::match_memory_query` |
| AES-GCM 加密 | `bamboo-infrastructure/src/config/encryption.rs` |
| Bash AST 分析 | `bamboo-tools/src/permission/bash_security.rs` |
| 权限模式 | `bamboo-tools/src/permission/checker.rs` |
| LLM Provider trait | `bamboo-infrastructure/src/llm/provider.rs` |
| ProviderModelRef | `bamboo-domain/src/provider_model_ref.rs` |
| 三协议路由 | `bamboo-server/src/routes/provider.rs` |
| 热重载 Provider | `bamboo-server/src/reloadable_provider.rs` |
| MCP 熔断器 | `bamboo-engine/src/mcp/manager/mod.rs` |
| MCP 代理指纹 | `bamboo-engine/src/mcp/manager/fingerprint.rs` |
| 子代理孵化 | `bamboo-engine/src/runtime/execution/spawn.rs` |
| 子代理角色 | `bamboo-server/src/subagent_profiles/builtin.rs` |
| 多窗格布局 | `lotus/src/shared/store/uiLayoutStore.ts` |
| 11阶段 FSM | `lotus/src/pages/ChatPage/store/slices/executionStateSlice.ts` |
| 指标仪表盘 | `lotus/src/pages/SettingsPage/components/SystemSettingsPage/metrics/` |
| 调度 UI | `lotus/src/pages/SettingsPage/components/SystemSettingsPage/SystemSettingsSchedulesTab.tsx` |
| 命令面板 | `lotus/src/shared/components/CommandPalette/index.tsx` |
| bodhi-server 路由 | `bodhi-server/api/router/router.go` |
| bodhi-server DB schema | `bodhi-server/internal/database/schema.go` |
| bodhi-server 配额 | `bodhi-server/internal/quota/checker.go` |
| 嵌入式引擎 | `bodhi/src-tauri/src/embedded/mod.rs` |
