# SubagentProfile 详细设计

> Status: Draft v1
> Owner: Zenith core
> Goal: 让 root session 能给子会话指定**真正的角色**(prompt + 工具白名单 + 模型 + 默认职责),为 PM/Researcher/Coder/Tester 等多 Agent 团队协作打底。

---

## 1. 背景

当前 `subagent_type` 只是字符串标签,运行时除了 `plan` 之外不影响任何行为:

- `child_session.rs:388-398` 只对 `plan` 返回 `PLAN_AGENT_SYSTEM_PROMPT`,其他全部 fallback 到 `CHILD_SYSTEM_PROMPT`。
- `server_tools/surface.rs:60-65` `ToolSurface::Child` 与 `Base` 返回同一个 executor,**没有按角色过滤工具**。
- 模型路由(`config.rs:364-368` `subagent_models`)是唯一已经按 type 生效的字段。

结果:`researcher` 与 `coder` 的子会话拿到完全一样的提示词与完全一样的工具集。

---

## 2. 目标 / 非目标

### Goals
1. 一份配置定义所有内置角色(system_prompt + 工具白名单 + 模型偏好 + 默认 responsibility 提示)。
2. 用户可以通过配置文件追加/覆盖角色,无需改代码即可新增 `reviewer`、`tester` 等。
3. 创建子会话时按角色注入 system_prompt,并裁剪 ToolSurface。
4. 前端可以列出"可用角色"并展示已分配角色的 Tag/职责。
5. 完全向后兼容:未指定/未知 `subagent_type` 走 `general-purpose` 默认 profile,行为与现状等价。

### Non-Goals(留给后续 PR)
- 子↔子直接通信、handoff 调度、worktree 隔离、看板 UI(列入中长期路线)。
- 角色级 memory 命名空间(可在 v2 加)。

---

## 3. 数据模型

### 3.1 Rust 类型

```rust
// crates/bamboo-domain/src/subagent/mod.rs (新建)

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubagentProfile {
    /// 角色 id,等于 subagent_type 的字符串值,如 "researcher"
    pub id: String,
    /// UI 展示名,如 "Researcher"
    pub display_name: String,
    /// 简短描述(给 UI 与 LLM 看的用途)
    pub description: String,
    /// 角色专属 system prompt
    pub system_prompt: String,
    /// 工具策略
    pub tools: ToolPolicy,
    /// 模型偏好(可选,优先级低于 Config.subagent_models)
    #[serde(default)]
    pub model_hint: Option<ModelHint>,
    /// 默认填充到 responsibility 的占位文本(用户未填时使用)
    #[serde(default)]
    pub default_responsibility: Option<String>,
    /// 该角色启动后默认折叠/隐藏的 UI 偏好(可选)
    #[serde(default)]
    pub ui: UiHint,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum ToolPolicy {
    /// 沿用 ToolSurface::Child 全集(等同当前行为)
    Inherit,
    /// 仅允许列表内的工具
    Allowlist { allow: Vec<String> },
    /// 在 Child 全集基础上禁掉部分工具
    Denylist { deny: Vec<String> },
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModelHint {
    /// 速档:fast / chat / sub_session
    #[serde(default)]
    pub tier: Option<String>,
    /// 显式 provider+model(覆盖 tier)
    #[serde(default)]
    pub model_ref: Option<String>, // "provider:model"
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UiHint {
    #[serde(default)]
    pub icon: Option<String>,    // emoji 或图标名
    #[serde(default)]
    pub color: Option<String>,   // tag 颜色
}

/// 注册表:封装内置 + 用户配置,提供按 id 查询
#[derive(Debug, Clone, Default)]
pub struct SubagentProfileRegistry {
    map: HashMap<String, SubagentProfile>,
    fallback_id: String, // "general-purpose"
}
```

### 3.2 配置加载

优先级(后者覆盖前者):
1. **内置 profiles**:在 `bamboo-server` 启动时由 `SubagentProfileRegistry::builtin()` 注入(见 §4 内置清单)。
2. **用户全局**:`~/.bamboo/subagent_profiles.json`
3. **项目级**:`<workspace>/.bamboo/subagent_profiles.json`(若存在)
4. **环境变量临时覆盖**:`BAMBOO_SUBAGENT_PROFILES_FILE=...` 指向额外 JSON。

合并规则:同 id 整体替换(不做字段级 merge,避免半残)。

### 3.3 文件示例

```json
{
  "profiles": [
    {
      "id": "reviewer",
      "display_name": "Code Reviewer",
      "description": "审查另一个 agent 的代码改动并给出 inline 评语",
      "system_prompt": "You are a strict code reviewer ...",
      "tools": { "mode": "allowlist", "allow": ["Read", "Grep", "Glob", "GetFileInfo", "WebFetch"] },
      "model_hint": { "tier": "chat" },
      "default_responsibility": "Review the diff produced by the upstream coder subagent",
      "ui": { "icon": "🔍", "color": "purple" }
    }
  ]
}
```

---

## 4. 内置角色清单(v1)

| id | display | tools | model tier | 备注 |
|----|---------|-------|------------|------|
| `general-purpose` | General | Inherit | sub_session | **fallback**,等同当前 `CHILD_SYSTEM_PROMPT` |
| `plan` | Planner | Allowlist(Read/Glob/Grep/GetFileInfo/WebFetch/WebSearch/MemoryNote) | chat | 沿用 `PLAN_AGENT_SYSTEM_PROMPT` |
| `researcher` | Researcher | Allowlist(只读 + WebFetch/WebSearch + memory) | chat | 调研专家 |
| `coder` | Coder | Denylist(SubSession, scheduler) | sub_session | 可写文件、跑命令,但不能再 spawn |
| `reviewer` | Reviewer | Allowlist(只读 + memory) | chat | 给 coder 产出做 review |
| `tester` | Tester | Denylist(SubSession, scheduler, Edit, Write) | sub_session | 可跑测试,不主动改代码 |

> 内置 prompts 抽到 `crates/bamboo-server/src/session_app/subagent_prompts.rs`,以常量字符串定义。

---

## 5. 运行时改造点(代码级 diff 概要)

### 5.1 `child_session.rs:388-398` —— 注入 prompt

```rust
// 改为:
let registry = port.subagent_profiles();             // 新增 ChildSessionPort 方法
let profile = registry.resolve(&input.subagent_type); // 未知 → general-purpose

let system_prompt = profile.system_prompt.clone();
child.metadata.insert("subagent_profile_id".into(), profile.id.clone());
child.metadata.insert("base_system_prompt".into(), system_prompt.clone());
child.add_message(Message::system(&system_prompt));
```

并把 `profile.id` 持久化进 metadata,便于前端展示与后续审计。

### 5.2 `server_tools/surface.rs` —— 扩展工具裁剪

新增构造方法:

```rust
impl ToolSurfaceFactory {
    pub fn child_for_profile(&self, profile: &SubagentProfile) -> Arc<dyn ToolExecutor> {
        match &profile.tools {
            ToolPolicy::Inherit => self.base.clone(),
            ToolPolicy::Allowlist { allow } => Arc::new(FilteredExecutor::allow(self.base.clone(), allow.clone())),
            ToolPolicy::Denylist  { deny  } => Arc::new(FilteredExecutor::deny (self.base.clone(),  deny.clone())),
        }
    }
}
```

新建 `FilteredExecutor`(包装 `ToolExecutor`,在 `list_tools()` / `execute()` 入口处过滤),代码量 ~80 行。

调用方:`runtime/execution/spawn.rs:run_spawn_job` 中,把 `tools = factory.get(ToolSurface::Child)` 换为
`tools = factory.child_for_profile(&profile)`,profile 从 child 的 metadata 拿。

### 5.3 模型路由

`model_config_helper::resolve_subagent_model_ref` 增加一层:**先看 profile.model_hint,再 fallback 到 `Config.subagent_models[type]`,再 fallback 到 defaults**。这样用户配置文件就能控制模型,无需改 Rust。

### 5.4 `ChildSessionPort` 扩展

新增一个方法返回 registry 引用:

```rust
fn subagent_profiles(&self) -> &SubagentProfileRegistry;
```

`ChildSessionAdapter` 持有 `Arc<SubagentProfileRegistry>`,从 `AppState` 注入。

### 5.5 工具 schema 暴露 enum

`crates/bamboo-server/src/tools/sub_session.rs:170-173` 的 `subagent_type` 字段在 JSON Schema 里暴露为 `enum` 而非 free string,从 registry 列出可选项;LLM 调用时拿到下拉式提示。

---

## 6. 新 API / 工具 action

复用现有 `SubSession` 工具,新增一个 `list_profiles` action(或独立的 `SubagentProfileService` REST)。

```jsonc
// SubSession.action = "list_profiles"
// 返回:
{
  "profiles": [
    { "id": "researcher", "display_name": "...", "description": "...", "ui": {...} },
    ...
  ]
}
```

前端 toolService 加一层封装,首次进入 ChatPage 时 prefetch。

---

## 7. 前端改造(最小集)

| 文件 | 改动 |
|------|------|
| `src/services/tool/SubagentProfileService.ts`(新) | 调 `SubSession.list_profiles`,缓存到 zustand store |
| `src/pages/ChatPage/components/ChatView/SubSessionsPanel.tsx:16-580` | 列表项右侧加 Tag:`<ProfileTag id={metadata.subagent_profile_id} />`;hover 显示 description |
| `src/components/SubagentProfileTag.tsx`(新) | 根据 profile.ui.icon/color 渲染,unknown → 灰色 fallback |
| (可选)`SubSessionsPanel` header | 显示「可用角色:🔍 Researcher · 💻 Coder · 🧪 Tester …」做发现性提示 |

> v1 不动批量创建/编排 Dialog,角色由 LLM 自己根据 `list_profiles` 选择。

---

## 8. 兼容性

- `subagent_type` 字段语义不变,旧调用不传或传 unknown 值 → 走 `general-purpose` profile,与今天行为完全一致。
- `plan` 角色被收编为 builtin profile,system_prompt 文本保持不变,确保历史会话回放一致。
- 持久化:新增的 `subagent_profile_id` 是 metadata 字段,旧 session 没有此字段时前端按 `subagent_type` 兜底。

---

## 9. 测试计划

### 9.1 单元测试
- `SubagentProfileRegistry::resolve` 未知 id → fallback。
- 配置文件覆盖优先级(builtin < global < project)。
- `FilteredExecutor` allowlist/denylist 各种边界。

### 9.2 集成测试(`bamboo` 现有 integration test 风格)
- 创建 `subagent_type=researcher` 子会话:断言 metadata 含 profile id、system prompt 含 "Researcher"、`Edit/Write` 工具不可见。
- 创建 `subagent_type=unknown_xxx`:断言 fallback 到 general-purpose、tool surface 与 `ToolSurface::Child` 等价。
- 配置文件覆盖测试:写临时 JSON 加一个 `id=tester` profile,启动 server,创建 tester 子会话验证生效。

### 9.3 前端
- vitest:`SubagentProfileTag` snapshot;`SubSessionsPanel` 渲染含 metadata 的 fixture 检查 Tag 出现。

---

## 10. 工作量估算

| 模块 | 子项 | 工时(理想) |
|------|------|-----------|
| 后端 | domain 类型 + registry + 加载器 | 0.5d |
| 后端 | builtin profiles + prompts | 0.5d |
| 后端 | child_session.rs / spawn.rs / surface.rs 接线 | 1d |
| 后端 | FilteredExecutor + 测试 | 1d |
| 后端 | list_profiles action | 0.25d |
| 前端 | service + Tag 组件 + Panel 接入 | 0.5d |
| 测试 | 单元 + 集成 | 0.75d |
| 文档 / PR | review 修改 | 0.5d |
| **合计** | | **~5 人日** |

---

## 11. 落地步骤(一次 PR 的拆分)

1. **PR-1(bamboo)**:domain 类型 + registry + builtin profiles + 配置加载。**纯新增,无行为变化**。
2. **PR-2(bamboo)**:`FilteredExecutor` + `child_for_profile` 工厂方法,加单测。
3. **PR-3(bamboo)**:`child_session.rs` / `spawn.rs` 接线 + 集成测试。**此 PR 上线即生效**。
4. **PR-4(bamboo)**:新增 `SubSession.action=list_profiles`。
5. **PR-5(lotus)**:`SubagentProfileService` + `SubagentProfileTag` + Panel 集成。
6. **PR-6(zenith)**:更新 root pointer + 在 README/AGENTS.md 加角色使用说明。

每个 PR 独立可测,出问题可单独 revert。

---

## 12. 风险与回退

- **风险**:工具白名单太严导致 LLM 卡住 → 在 dev/debug 模式下可通过环境变量 `BAMBOO_SUBAGENT_TOOLS_PERMISSIVE=1` 临时退化为 Inherit。
- **风险**:新增 `subagent_profile_id` 字段被前端误用 → 前端用 `metadata?.subagent_profile_id ?? metadata.subagent_type` 兜底。
- **回退**:仅 revert PR-3 即可恢复旧行为(PR-1/2/4 都是新增不影响默认路径)。

---

## 13. v2 展望(超出本设计范围)

- 角色级 memory 命名空间(`memory:role/<id>/...`)。
- Profile 描述里嵌入 `handoff_to: ["reviewer"]`,实现自动交接。
- Profile 驱动的并行调度策略(researcher 可多开,coder 同 module 限 1)。
- 与 GitHub Projects "Zenith Roadmap" 的 `agent:*` 标签联动,自动按 issue 类型选 profile。
